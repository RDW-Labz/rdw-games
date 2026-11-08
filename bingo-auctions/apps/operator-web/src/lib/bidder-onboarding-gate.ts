// Finish-profile gate for signed-in users with no `bidders` row.
//
// Why this exists (#727): a Supabase auth account is created by
// `supabase.auth.signUp()` / OAuth, but the `bidders` row is created later by
// POST /api/bidder/signup after the user supplies a date of birth and accepts
// the policies. Nothing at the database level links the two — there is no
// auth.users → bidders trigger (the 0082 age gate rejects a row without a
// birth_date anyway).
//
// The bidder app already routes `pending_provision` to /complete-profile, and
// /bidder/onboarding renders the form on the web. But the public marketplace
// (home, /browse, /lot, /auction) is deliberately anonymous-friendly, so a
// signed-in orphan could browse forever without ever seeing the form and would
// only be corrected when they opened a profile/pickup/invoice page. Prod on
// 2026-11-05: 294 auth accounts had no bidders row, 50 of them had signed in
// in the previous 30 days.
//
// This helper decides, from data the public layout already loads, whether a
// visitor should be sent to finish their profile. It is pure so the decision
// is testable without rendering the layout.

export const FINISH_PROFILE_PATH = '/bidder/onboarding';

export type FinishProfileInput = {
  /** There is an authenticated session. */
  signedIn: boolean;
  /** The user has an `operator_users` row — staff, not a bidder. */
  isOperator: boolean;
  /** The user has a `bidders` row. */
  hasBidderRow: boolean;
  /**
   * The bidders lookup errored. A transient failure must never be treated as
   * "no profile" — that would bounce an established bidder to onboarding.
   */
  bidderLookupFailed: boolean;
  /**
   * The `operator_users` lookup errored. A staff-only account whose staff
   * lookup blips must not be mistaken for a bidder orphan and bounced to
   * onboarding — that locks staff out of the public marketplace on a blip.
   */
  staffLookupFailed: boolean;
};

/**
 * Return the onboarding URL to redirect to, or `null` to stay put.
 *
 * `nextPath` is where the visitor was heading, so finishing the profile
 * returns them there instead of dumping them on /browse.
 */
export function finishProfileRedirect(
  input: FinishProfileInput,
  nextPath: string | null | undefined,
): string | null {
  if (!input.signedIn) return null;
  if (input.isOperator) return null;
  if (input.staffLookupFailed) return null;
  if (input.bidderLookupFailed) return null;
  if (input.hasBidderRow) return null;

  const next = safeInternalPath(nextPath);
  return next ? `${FINISH_PROFILE_PATH}?next=${encodeURIComponent(next)}` : FINISH_PROFILE_PATH;
}

/** Path only (drop `?query` / `#fragment`) before route-shape checks. */
function pathOnly(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? '';
}

/** Decode up to two levels; malformed percent escapes fail closed. */
function decodeFully(value: string): string | null {
  let current = value;
  for (let i = 0; i < 2; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      // A malformed escape in the raw value fails closed. A literal `%` that
      // only appears after the first decode (e.g. `?q=100%25`) is legitimate;
      // stop there instead of rejecting the whole destination.
      return i === 0 ? null : current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** Host/route escapes that survive either the raw or the decoded form. */
function unsafeDestination(value: string): boolean {
  if (!value.startsWith('/')) return true;
  if (value.startsWith('//')) return true;
  if (value.startsWith('/\\')) return true;
  // Browsers normalise `\` to `/`, so any backslash is a host-confusion shape.
  if (value.includes('\\')) return true;
  // Any ASCII control character (CRLF/header-injection shape, tabs, NUL).
  if (/[\u0000-\u001F\u007F]/.test(value)) return true;
  return false;
}

/**
 * Accept only a same-site absolute path. Anything that could leave the site
 * (protocol-relative `//host`, backslash tricks, a scheme, encoded variants
 * of either) is dropped, as are the onboarding/auth routes themselves so the
 * gate cannot loop. The original (still-encoded) value is returned so safe
 * encoded query state round-trips unchanged.
 */
export function safeInternalPath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;
  if (unsafeDestination(trimmed)) return null;

  // A single-encoded `/\/host` or double-encoded scheme must not slip through.
  const decoded = decodeFully(trimmed);
  if (decoded === null) return null;
  if (unsafeDestination(decoded)) return null;

  // Do not bounce back into the gate or the auth callback, raw or decoded.
  for (const candidate of [trimmed, decoded]) {
    const bare = pathOnly(candidate);
    if (bare === FINISH_PROFILE_PATH) return null;
    if (bare.startsWith(`${FINISH_PROFILE_PATH}/`)) return null;
    if (bare === '/auth' || bare.startsWith('/auth/')) return null;
  }
  return trimmed;
}

/**
 * Validate a post-auth `?next=` from /auth/callback.
 *
 * Signup deliberately sends `/bidder/onboarding?next=<destination>` so a new
 * bidder still finishes DOB/consent while the place they came from survives.
 * `safeInternalPath` rejects onboarding routes to stop gate loops, so that
 * wrapper needs its own check: allow exactly the onboarding entry, return it
 * unchanged (the onboarding page decides whether to render or continue), and
 * require the nested destination to pass `safeInternalPath` — which also
 * rejects nested onboarding/auth targets, so it cannot loop.
 */
export function safePostAuthPath(path: string | null | undefined): string | null {
  const direct = safeInternalPath(path);
  if (direct) return direct;
  if (typeof path !== 'string') return null;

  const trimmed = path.trim();
  if (trimmed.length === 0) return null;
  if (unsafeDestination(trimmed)) return null;

  const withoutHash = trimmed.split('#', 1)[0] ?? '';
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex < 0) return null;
  if (withoutHash.slice(0, queryIndex) !== FINISH_PROFILE_PATH) return null;

  const params = new URLSearchParams(withoutHash.slice(queryIndex + 1));
  const nested = params.getAll('next');
  // Exactly one nested destination: a second `next` could be consumed by a
  // later boundary while this check validated the first.
  if (nested.length !== 1) return null;
  if (!safeInternalPath(nested[0])) return null;

  return trimmed;
}

/**
 * `/bidder/onboarding` entry target, carrying a safe deep link when there is
 * one. Used by signup so `?next=` is validated before it is ever forwarded.
 */
export function onboardingEntryHref(nextPath: string | null | undefined): string {
  const next = safeInternalPath(nextPath);
  return next ? `${FINISH_PROFILE_PATH}?next=${encodeURIComponent(next)}` : FINISH_PROFILE_PATH;
}

/** Card step target, carrying a safe deep link when there is one. */
export function paymentMethodHref(nextPath: string | null | undefined): string {
  const next = safeInternalPath(nextPath);
  const base = `${FINISH_PROFILE_PATH}/payment-method`;
  return next ? `${base}?next=${encodeURIComponent(next)}` : base;
}

/**
 * Where onboarding completes: the safe deep link, `/browse`, or the card step
 * while a card is required. Every completion path (server redirect and client
 * submit) goes through here so `next` is validated at the point of use.
 */
export function postOnboardingHref(
  nextPath: string | null | undefined,
  paymentsDisabled: boolean,
): string {
  if (!paymentsDisabled) return paymentMethodHref(nextPath);
  return completedOnboardingHref(nextPath);
}

/** Where a fully onboarded bidder goes: the safe deep link or `/browse`. */
export function completedOnboardingHref(nextPath: string | null | undefined): string {
  return safeInternalPath(nextPath) ?? '/browse';
}

/**
 * Rebuild the visitor's full destination from the two request headers the
 * middleware sets. `x-pathname` stays pathname-only for existing consumers;
 * `x-search` carries the query string (including its leading `?`).
 *
 * A malformed or control-character-bearing search is dropped rather than
 * concatenated, so a header-injection shape can never reach the redirect.
 */
export function nextPathFromRequest(
  pathname: string | null | undefined,
  search: string | null | undefined,
): string | null {
  if (typeof pathname !== 'string' || pathname.length === 0) return null;
  if (typeof search !== 'string' || search.length === 0) return pathname;
  if (!search.startsWith('?')) return pathname;
  if (/[\u0000-\u001F\u007F]/.test(search)) return pathname;
  return `${pathname}${search}`;
}
