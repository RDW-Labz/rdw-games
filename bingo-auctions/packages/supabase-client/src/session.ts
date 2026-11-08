// Session helpers — keep auth-related logic out of components.

import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { refreshSessionIfNeeded, supabase } from './client';

// Should a failed recovery refresh actually sign the user out?
//
// FAIL OPEN (2026-08-10). This used to ask the opposite question — "is this
// error transient?" — and signed the user out for anything it did not
// recognise. Plenty of non-definitive failures land there with no `status` and
// a name that isn't AuthRetryableFetchError: auth-js's own
// LockAcquireTimeoutError (5s lock timeout), an AsyncStorage read failure, a
// bare `TypeError: Network request failed` from RN's fetch. Each one dumped a
// bidder with a perfectly good stored session onto /login — "logging out on its
// own" (iOS field report).
//
// Only a refresh token the SERVER rejected is definitive: supabase-js reports
// that as an AuthApiError with 400/401. Anything else keeps the session and
// lets auto-refresh try again — the cost of being wrong here is one stale
// screen that self-corrects, versus forcing a real re-login.
function isDefinitiveAuthFailure(error: unknown): boolean {
  const e = error as { name?: string; status?: number } | null | undefined;
  if (!e) return false;
  if (e.name === 'AuthRetryableFetchError') return false;
  return e.status === 400 || e.status === 401;
}

export function useSession(): { session: Session | null; ready: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // 2026-05-20: 5s timeout fallback re-added. After v19 we identified the
    // real causes of the post-launch hang (react-native-screens iOS 26 GC
    // crash + useBidderRole race with ensureBidderRow), neither of which
    // involved this timeout. Now restoring the protection for the corrupt-
    // AsyncStorage failure mode: if a tester upgraded over an older v15/v16
    // install whose Supabase session is broken, getSession() can hang
    // forever and the splash never clears. Race with a 5s timer; whichever
    // resolves first wins. On timeout we fall through to the login screen
    // — the user signs back in, the new session overwrites the corrupt
    // cache, and subsequent launches are clean.
    let timedOut = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // The timeout only decides WHEN TO STOP SHOWING THE SPLASH. It no longer
    // decides that there is no session.
    //
    // 2026-08-10: the race used to discard the real getSession() result once
    // the timer won, permanently pinning `session` to null — so a cold start on
    // slow cell service showed /login to a bidder whose stored session was
    // perfectly valid, and nothing corrected it until they signed in again.
    // That is the other half of "logging out on its own". Now the real call is
    // still awaited and applied whenever it lands: worst case the user sees the
    // login screen for a moment and is then moved on by the late result.
    timer = setTimeout(() => {
      timedOut = true;
      if (!cancelled) setReady(true);
      // eslint-disable-next-line no-console
      console.warn(
        '[useSession] getSession() exceeded 12s — showing login while it finishes ' +
          '(slow storage/network, or genuinely corrupt AsyncStorage).',
      );
      // 2026-07-21: 5s → 12s. On a slow Android cold-start getSession() can
      // legitimately take >5s to read a valid session from AsyncStorage.
    }, 12000);

    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        if (timer) clearTimeout(timer);
        setSession(data.session);
        setReady(true);
        if (timedOut && data.session) {
          // eslint-disable-next-line no-console
          console.warn('[useSession] late getSession() recovered a valid session.');
        }
      })
      .catch(() => {
        // A THROWN getSession() says nothing definitive about the stored
        // session — surface the app rather than asserting signed-out.
        if (cancelled) return;
        if (timer) clearTimeout(timer);
        setReady(true);
      });
    // A failed background token refresh emits SIGNED_OUT with s=null even when
    // the operator never tapped "sign out" — which bounced active lotting
    // sessions to /login (tester report 2026-06-16). Before honoring a
    // SIGNED_OUT, attempt ONE recovery refresh; only null the session if it
    // truly can't be recovered. `recovering` blocks a refresh loop: a dead
    // session's failed refresh re-emits SIGNED_OUT, which we then ignore.
    let recovering = false;
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_OUT' && !recovering) {
        recovering = true;
        // Via the shared single-flight refresh (2026-08-05): if a resume-time
        // refresh is already in flight, join it instead of firing a second
        // rotation that would invalidate the first one's token mid-recovery.
        refreshSessionIfNeeded(true)
          .then(({ session: recovered, error }) => {
            if (!error && recovered) {
              setSession(recovered);
              return;
            }
            // Only sign the user out for a DEFINITIVE auth failure (a refresh
            // token the server rejected, 400/401). A transient network error
            // must NOT bounce them to /login — this was the Android "keeps
            // signing me out" cause (2026-07-21): a brief connectivity blip
            // during a background refresh emitted SIGNED_OUT, and nulling on
            // ANY error dumped the bidder to login. Keep the session and let
            // autoRefresh recover.
            if (!isDefinitiveAuthFailure(error)) return;
            setSession(null);
          })
          .catch(() => {
            // Thrown (not returned) — treat as transient; keep the session.
          })
          .finally(() => {
            recovering = false;
          });
        return;
      }
      setSession(s);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, ready };
}

// After Supabase Auth signUp, ensure a row exists in `bidders` for the
// user. Idempotent: safe to call on every login. Used by the bidder app
// only — the field app uses ensureOperatorUserRow instead because field
// users are operator staff, not bidders.
export async function ensureBidderRow(): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return;

  const { data: existing } = await supabase
    .from('bidders')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();
  if (existing) return;

  const displayName =
    (user.user_metadata?.['display_name'] as string | null | undefined) ?? null;
  await supabase.from('bidders').insert({
    id: user.id,
    email: user.email ?? '',
    display_name: displayName,
  });
}
