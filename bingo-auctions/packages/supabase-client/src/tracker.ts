// Tiny telemetry shim. Domain packages call `track(event, props)` for
// product-analytics events without taking a dependency on PostHog
// directly — that keeps the package portable across both Expo apps
// and avoids forcing every package to know how analytics is wired.
//
// The host app registers a real implementation at startup via
// `setTracker(realTrackFn)`. Until that happens, calls are no-ops.

type TrackerFn = (event: string, props?: Record<string, unknown>) => void;

let impl: TrackerFn = () => {};

export function setTracker(fn: TrackerFn): void {
  impl = fn;
}

export function track(event: string, props?: Record<string, unknown>): void {
  try {
    impl(event, props);
  } catch {
    // Telemetry must never crash the caller.
  }
}
