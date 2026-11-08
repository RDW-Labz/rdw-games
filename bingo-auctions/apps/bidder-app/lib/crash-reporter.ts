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
// 2026-09-23: it never produced a single row. The fetch starts inside the fatal
// handler and the default handler kills the process before it leaves the phone.
// The report is now also saved to disk first; session-watchdog.ts sends it on
// the next launch if this one did not get out.
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { postCrashReport, type CrashReportBody } from './telemetry-post';
import { PENDING_CRASH_KEY } from './session-watchdog';

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
  const body: CrashReportBody = {
    app_version: Constants.expoConfig?.version ?? undefined,
    ota_update: Updates.updateId ?? undefined,
    message: err.message.slice(0, 500),
    stack: (err.stack ?? '').slice(0, 8000),
    is_fatal: isFatal,
  };
  // Disk first: the native write is queued before the process can die, the
  // network request usually is not. Cleared again if the send gets through.
  AsyncStorage.setItem(PENDING_CRASH_KEY, JSON.stringify(body)).catch(() => {});
  void postCrashReport(body).then((ok) => {
    if (ok) AsyncStorage.removeItem(PENDING_CRASH_KEY).catch(() => {});
  });
}
