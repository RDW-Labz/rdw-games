// The bidder app's next-launch witness: reports what the previous session could
// not report itself.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// 2026-09-23: client_crash_reports held ZERO bidder rows, ever. Not because the
// app never failed — because every failure it had was one the ErrorUtils hook
// cannot send:
//   - A JS fatal: the handler starts a fetch, then the default handler kills the
//     process before it leaves the phone. Staff shows the same: of ~490 rows,
//     almost none come from its crash handler.
//   - A silent OS kill: no JS runs at all.
//   - An OTA that throws at import (all of August–September, #365): the crash
//     happens before any reporter is armed, and expo-updates rolls back quietly.
//
// All three leave evidence on disk that only the NEXT launch can read. This
// file reads it, once, at boot:
//   1. a crash the handler saved but could not send   (crash-reporter.ts)
//   2. a session mark that was never cleared           (a silent kill)
//   3. a downloaded update that is not the one running (ota-health.ts)
//
// Each finding goes into the telemetry outbox BEFORE its evidence is cleared,
// and leaves the outbox only once the server accepts it (telemetry-outbox.ts).
// A slow or dead connection delays a report; it no longer loses it.
//
// Ported from apps/field-mobile/lib/session-watchdog.ts, which is where ~all of
// staff's telemetry comes from. Same failure posture: every path swallows its
// errors. A watchdog that can crash the app it watches is worse than none.

import { AppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { postCrashReport, type CrashReportBody } from './telemetry-post';
import { otaHealthMessage, parseDownloadedMark } from './ota-health';
import { enqueueReports, flushOutbox } from './telemetry-outbox';

const MARK_KEY = 'session:watchdog:v1';
/** Written by crash-reporter.ts from inside the fatal handler. */
export const PENDING_CRASH_KEY = 'telemetry:pending-crash:v1';
/** Written when expo-updates finishes downloading an update. */
const DOWNLOADED_KEY = 'ota:downloaded:v1';

/** A relaunch later than this reads as "came back later", not "it died on me". */
const RELAUNCH_WINDOW_MS = 20 * 60 * 1000;
const BEAT_MS = 10_000;

interface SessionMark {
  screen: string | null;
  state: AppStateStatus;
  screenSince: number;
  lastBeat: number;
  bootedAt: number;
  appVersion: string | null;
  otaUpdate: string | null;
}

let timer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let sub: { remove: () => void } | null = null;
let current: SessionMark | null = null;
let started = false;

/** A slow first request is normal on a phone; one later try this session. */
const RETRY_AFTER_MS = 30_000;

/** Called by the router hook on every route change. */
export function noteScreen(screen: string | null): void {
  if (!current) return;
  if (current.screen === screen) return;
  current.screen = screen;
  current.screenSince = Date.now();
  void writeMark();
}

/** Called when expo-updates reports a finished download (useOtaAutoReload). */
export function noteDownloadedUpdate(updateId: string | undefined): void {
  if (!updateId) return;
  AsyncStorage.setItem(DOWNLOADED_KEY, JSON.stringify({ updateId, at: Date.now() })).catch(
    () => {},
  );
}

/** Start the watchdog. Safe to call once per JS context; later calls no-op. */
export function startSessionWatchdog(): void {
  if (started) return;
  started = true;

  void (async () => {
    // Order matters: read the evidence before this session overwrites it, and
    // queue what it says before clearing it. Sending comes last and may fail.
    const found: CrashReportBody[] = [];
    for (const collect of [collectPendingCrash, collectOtaHealth, collectPreviousDeath]) {
      try {
        const body = await collect();
        if (body) found.push(body);
      } catch {
        // One failed post-mortem must not stop the others, or the watch.
      }
    }
    if (await enqueueReports(AsyncStorage, found, Date.now())) {
      await clearEvidence();
    }

    const now = Date.now();
    current = {
      screen: null,
      state: AppState.currentState,
      screenSince: now,
      lastBeat: now,
      bootedAt: now,
      appVersion: Constants.expoConfig?.version ?? null,
      otaUpdate: Updates.updateId ?? 'embedded',
    };
    await writeMark();

    timer = setInterval(() => {
      if (!current) return;
      current.lastBeat = Date.now();
      current.state = AppState.currentState;
      void writeMark();
    }, BEAT_MS);

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

/** Test/teardown hook. Not used in app code. */
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

/** Send whatever is queued; failures stay queued for the next try. */
function flush(): void {
  void flushOutbox(AsyncStorage, postCrashReport, Date.now());
}

async function writeMark(): Promise<void> {
  if (!current) return;
  try {
    await AsyncStorage.setItem(MARK_KEY, JSON.stringify(current));
  } catch {
    // Diagnostics are optional.
  }
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
  for (const key of [PENDING_CRASH_KEY, DOWNLOADED_KEY, MARK_KEY]) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      // See above.
    }
  }
}

/** A crash the fatal handler saved but may not have managed to send. */
async function collectPendingCrash(): Promise<CrashReportBody | null> {
  const raw = await readItem(PENDING_CRASH_KEY);
  if (!raw) return null;
  let body: CrashReportBody;
  try {
    body = JSON.parse(raw) as CrashReportBody;
  } catch {
    return null;
  }
  if (!body?.message) return null;
  return { ...body, message: `[next launch] ${body.message}` };
}

async function collectOtaHealth(): Promise<CrashReportBody | null> {
  const downloaded = parseDownloadedMark(await readItem(DOWNLOADED_KEY));
  const message = otaHealthMessage({
    downloaded,
    runningId: Updates.updateId ?? null,
    isEmergencyLaunch: Updates.isEmergencyLaunch,
    emergencyLaunchReason: Updates.emergencyLaunchReason ?? null,
  });
  if (!message) return null;
  return {
    message,
    screen: 'launch',
    app_version: Constants.expoConfig?.version ?? undefined,
    ota_update: Updates.updateId ?? 'embedded',
    is_fatal: true,
  };
}

async function collectPreviousDeath(): Promise<CrashReportBody | null> {
  const raw = await readItem(MARK_KEY);
  if (!raw) return null;
  let mark: SessionMark;
  try {
    mark = JSON.parse(raw) as SessionMark;
  } catch {
    return null;
  }
  if (!mark?.lastBeat) return null;

  const sinceDeath = Date.now() - mark.lastBeat;
  if (sinceDeath < 0 || sinceDeath > RELAUNCH_WINDOW_MS) return null;

  const onScreenMs = Math.max(0, mark.lastBeat - (mark.screenSince ?? mark.lastBeat));
  const screen = mark.screen ?? 'unknown';
  return {
    message:
      `silent exit on ${screen} — process died while ${describeState(mark.state)}, ` +
      `${Math.round(onScreenMs / 1000)}s into the screen, relaunched ${Math.round(sinceDeath / 1000)}s later`,
    screen,
    app_version: mark.appVersion ?? undefined,
    ota_update: mark.otaUpdate ?? undefined,
    // Nothing threw; keeps these separable from real JS crashes.
    is_fatal: false,
  };
}

function describeState(state: AppStateStatus | undefined): string {
  if (state === 'active') return 'in the foreground';
  if (state === 'background') return 'in the background (user had switched away)';
  if (state === 'inactive') return 'mid-transition';
  return 'in an unknown state';
}
