// Detect the kills that leave no crash log, and report them.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// Staff reports, 2026-08-15: "when I go find a stock photo in Amazon it
// backs me out of BinGo and I have to start over", "it took me 6 times to list
// a steam cleaner". Nobody can say what happened, because from the phone's side
// nothing happened — the app was simply gone.
//
// Everything we already have is blind to this:
//   - lib/crash-reporter.ts hooks ErrorUtils, which only fires for a JS throw.
//     client_crash_reports has ZERO rows across six weeks of these complaints,
//     which is itself the finding: whatever ends the process is not JS.
//   - TestFlight/Xcode crash logs do not exist for an OS memory reclaim
//     (jetsam). The OS considers that a normal eviction, not a crash.
//   - app_feedback needs a human to stop mid-job and type. They text instead.
//
// So the only witness to a silent kill is the NEXT launch. This leaves a mark
// on disk while running and looks for a stale one on boot: a mark that is still
// there means the previous JS context never ran again after it was written —
// the process died rather than exited through any path we control.
//
// ── WHAT MAKES IT A REPORT RATHER THAN NOISE ─────────────────────────────────
// Swiping the app away at the end of a shift leaves the same stale mark as a
// jetsam kill. The discriminator is the gap: a picker whose app dies mid-lot
// relaunches within seconds, so only a relaunch inside RELAUNCH_WINDOW_MS is
// reported. An overnight mark is dropped silently.
//
// The mark carries the things that make the report actionable and that no
// person could tell us afterwards: which route they were on, whether the app
// was foreground or backgrounded (leaving to Amazon is a background kill —
// a different diagnosis from dying while the camera is live), how long they had
// been on that screen, and whether unsaved lot work existed at the time.
//
// ── DELIVERY ─────────────────────────────────────────────────────────────────
// 2026-09-23: each finding goes into the telemetry outbox BEFORE its evidence
// is cleared, and leaves it only once the server accepts it
// (telemetry-outbox.ts). A wifi dead spot delays a report; it no longer loses it.
//
// ── FAILURE POSTURE ──────────────────────────────────────────────────────────
// Every path swallows its errors. This is diagnostics on the lotting hot path:
// it may cost nothing and it may break nothing. A watchdog that can crash the
// app it is watching is worse than no watchdog.

import { AppState, Platform, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { PENDING_CRASH_KEY } from './crash-reporter';
import {
  captureDeviceSnapshot,
  mergeWatchdogDeviceSnapshot,
  readDeviceModelOs,
  type DeviceSnapshot,
} from './device-snapshot';
import { enqueueReports, flushOutbox, sendOutcomeFor, type CrashReportBody, type SendOutcome } from './telemetry-outbox';

const MARK_KEY = 'session:watchdog:v1';
/** Prefix written by features/lotting/useDraftPersistence — presence means work was in flight. */
const DRAFT_KEY_PREFIX = 'lotting:draft:';

/** A relaunch later than this reads as "they came back tomorrow", not "it died on me". */
const RELAUNCH_WINDOW_MS = 20 * 60 * 1000;
/** Heartbeat cadence. Fine-grained enough to date the death, cheap enough to ignore. */
const BEAT_MS = 10_000;

const API_BASE = (
  (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_API_BASE_URL) ||
  'https://bingoauctions.com'
).replace(/\/$/, '');

interface SessionMark {
  screen: string | null;
  /** Foreground or not at the last beat — a background kill and a foreground kill differ. */
  state: AppStateStatus;
  /** When the current screen was entered, for "how far into the lot were they". */
  screenSince: number;
  lastBeat: number;
  bootedAt: number;
  appVersion: string | null;
  otaUpdate: string | null;
  /** Captured on each heartbeat — reflects device at time of death, not next launch. */
  device_model: string | null;
  os_version: string | null;
}

let timer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let sub: { remove: () => void } | null = null;
let current: SessionMark | null = null;
let started = false;

/** A slow first request is normal on warehouse wifi; one later try this session. */
const RETRY_AFTER_MS = 30_000;

/** Called by the router hook on every route change. */
export function noteScreen(screen: string | null): void {
  if (!current) return;
  if (current.screen === screen) return;
  current.screen = screen;
  current.screenSince = Date.now();
  void writeMark();
}

/**
 * Start the watchdog. Safe to call once per JS context; later calls no-op.
 *
 * Reports the previous session's death first (if any), then begins marking
 * this one. Order matters: the read has to happen before this session's mark
 * overwrites the evidence.
 */
export function startSessionWatchdog(): void {
  if (started) return;
  started = true;

  void (async () => {
    // Queue what the evidence says before clearing it; sending comes last and
    // may fail. The mark is overwritten below either way, so it must be queued.
    const found: CrashReportBody[] = [];
    for (const collect of [collectPendingCrash, collectPreviousDeath]) {
      try {
        const body = await collect();
        if (body) found.push(body);
      } catch {
        // A failed post-mortem must not stop the next one, or the watch.
      }
    }
    if (await enqueueReports(AsyncStorage, found, Date.now())) {
      await clearEvidence();
    }
    const now = Date.now();
    const markDevice = readDeviceModelOs();
    current = {
      screen: null,
      state: AppState.currentState,
      screenSince: now,
      lastBeat: now,
      bootedAt: now,
      appVersion: Constants.expoConfig?.version ?? null,
      otaUpdate: Updates.updateId ?? 'embedded',
      device_model: markDevice.device_model,
      os_version: markDevice.os_version,
    };
    await writeMark();

    timer = setInterval(() => {
      if (!current) return;
      current.lastBeat = Date.now();
      current.state = AppState.currentState;
      void writeMark();
    }, BEAT_MS);

    // Beat immediately on a state change too, so the recorded state at death is
    // the real one rather than whatever it was up to ten seconds earlier. The
    // Amazon case depends entirely on this: the kill lands moments after the
    // app backgrounds, which a 10s cadence would frequently record as 'active'.
    sub = AppState.addEventListener('change', (state) => {
      if (!current) return;
      current.state = state;
      current.lastBeat = Date.now();
      void writeMark();
      if (state === 'active') flush();
    });

    flush();
    retryTimer = setTimeout(flush, RETRY_AFTER_MS);
  })();
}

/** Test/teardown hook. Not used in app code — the watchdog lives as long as the process. */
export function stopSessionWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  sub?.remove();
  sub = null;
  current = null;
  started = false;
}

async function writeMark(): Promise<void> {
  if (!current) return;
  const markDevice = readDeviceModelOs();
  current.device_model = markDevice.device_model;
  current.os_version = markDevice.os_version;
  try {
    await AsyncStorage.setItem(MARK_KEY, JSON.stringify(current));
  } catch {
    // Disk pressure or a wedged store. Nothing to do; diagnostics are optional.
  }
}

/** Send whatever is queued; failures stay queued for the next try. */
function flush(): void {
  void flushOutbox(AsyncStorage, post, Date.now());
}

async function readItem(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Only after the outbox holds the reports. A leftover means a duplicate, not a loss. */
async function clearEvidence(): Promise<void> {
  for (const key of [PENDING_CRASH_KEY, MARK_KEY]) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      // See above.
    }
  }
}

/**
 * Look for a mark the previous session never cleared, and turn it into a report.
 *
 * A mark is only cleared on a clean, deliberate teardown — which the OS never
 * gives us — so its survival is the signal. The report is suppressed for stale
 * marks (see RELAUNCH_WINDOW_MS); the mark is cleared once the outbox holds
 * whatever it said, so one death is reported once.
 */
async function collectPreviousDeath(): Promise<CrashReportBody | null> {
  const raw = await readItem(MARK_KEY);
  if (!raw) return null;

  let mark: SessionMark;
  try {
    mark = JSON.parse(raw) as SessionMark;
  } catch {
    return null; // Corrupt mark from a kill mid-write — nothing usable in it.
  }
  if (!mark?.lastBeat) return null;

  const now = Date.now();
  const sinceDeath = now - mark.lastBeat;
  if (sinceDeath < 0 || sinceDeath > RELAUNCH_WINDOW_MS) return null;

  const onScreenMs = Math.max(0, mark.lastBeat - (mark.screenSince ?? mark.lastBeat));
  const hadDraft = await draftPending();

  const screen = mark.screen ?? 'unknown';
  const message =
    `silent exit on ${screen} — process died while ${describeState(mark.state)}, ` +
    `${Math.round(onScreenMs / 1000)}s into the screen, relaunched ${Math.round(sinceDeath / 1000)}s later` +
    `${hadDraft ? ', unsaved lot draft present' : ''}`;

  const atReport = await captureDeviceSnapshot();
  const device = mergeWatchdogDeviceSnapshot(
    {
      device_model: mark.device_model ?? null,
      os_version: mark.os_version ?? null,
    },
    atReport,
  );
  return withDeviceFields(
    {
      message,
      screen,
      app_version: mark.appVersion ?? undefined,
      ota_update: mark.otaUpdate ?? undefined,
      // Not fatal in the JS sense — nothing threw. The distinction is the point:
      // it keeps these separable from real JS crashes when reading the table.
      is_fatal: false,
    },
    device,
  );
}

/**
 * A JS crash crash-reporter.ts saved to disk but may not have managed to send
 * before the process died. `[next launch]` marks it as the late copy.
 */
async function collectPendingCrash(): Promise<CrashReportBody | null> {
  const raw = await readItem(PENDING_CRASH_KEY);
  if (!raw) return null;
  let saved: {
    message?: string;
    stack?: string;
    app_version?: string;
    ota_update?: string;
    is_fatal?: boolean;
    device_model?: string | null;
    os_version?: string | null;
    free_storage_bytes?: number | null;
    total_memory_bytes?: number | null;
    js_heap_bytes?: number | null;
  };
  try {
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!saved?.message) return null;
  const atReport = await captureDeviceSnapshot();
  const device = mergeWatchdogDeviceSnapshot(
    { device_model: saved.device_model ?? null, os_version: saved.os_version ?? null },
    {
      free_storage_bytes: saved.free_storage_bytes ?? atReport.free_storage_bytes,
      total_memory_bytes: saved.total_memory_bytes ?? atReport.total_memory_bytes,
      js_heap_bytes: saved.js_heap_bytes ?? atReport.js_heap_bytes,
    },
  );
  return withDeviceFields(
    {
      message: `[next launch] ${saved.message}`,
      stack: saved.stack,
      screen: 'crash',
      app_version: saved.app_version,
      ota_update: saved.ota_update,
      is_fatal: saved.is_fatal ?? true,
    },
    device,
  );
}

function withDeviceFields(body: CrashReportBody, device: DeviceSnapshot): CrashReportBody {
  return { ...body, ...device } as CrashReportBody;
}

function describeState(state: AppStateStatus | undefined): string {
  if (state === 'active') return 'in the foreground';
  if (state === 'background') return 'in the background (user had switched away)';
  if (state === 'inactive') return 'mid-transition';
  return 'in an unknown state';
}

/** Did the dead session have lot work in flight? Answers "did they lose anything". */
async function draftPending(): Promise<boolean> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    return keys.some((k) => k.startsWith(DRAFT_KEY_PREFIX));
  } catch {
    return false;
  }
}

/**
 * Send one queued report. Nothing is dying here (this runs on a later launch
 * or on foreground), so the timeout is 10s, not the fatal handler's 3s: a short
 * timeout that fires after the server stored the row is what made duplicates.
 * report_id makes a resend of a stored report a no-op on the server (0375).
 */
function post(body: CrashReportBody, reportId: string): Promise<SendOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  return fetch(`${API_BASE}/api/telemetry/crash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app: 'staff',
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      ...body,
      message: body.message.slice(0, 500),
      stack: body.stack?.slice(0, 8000),
      screen: body.screen.slice(0, 200),
      report_id: reportId,
    }),
    signal: controller.signal,
  })
    .then((res) => sendOutcomeFor(res.status))
    .catch((): SendOutcome => 'retry')
    .finally(() => clearTimeout(timeout));
}

/**
 * Record a non-fatal event server-side (client_crash_reports) through the
 * same outbox the crash and silent-exit reports use: queued on disk first, so
 * a phone that dies or loses signal right after still sends it on the next
 * launch; then flushed now. Never throws, never blocks the caller.
 *
 * First use (2026-10-05): every failed lot save, so a "Couldn't save the lot"
 * on the floor leaves the server's own message behind instead of a guess.
 */
export function reportNonFatal(body: CrashReportBody): void {
  void enqueueReports(AsyncStorage, [{ ...body, is_fatal: false }], Date.now())
    .then(() => flush())
    .catch(() => {});
}
