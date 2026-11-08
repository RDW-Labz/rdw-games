// useOperatorRole — strict role gate for the BinGo Staff app.
//
// Unlike useRole (which classifies users as bidder | staff | unknown),
// this hook only cares whether the authenticated user has an
// `operator_users` row. If they don't, the field app should sign them
// out and route them to the consumer bidder app.
//
// Returned `role` matches the operator_user_role Postgres enum:
// 'admin' | 'manager' | 'picker' | 'lead'. The field app uses this to gate
// admin-only screens (warehouse capture, staff invites) from picker-
// only screens (intake, stage). 'lead' (key holder) ranks below manager.
//
// 2026-11-04 (#770): the "stuck on Loading" field report. The old contract
// was fail-open: a failed `getSession()` or `operator_users` query returned
// WITHOUT touching state, leaving the initial `{ kind: 'loading' }` in place.
// That is correct for a transient blip during a shift — a false "wrong app"
// modal mid-shift is worse — but on FIRST mount there is no prior role to
// preserve, so the same branch pinned the app to "Loading…" forever with no
// retry control. A phone that was force-quit into the same failure came back
// to the same dead screen.
//
// The contract now distinguishes the two cases:
//   • A role was already established (`staff`) and a refresh fails → keep it
//     (fail open, as before).
//   • No role is established yet and every bounded attempt fails → surface an
//     `error` state with a Retry action instead of an open-ended await.
//
// Each attempt is bounded by `runWithRetry` (shared): a per-attempt timeout so
// a request that never comes back cannot hang the screen, and exponential
// backoff between tries. Supabase's query builder gets the attempt signal so a
// timed-out query is actually cancelled.

import { useEffect, useRef, useState } from 'react';
import { runWithRetry } from '@auction-platform/shared';
import { RoleCheckArbiter } from './operator-role-arbiter';
import { shouldKeepPriorRoleOnFailure } from './operator-role-policy';
import { supabase } from './client';

export type OperatorRole = 'admin' | 'manager' | 'picker' | 'lead';

export type OperatorRoleState =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  | { kind: 'not_staff' } // signed in but no operator_users row — wrong app
  | { kind: 'error'; message: string; retry: () => void }
  | {
      kind: 'staff';
      role: OperatorRole;
      operatorId: string;
      operatorUserId: string;
    };

/** Total bounded attempts for one role check. */
export const ROLE_CHECK_ATTEMPTS = 3;
/** Per-attempt timeout. A dropped connection must not own the screen. */
export const ROLE_CHECK_TIMEOUT_MS = 8_000;
/** First backoff between attempts. */
export const ROLE_CHECK_BASE_DELAY_MS = 400;
/** Backoff cap. */
export const ROLE_CHECK_MAX_DELAY_MS = 2_000;

export const ROLE_ERROR_MESSAGE =
  "Couldn't check your staff access — the server didn't answer. Check the connection and tap Retry.";

type RoleOutcome =
  | { kind: 'unauthenticated'; userId: null }
  | { kind: 'not_staff'; userId: string }
  | {
      kind: 'staff';
      role: OperatorRole;
      operatorId: string;
      operatorUserId: string;
      userId: string;
    };

/**
 * A failed attempt that still knows which auth user it observed.
 *
 * The old hook recorded the observed user through a side-effect callback, so a
 * timed-out attempt could fire it AFTER a later attempt had bound a different
 * user — the abandoned attempt then owned the identity. Binding the user to the
 * outcome/error makes the winning attempt the only writer.
 */
class RoleAttemptError extends Error {
  override readonly name = 'RoleAttemptError';

  constructor(
    readonly observedUserId: string | null,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
  }
}

function observedUserFromError(error: unknown): string | null {
  return error instanceof RoleAttemptError ? error.observedUserId : null;
}

/**
 * Whether a failed role check may keep the previously established staff role.
 *
 * Implemented in `operator-role-policy.ts` so the rule is unit-testable
 * without mounting the hook.
 */
export { shouldKeepPriorRoleOnFailure } from './operator-role-policy';

export function useOperatorRole(): OperatorRoleState {
  const [state, setState] = useState<OperatorRoleState>({ kind: 'loading' });
  // Bumped by the error screen's Retry action. Re-running the effect gives the
  // hook a fresh attempt sequence without remounting the whole app.
  const [retryToken, setRetryToken] = useState(0);
  const stateRef = useRef<OperatorRoleState>(state);

  // Keep the ref in lockstep with the rendered state. Updating it only in a
  // passive effect left a window where a refresh fired between `setState` and
  // the effect captured the stale prior state (e.g. `loading`) and replaced
  // freshly established staff access with an error — unmounting navigation and
  // providers mid-use.
  function applyState(next: OperatorRoleState) {
    stateRef.current = next;
    setState(next);
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // Owns the request sequence and the auth identity the current staff role
    // was established for. Every lookup must still own its token before it can
    // write state, and a sign-out invalidates all in-flight lookups (#770
    // HIGH 1). The identity is what lets a failed refresh tell a transient
    // blip for the SAME staff member from an account switch whose new-user
    // role query also failed.
    const gate = new RoleCheckArbiter();

    async function attemptRoleCheck(attempt: number, signal: AbortSignal): Promise<RoleOutcome> {
      // getSession() reads the locally-persisted session (no network round
      // trip), so it's both faster and immune to the refresh-time blips that
      // getUser() is vulnerable to. It cannot accept a signal, so the attempt
      // timeout above bounds it by racing rather than cancelling.
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      if (sessionErr) {
        // A thrown/returned session error says nothing definitive about the
        // stored session — retry before asserting signed-out.
        throw new RoleAttemptError(null, sessionErr);
      }
      const user = sessionData.session?.user ?? null;
      if (!user) {
        // Definitively signed out (no error, no session).
        return { kind: 'unauthenticated', userId: null };
      }

      const { data: staff, error: staffErr } = await supabase
        .from('operator_users')
        .select('id, role, operator_id')
        .eq('user_id', user.id)
        .abortSignal(signal)
        .maybeSingle();
      if (staffErr) {
        // Query errored (network/RLS hiccup) — retry; never downgrade on this.
        throw new RoleAttemptError(user.id, staffErr);
      }
      if (!staff) {
        // Query SUCCEEDED with no row — genuinely not staff (wrong app).
        return { kind: 'not_staff', userId: user.id };
      }
      return {
        kind: 'staff',
        role: staff.role as OperatorRole,
        operatorId: staff.operator_id as string,
        operatorUserId: staff.id as string,
        userId: user.id,
      };
    }

    async function checkRole() {
      const prior = stateRef.current;
      const priorUserId = gate.getIdentity();
      const token = gate.begin();

      const result = await runWithRetry((attempt, signal) => attemptRoleCheck(attempt, signal), {
        attempts: ROLE_CHECK_ATTEMPTS,
        timeoutMs: ROLE_CHECK_TIMEOUT_MS,
        baseDelayMs: ROLE_CHECK_BASE_DELAY_MS,
        maxDelayMs: ROLE_CHECK_MAX_DELAY_MS,
        signal: controller.signal,
      });

      if (cancelled) return;

      // A sign-out (or a newer check) makes this result stale. Even a success
      // that resolves after `SIGNED_OUT` must not restore the prior role.
      gate.commit(token, () => {
        if (result.ok) {
          const outcome = result.value;
          gate.setIdentity(outcome.kind === 'staff' ? outcome.userId : null);
          if (outcome.kind === 'staff') {
            applyState({
              kind: 'staff',
              role: outcome.role,
              operatorId: outcome.operatorId,
              operatorUserId: outcome.operatorUserId,
            });
          } else {
            applyState({ kind: outcome.kind });
          }
          return;
        }

        // A query failure may still carry the user it observed before failing.
        // It is bound to that attempt's error, so an abandoned attempt cannot
        // overwrite it later.
        const observedUserId = observedUserFromError(result.error);
        // Fail open only when a role was already established FOR THE SAME auth
        // user. A transient refresh failure must not false-downgrade an active
        // staff member mid-shift — but if the device switched accounts and the
        // new user's role query failed, keeping the previous identity would let
        // one person work under another's staff role.
        if (shouldKeepPriorRoleOnFailure(prior.kind, priorUserId, observedUserId)) return;
        if (prior.kind === 'staff') gate.clearIdentity();

        applyState({
          kind: 'error',
          message: ROLE_ERROR_MESSAGE,
          retry: () => {
            applyState({ kind: 'loading' });
            setRetryToken((n) => n + 1);
          },
        });
      });
    }

    // 2026-05-20: re-run on auth state changes (sign in / sign out /
    // token refresh). Without this the hook is "fire once on mount" —
    // a freshly invited staff member whose operator_users row was
    // INSERTed just before they first tapped the email link would race
    // and observe `not_staff`, landing on the "wrong app" screen until
    // a force-quit. Same defense as useBidderRole.
    void checkRole();
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const eventUserId = session?.user?.id ?? null;
      const establishedUserId = gate.getIdentity();
      if (event === 'SIGNED_OUT') {
        // Definitively no identity. Drop the prior staff role NOW so a
        // subsequent session/role read cannot fail its way back into the
        // previous person's access. `invalidate()` also bumps the sequence, so
        // any in-flight initial/refresh lookup is stale and a late success
        // cannot restore the prior staff/admin UI after sign-out (#770 HIGH 1).
        gate.invalidate();
        applyState({ kind: 'unauthenticated' });
        return;
      }
      if (eventUserId && establishedUserId && eventUserId !== establishedUserId) {
        // Definitively a different account. The retry ladder below may take a
        // few seconds; the previous user's staff state must not survive it,
        // even if every new-user read fails.
        gate.clearIdentity();
        applyState({ kind: 'loading' });
      }
      void checkRole();
    });
    return () => {
      cancelled = true;
      gate.dispose();
      controller.abort();
      sub.subscription.unsubscribe();
    };
  }, [retryToken]);

  return state;
}

// Pure helper — given a current role and a required role, return whether
// access is permitted. admin > manager > lead > picker.
// 'lead' (key holder) sits below manager, so it never satisfies a
// `hasOperatorRole(role, 'manager')` gate (e.g., sticker-skip), but ranks
// above picker.
const RANK: Record<OperatorRole, number> = {
  admin: 4,
  manager: 3,
  lead: 2,
  picker: 1,
};
export function hasOperatorRole(
  current: OperatorRole | null | undefined,
  required: OperatorRole,
): boolean {
  if (!current) return false;
  return RANK[current] >= RANK[required];
}
