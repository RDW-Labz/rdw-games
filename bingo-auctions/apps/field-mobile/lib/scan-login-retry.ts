// Pickup QR scans must survive a stale STAFF sign-in.
//
// 2026-10-13 floor report: a customer's pickup QR codes "all showed expired"
// when she came back to the counter. Pickup QR tokens never expire
// (pickups.bidder_check_in_token is minted once and never rotated; a
// checked-in pickup stays scannable until it is completed). What does expire
// is the staff device's Supabase access token: after the phone/iPad idles,
// the first staff_scan_bidder_token call can go out with a dead JWT, PostgREST
// answers "JWT expired", and the scan screen showed it verbatim as
// "Lookup failed — JWT expired" — on every QR scanned.
//
// Fix: refresh-if-needed before the call (single-flight, see fresh-token.ts),
// and if the call still fails on a stale login, force one refresh and retry
// once. If the login is truly dead, say so in words that point at the staff
// sign-in, not at the customer's code.

export type RpcError = { message?: string | null; code?: string | null } | null | undefined;

const STALE_LOGIN = /jwt expired|invalid jwt|jwt (is )?(malformed|invalid)|not[_ ]authenticated|invalid claim/i;

/** True when the failure is the caller's (staff) sign-in, not the scanned code. */
export function isStaleLoginError(err: RpcError): boolean {
  if (!err) return false;
  if (err.code === 'PGRST301' || err.code === 'PGRST303') return true;
  return STALE_LOGIN.test(err.message ?? '');
}

export type RetryResult<T> = {
  data: T | null;
  error: RpcError;
  /** The call failed on a stale login and the forced refresh did not recover it. */
  loginExpired: boolean;
  retried: boolean;
};

/**
 * Run an RPC; on a stale-login failure force one refresh and retry once.
 * `forceRefresh` returns the new access token, or null when the session is dead.
 */
export async function callWithLoginRetry<T>(
  call: () => Promise<{ data: T | null; error: RpcError }>,
  forceRefresh: () => Promise<string | null>,
): Promise<RetryResult<T>> {
  const first = await call();
  if (!isStaleLoginError(first.error)) {
    return { data: first.data, error: first.error, loginExpired: false, retried: false };
  }
  const token = await forceRefresh();
  if (!token) {
    return { data: null, error: first.error, loginExpired: true, retried: false };
  }
  const second = await call();
  return {
    data: second.data,
    error: second.error,
    loginExpired: isStaleLoginError(second.error),
    retried: true,
  };
}

export const STAFF_LOGIN_EXPIRED_TITLE = 'Staff sign-in expired';
export const STAFF_LOGIN_EXPIRED_MESSAGE =
  "This is the staff app's sign-in, not the customer's QR — their code is still good. Sign in again, then scan it.";
