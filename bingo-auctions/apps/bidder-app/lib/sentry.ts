// 2026-05-20: @sentry/react-native fully removed from bidder app.
//
// WHY: bidder v13/v14/v15 hung on the launch splash indefinitely with the
// Sentry plugin + Sentry.init({ enableNative: true }) wired. Even after the
// plugin was removed from app.config.ts (v15) and the init call deferred
// via setTimeout, v15 still hung — strong signal that the @sentry/react-native
// JS module itself has import-time side effects that interact badly with
// Expo SDK 54 + RN 0.81.5 + New Architecture + iOS 26. Plus the staff app's
// crash investigation showed Sentry's iOS CPPExceptionTerminate handler
// masking real crash signatures. Cleanest fix: no @sentry/react-native code
// in either app.
//
// This file is a no-op stub so callers (_layout.tsx, captureError sites)
// keep compiling. Will re-add JS-only error reporting post-launch using a
// transport that does not auto-init from AppDelegate.

export function initSentry(): void {
  // no-op
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.error('[error]', err, context);
}

export function setUserId(_userId: string | null): void {
  // no-op
}
