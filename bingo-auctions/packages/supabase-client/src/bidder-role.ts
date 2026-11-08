// useBidderRole — strict role gate for the bidder app.
//
// Mirrors useOperatorRole's contract for the consumer side. A user is
// allowed in the bidder app ONLY if they have a `bidders` row keyed by
// their auth.users.id. Otherwise we route them out: operator staff
// (with operator_users rows) go to a "wrong app" screen, fully-
// unprovisioned users go to a /complete-profile screen (Apple Sign In
// users land here because the OAuth flow can't collect DOB which the
// 0082 migration's trigger requires for new bidder rows).
//
// 2026-05-20: REVERTED the self-heal call to ensureBidderRow. That
// approach was wrong-headed because ensureBidderRow's INSERT throws
// against the 0082 age-verification trigger when birth_date is missing
// (every Apple/Google OAuth user). Instead, when no bidder row exists,
// we land on `pending_provision` and (tabs)/_layout.tsx routes the user
// to /complete-profile which collects DOB + consents and calls
// /api/bidder/signup. After that the next mount of (tabs) sees the row.

import { useEffect, useState } from 'react';
import { supabase } from './client';

export type BidderRoleState =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  /** Signed in but has an operator_users row → staff in the bidder app.
   *  We route them to a "wrong app" screen rather than show broken
   *  bidder UI (which RLS would hide anyway). */
  | { kind: 'staff_in_bidder_app' }
  /** Signed in, no operator_users row, no bidders row. Tabs layout
   *  routes to /complete-profile where the user fills DOB + consents
   *  and we POST to /api/bidder/signup to create the row. On success,
   *  /complete-profile navigates back to /(tabs)/ which re-mounts this
   *  hook and the bidders row is now found. */
  | { kind: 'pending_provision' }
  | { kind: 'bidder'; bidderId: string };

export function useBidderRole(): BidderRoleState {
  const [state, setState] = useState<BidderRoleState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    // 2026-08-05 — "the app randomly shows the signed-out browse screen".
    // useOperatorRole was hardened against this on the staff side and its
    // comment claims "same defense as useBidderRole"; that was never true.
    // This hook had three ways to declare a healthy session signed-out:
    //
    //   1. getUser() is a NETWORK call to /auth/v1/user. On any failure —
    //      warehouse dead-spot, 5xx, timeout — it returns { user: null } with
    //      an error this code dropped on the floor, so a blip read as
    //      'unauthenticated' and rendered "SIGN IN TO BID" over a perfectly
    //      valid persisted session. getSession() reads AsyncStorage with no
    //      round trip and cannot fail this way.
    //   2. The two side-table queries ignored their errors too, so a transient
    //      failure looked like "no bidders row" → 'pending_provision' → the
    //      tabs layout routes an established bidder to /complete-profile.
    //   3. Fire-once-on-mount: with no auth-state subscription, a hook that
    //      guessed wrong stayed wrong until the tabs layout remounted, which
    //      is why it "resumes working" only sometimes.
    //
    // Same rule as useOperatorRole now: only a call that SUCCEEDS and returns
    // nothing is a real negative. On error, leave the prior state alone.
    async function checkRole() {
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      if (cancelled) return;
      if (sessionErr) return; // couldn't read the session — keep prior state
      const user = sessionData.session?.user ?? null;
      if (!user) {
        // Definitively signed out (no error, no session).
        setState({ kind: 'unauthenticated' });
        return;
      }

      // Check both side-tables in parallel: a user with an
      // operator_users row is staff (wrong app for them); only when
      // they have a `bidders` row and no operator_users row are they
      // a valid bidder app user. Both tables are RLS-restricted to
      // each user seeing their own row only.
      const [opUser, bidder] = await Promise.all([
        supabase.from('operator_users').select('id').eq('user_id', user.id).maybeSingle(),
        supabase.from('bidders').select('id').eq('id', user.id).maybeSingle(),
      ]);
      if (cancelled) return;

      if (opUser.error || bidder.error) {
        // Network/RLS hiccup — do NOT downgrade to pending_provision and send
        // an established bidder to /complete-profile. Keep the prior state.
        return;
      }

      if (opUser.data) {
        setState({ kind: 'staff_in_bidder_app' });
        return;
      }
      if (bidder.data) {
        setState({ kind: 'bidder', bidderId: bidder.data.id as string });
        return;
      }
      // Query SUCCEEDED with no row — genuinely unprovisioned. Tabs layout
      // routes to /complete-profile.
      setState({ kind: 'pending_provision' });
    }

    void checkRole();
    // Re-check on sign in / sign out / token refresh so a state we got wrong
    // during a blip self-corrects instead of waiting for a remount.
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      void checkRole();
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
