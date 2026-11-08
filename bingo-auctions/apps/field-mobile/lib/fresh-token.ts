// getFreshAccessToken — a Bearer token that is actually going to pass server
// auth, refreshing first when the cached one is expired or about to be.
//
// 2026-07-10 incident: "Could not record override — not_authenticated" during
// manual checkout. supabase.auth.getSession() returns whatever access token is
// in AsyncStorage — including one that expired while the iPad sat on a shelf
// or that was revoked when the SAME shared staff account signed out on another
// device (signOut's default scope is global). The server route then 401s and
// the staffer is stuck even though a silent refresh would have fixed it.
//
// Callers doing `fetch(..., { Authorization: Bearer <token> })` should get the
// token from here instead of reading session.access_token directly, and on a
// 401 response call `forceRefreshAccessToken()` once and retry.

// 2026-08-05: both helpers now go through `refreshSessionIfNeeded`, the shared
// single-flight refresh in @auction-platform/supabase-client. They used to call
// supabase.auth.refreshSession() directly, which could rotate the refresh token
// at the same moment the AppState-resume handler was rotating it — the loser of
// that race gets 400 "Already Used" and the user is bounced to Sign In. One
// in-flight refresh for the whole app removes the race.

import { supabase, refreshSessionIfNeeded } from '@auction-platform/supabase-client';

export async function getFreshAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) return null;
  // Refreshes only if the token is at/near expiry; otherwise hands back the
  // live session untouched. On failure we still return the cached token — the
  // caller's 401 path surfaces the real error.
  const { session: fresh } = await refreshSessionIfNeeded();
  return fresh?.access_token ?? session.access_token;
}

/** Force a refresh (after a server 401) and return the new token, or null if
 *  the session is truly dead and the user must sign in again. */
export async function forceRefreshAccessToken(): Promise<string | null> {
  const { session, error } = await refreshSessionIfNeeded(true);
  if (error || !session) return null;
  return session.access_token;
}
