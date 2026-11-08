// Role detection.
//
// The auction platform has two kinds of authenticated user: bidders
// (consumers, exist as a `bidders` row) and operator staff (B2B,
// exist as an `operator_users` row scoped to one operator with a role
// of admin / manager / picker). An auth user can be both: most operator
// owners use the bidder app to test their own listings.
//
// We never assume a role at startup — we look up the authenticated
// user's row in `operator_users` (if any) lazily and cache.
//
// Bidder-mobile uses this to decide whether to expose the legacy
// `/picker` stack from the profile screen. Field-mobile uses
// `useOperatorRole` (in ./operator-role.ts) which is stricter — it
// gates the entire app on having an operator_users row.

import { useEffect, useState } from 'react';
import { supabase } from './client';

export type StaffRole = 'admin' | 'manager' | 'picker' | 'lead';
export type Role = 'bidder' | StaffRole | 'unknown';

export type RoleState = {
  role: Role;
  operatorId: string | null;
  ready: boolean;
};

export function useRole(): RoleState {
  const [state, setState] = useState<RoleState>({
    role: 'unknown',
    operatorId: null,
    ready: false,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // getSession() (local read), not getUser() (network call): a dead-spot
      // blip made getUser() return {user:null} and this hook reported
      // role:'unknown' for a signed-in user. Same fix as useOperatorRole /
      // useBidderRole — see the note in bidder-role.ts (2026-08-05).
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      if (cancelled) return;
      if (sessionErr) return; // keep prior state; don't publish a false 'unknown'
      const user = sessionData.session?.user ?? null;
      if (!user) {
        setState({ role: 'unknown', operatorId: null, ready: true });
        return;
      }
      const { data: staff, error: staffErr } = await supabase
        .from('operator_users')
        .select('role, operator_id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (cancelled) return;
      if (staffErr) return; // query hiccup — don't downgrade staff to 'bidder'
      if (staff) {
        setState({
          role: staff.role as StaffRole,
          operatorId: staff.operator_id as string,
          ready: true,
        });
      } else {
        setState({ role: 'bidder', operatorId: null, ready: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
