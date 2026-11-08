// Layer-1 crash telemetry — global JS error handler → POST /api/telemetry/crash.
//
// Why this exists: the Sentry native SDK was removed 2026-05-20 (implicated in
// the iOS 26 launch hang) and the remaining lib/sentry.ts is a no-op stub, so
// production JS crashes were invisible — the 2026-07-02 pickup-push crash was
// only found because a tester filed an Apple crash report. This is the safe
// replacement: pure JS, no native init, OTA-able, fire-and-forget.
//
// Guarantees:
//   - NEVER throws and never blocks: reporting is best-effort with a timeout.
//   - Always chains to the previous handler so the RN redbox/dev behavior and
//     any future handler keep working.
//   - Installs at most once per JS context.
//
// 2026-09-23: almost none of client_crash_reports' ~490 staff rows came from
// here — they are session-watchdog "silent exit" reports. The fetch starts
// inside the fatal handler and the default handler kills the process before it
// leaves the phone. The report is now saved to disk first, and
// session-watchdog.ts sends it on the next launch if this one did not get out.

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { captureDeviceSnapshot } from './device-snapshot';

const API_BASE = (
  (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_API_BASE_URL) ||
  'https://bingoauctions.com'
).replace(/\/$/, '');

const APP: 'bidder' | 'staff' = 'staff';

/** Read and sent by session-watchdog.ts on the next launch. */
export const PENDING_CRASH_KEY = 'telemetry:pending-crash:v1';

let installed = false;

export function installCrashReporter(): void {
  if (installed) return;
  installed = true;

  // ErrorUtils is RN's global fatal-error hook. Typed loosely because it isn't
  // in the public TS surface.
  const errorUtils = (
    globalThis as unknown as {
      ErrorUtils?: {
        getGlobalHandler: () => (error: unknown, isFatal?: boolean) => void;
        setGlobalHandler: (h: (error: unknown, isFatal?: boolean) => void) => void;
      };
    }
  ).ErrorUtils;
  if (!errorUtils) return;

  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    try {
      report(error, isFatal ?? false);
    } catch {
      // Reporting must never make a crash worse.
    }
    previous(error, isFatal);
  });
}

function report(error: unknown, isFatal: boolean): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const basePayload = {
    app: APP,
    platform: Platform.OS === 'android' ? 'android' : 'ios',
    app_version: Constants.expoConfig?.version ?? undefined,
    ota_update: Updates.updateId ?? undefined,
    message: err.message.slice(0, 500),
    stack: (err.stack ?? '').slice(0, 8000),
    is_fatal: isFatal,
  };
  const body = JSON.stringify(basePayload);
  // Disk first: the native write is queued before the process can die, the
  // network request usually is not. Cleared again if the send gets through.
  AsyncStorage.setItem(PENDING_CRASH_KEY, body).catch(() => {});

  void (async () => {
    const device = await captureDeviceSnapshot();
    const enrichedBody = JSON.stringify({ ...basePayload, ...device });
    AsyncStorage.setItem(PENDING_CRASH_KEY, enrichedBody).catch(() => {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    fetch(`${API_BASE}/api/telemetry/crash`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: enrichedBody,
      signal: controller.signal,
    })
      .then((res) => {
        if (res.ok) AsyncStorage.removeItem(PENDING_CRASH_KEY).catch(() => {});
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  })();
}
