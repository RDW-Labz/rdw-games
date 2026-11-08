// 2026-05-20: @sentry/react-native fully removed from staff app.
//
// WHY: Sentry's iOS CPPExceptionTerminate handler was intercepting real JS
// crashes (RNSScreen setViewToSnapshot + onHeaderHeightChange race on iOS 26)
// and rethrowing them as SIGABRT on unrelated threads — masking the true
// stack trace AND introducing its own crash variants (SentryBaggageSerialization
// nil-key Swift crash seen on v22). 22 TestFlight crashes on v16-v25 all
// routed through Sentry's monitor; once Sentry is stripped the real crash
// surfaces in clean TestFlight logs.
//
// This file is intentionally a no-op stub so call sites (_layout.tsx,
// any captureError calls scattered through the app) keep compiling without
// edits. When we re-introduce error monitoring post-launch we will use a
// JS-only transport that does not auto-init from AppDelegate.

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
