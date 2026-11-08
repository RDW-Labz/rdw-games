// OTA auto-reload decision logic — pure, no React, no native modules.
//
// WHY THIS EXISTS
// app.config.ts sets checkAutomatically 'ON_LOAD' + fallbackToCacheTimeout 0,
// which downloads an update at launch but boots the cached bundle. Nothing on
// that path calls reloadAsync, so the update waits for the next COLD start —
// and backgrounding an app iOS keeps in memory does not count. Jared's "updates
// do not always appear" (2026-09-16) was this: they always arrive, a launch
// late, and whether he saw one depended on how many cold starts he'd had.
//
// See docs/plans/PLAN-ota-auto-reload-2026-09-16.md for the full analysis.
//
// THE POLICY (owner call, Jared 2026-09-16: "instant")
// Reload on ANY screen, bidding included. place_bid is server-side atomic, so a
// reload mid-bid loses the confirmation UI, not the bid. That was his call to
// make and he made it.
//
// The two exclusions below are NOT product policy — they are cases where a
// reload corrupts an in-flight mechanism rather than merely interrupting a
// screen. Do not remove them on UX grounds.
//
// Kept pure so the whole decision is testable without a native runtime; the
// hook in useOtaAutoReload.ts holds all the side effects.

/**
 * Routes where reloading breaks something that cannot simply be re-rendered.
 * Matched against `useSegments().join('/')`.
 *
 * pickup-pass — renders the session QR that warehouse staff scan at the
 *   counter (mig 0241). A reload mid-scan breaks a physical handover while a
 *   customer is standing there.
 *
 * profile/payment-method, verify-card — both already use the AppState 'active'
 *   transition to resume a Square card-save that handed off to WebBrowser.
 *   Our trigger is that same transition, so reloading here collides with an
 *   in-flight flow rather than interrupting an idle screen: the pending state
 *   they are waiting to reconcile dies with the JS context.
 *
 * Deliberately NOT excluded, though they also listen to AppState: (tabs)/pickup
 * and lot/[id] use it to REFETCH on resume. A reload remounts them and they
 * refetch anyway, so the outcome is identical.
 */
export const RELOAD_BLOCKED_ROUTES: readonly string[] = [
  'pickup-pass',
  'profile/payment-method',
  'verify-card',
];

export type ReloadDecisionInput = {
  /** expo-updates: a new bundle is downloaded and ready to apply. */
  isUpdatePending: boolean;
  /** `useSegments().join('/')` for the screen the user is looking at. */
  route: string;
  /** True only on the background → active transition. */
  returningToForeground: boolean;
  /** Set once we have reloaded; the cap is per JS process. */
  alreadyReloaded: boolean;
};

/**
 * Should we apply a downloaded update right now?
 *
 * The once-per-process cap is a loop guard: if a bad bundle ever reloaded on
 * every foreground, the app would be unusable. Production also has
 * `disableAntiBrickingMeasures: false`, so the OS falls back to the embedded
 * bundle — but that is the second line of defence, not the first.
 */
export function shouldReload({
  isUpdatePending,
  route,
  returningToForeground,
  alreadyReloaded,
}: ReloadDecisionInput): boolean {
  if (alreadyReloaded) return false;
  if (!isUpdatePending) return false;
  if (!returningToForeground) return false;
  return !isRouteBlocked(route);
}

/**
 * Prefix match, so a blocked screen's nested routes are blocked too — a future
 * `verify-card/confirm` inherits the exclusion instead of silently escaping it.
 */
export function isRouteBlocked(route: string): boolean {
  return RELOAD_BLOCKED_ROUTES.some(
    (blocked) => route === blocked || route.startsWith(`${blocked}/`),
  );
}
