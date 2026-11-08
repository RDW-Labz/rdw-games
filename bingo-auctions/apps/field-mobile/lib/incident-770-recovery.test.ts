import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoleCheckArbiter } from '@auction-platform/supabase-client/operator-role-arbiter';
import { shouldKeepPriorRoleOnFailure } from '@auction-platform/supabase-client/operator-role-policy';

// Issue #770 — staff saw "Lot not found" for a sticker that another device
// could read, then the app sat on "Loading…". Both were silent-error paths:
// the role hook returned without changing state, and the put-away resolver
// dropped query errors and reported a miss.
//
// These are source-wiring assertions, not a reimplementation: if a future edit
// removes the bound/timeout, the retry control, or the query-error branch, the
// exact field failure comes back and this suite fails.

const root = path.resolve(process.cwd(), '../..');

function read(rel: string): string {
  return readFileSync(path.join(root, rel), 'utf8');
}

describe('#770 role check is bounded and recoverable', () => {
  const source = read('packages/supabase-client/src/operator-role.ts');

  it('runs the role check through the bounded retry helper', () => {
    expect(source).toContain('runWithRetry(');
    expect(source).toContain('attemptRoleCheck(attempt, signal');
    expect(source).toContain('attempts: ROLE_CHECK_ATTEMPTS');
    expect(source).toContain('timeoutMs: ROLE_CHECK_TIMEOUT_MS');
    expect(source).toContain('signal: controller.signal');
  });

  it('bounds a hung request instead of awaiting it forever', () => {
    expect(source).toContain('ROLE_CHECK_TIMEOUT_MS = 8_000');
    expect(source).toContain('.abortSignal(signal)');
    expect(source).toContain('controller.abort()');
  });

  it('surfaces an error state with a retry action instead of staying on loading', () => {
    expect(source).toContain("kind: 'error'");
    expect(source).toContain('retry: () => {');
    expect(source).toContain('setRetryToken((n) => n + 1)');
    expect(source).toContain('ROLE_ERROR_MESSAGE');
  });

  it('still fails open once a staff role was established', () => {
    expect(source).toContain(
      'shouldKeepPriorRoleOnFailure(prior.kind, priorUserId, observedUserId)',
    );
  });

  it('updates the state ref synchronously so a refresh cannot capture stale prior state', () => {
    const apply = source.indexOf('function applyState(next: OperatorRoleState)');
    const refAssign = source.indexOf('stateRef.current = next;');
    const setCall = source.indexOf('setState(next);');
    expect(apply).toBeGreaterThan(-1);
    expect(refAssign).toBeGreaterThan(apply);
    expect(setCall).toBeGreaterThan(refAssign);
  });

  it('binds the observed user to the winning attempt, not a late callback', () => {
    expect(source).toContain('gate.getIdentity()');
    expect(source).toContain('gate.setIdentity(');
    expect(source).toContain('observedUserFromError(result.error)');
    // A timed-out/abandoned attempt must not be able to write identity later.
    expect(source).not.toContain('onUser');
    expect(source).not.toContain('observedUserId = userId;');
  });

  it('routes every lookup result through a sign-out-aware gate', () => {
    expect(source).toContain('new RoleCheckArbiter()');
    expect(source).toContain('const token = gate.begin();');
    expect(source).toContain('gate.commit(token, () => {');
    expect(source).toContain('gate.invalidate();');
    expect(source).toContain('gate.dispose();');
  });

  it('invalidates the prior role immediately on sign-out or an account switch', () => {
    expect(source).toContain("if (event === 'SIGNED_OUT')");
    expect(source).toContain('eventUserId !== establishedUserId');
    expect(source).toContain("applyState({ kind: 'loading' })");
    expect(source).toContain("applyState({ kind: 'unauthenticated' })");
  });
});

describe('#770 RED TEAM HIGH 1: a late lookup cannot restore a signed-out role', () => {
  it('refuses a held initial success and refresh failure after SIGNED_OUT', () => {
    const gate = new RoleCheckArbiter();
    const applied: string[] = [];

    // Initial mount lookup and a later refresh are both in flight.
    const initial = gate.begin();
    const refresh = gate.begin();

    // The user signs out before either resolves.
    gate.invalidate();
    expect(gate.isSignedOut).toBe(true);
    expect(gate.getIdentity()).toBeNull();

    // A held SUCCESS resolving after sign-out must not write rendered state.
    expect(gate.commit(initial, () => applied.push('initial'))).toBe(false);
    // Nor may a held FAILURE overwrite the unauthenticated state.
    expect(gate.commit(refresh, () => applied.push('refresh'))).toBe(false);

    expect(applied).toEqual([]);
    expect(gate.getIdentity()).toBeNull();
    expect(gate.isSignedOut).toBe(true);
  });

  it('stays unauthenticated until a new sign-in begins a fresh lookup', () => {
    const gate = new RoleCheckArbiter();
    const beforeSignOut = gate.begin();
    gate.invalidate();

    // A brand-new sign-in opens a new request sequence.
    const afterSignIn = gate.begin();
    expect(gate.isCurrent(afterSignIn)).toBe(true);
    expect(gate.commit(afterSignIn, () => gate.setIdentity('user-b'))).toBe(true);
    expect(gate.getIdentity()).toBe('user-b');

    // The pre-sign-out lookup is still stale and cannot overwrite it.
    expect(gate.commit(beforeSignOut, () => gate.setIdentity('user-a'))).toBe(false);
    expect(gate.getIdentity()).toBe('user-b');
  });

  it('lets a newer refresh supersede an older lookup', () => {
    const gate = new RoleCheckArbiter();
    const older = gate.begin();
    const newer = gate.begin();

    expect(gate.commit(older, () => gate.setIdentity('stale'))).toBe(false);
    expect(gate.commit(newer, () => gate.setIdentity('fresh'))).toBe(true);
    expect(gate.getIdentity()).toBe('fresh');
  });

  it('drops the previous identity on an account switch', () => {
    const gate = new RoleCheckArbiter();
    gate.begin();
    gate.setIdentity('user-a');

    gate.clearIdentity();
    expect(gate.getIdentity()).toBeNull();
    // The switch does not itself sign out; the new user's check may apply.
    expect(gate.isSignedOut).toBe(false);
  });

  it('refuses a late result after unmount/dispose', () => {
    const gate = new RoleCheckArbiter();
    const token = gate.begin();

    gate.dispose();

    expect(gate.commit(token, () => {
      throw new Error('a disposed lookup must not apply');
    })).toBe(false);
    expect(gate.getIdentity()).toBeNull();
  });
});

describe('#770 failed role check never inherits another account staff role', () => {
  it('keeps staff for the same user during a transient refresh failure', () => {
    expect(shouldKeepPriorRoleOnFailure('staff', 'user-a', 'user-a')).toBe(true);
  });

  it('drops staff when the signed-in account changed', () => {
    expect(shouldKeepPriorRoleOnFailure('staff', 'user-a', 'user-b')).toBe(false);
  });

  it('fails open when the session read itself failed (user unknown)', () => {
    expect(shouldKeepPriorRoleOnFailure('staff', 'user-a', null)).toBe(true);
  });

  it('never keeps a role that was not established', () => {
    expect(shouldKeepPriorRoleOnFailure('loading', null, 'user-a')).toBe(false);
    expect(shouldKeepPriorRoleOnFailure('error', 'user-a', 'user-a')).toBe(false);
  });
});

describe('#770 put-away distinguishes a failed lookup from a real miss', () => {
  const screen = read('apps/field-mobile/app/(staff)/put-away/single.tsx');

  it('passes the resolver query-error handler', () => {
    expect(screen).toContain('onQueryError: (message) => {');
    expect(screen).toContain('lookupError = message');
  });

  it('records the external_code fallback query error', () => {
    expect(screen).toContain('if (r.error) throw r.error;');
  });

  it('does not use the external_code alias after a canonical lookup error', () => {
    const guard = screen.indexOf('if (!data && !lookupError) {');
    const external = screen.indexOf(".eq('external_code', id)");
    expect(guard).toBeGreaterThan(-1);
    expect(external).toBeGreaterThan(guard);
  });

  it('fails the whole lookup when any probe fails, instead of trusting a partial row', () => {
    expect(screen).toContain('failClosed: true');
    const resolver = read('apps/field-mobile/lib/resolve-lot-scan.ts');
    expect(resolver).toContain('failClosed?: boolean;');
    expect(resolver).toContain('if (opts?.failClosed) throw new Error(message);');
  });

  it('suppresses the same failing label instead of re-alerting every debounce', () => {
    expect(screen).toContain('connectionErrorRef');
    expect(screen).toContain('CONNECTION_ERROR_COOLDOWN_MS');
    expect(screen).toContain('Retry');
    // Deliberate retry clears the suppression; a different code clears it too.
    expect(screen).toContain('connectionErrorRef.current = null;');
    expect(screen).toContain('connectionErrorRef.current = {');
  });

  it('keeps Retry reachable and bounds a same-label re-aim', () => {
    // Retry lives in a persistent banner, not only in a transient alert.
    expect(screen).toContain('setConnectionError({');
    expect(screen).toContain('{connectionError && (');
    expect(screen).toContain('void resolveLot(retryId);');
    // Dismiss starts a short cooldown; it does not suppress forever.
    expect(screen).toContain('now - connectionFailed.at < CONNECTION_ERROR_COOLDOWN_MS');
    expect(screen).toContain('value: connectionError.rawIdentifier');
  });

  it('bounds a hung lookup and aborts the underlying queries', () => {
    expect(screen).toContain('timeoutMs: LOOKUP_TIMEOUT_MS');
    expect(screen).toContain('LOOKUP_TIMEOUT_MS = 12_000');
    const resolver = read('apps/field-mobile/lib/resolve-lot-scan.ts');
    expect(resolver).toContain('signal?: AbortSignal;');
    expect(resolver).toContain('query = query.abortSignal(opts.signal);');
  });

  it('does not silently lock out a rescan after a connection error', () => {
    const failedStart = screen.indexOf('if (lookupError) {');
    const notFoundStart = screen.indexOf("'Lot not found'");
    expect(failedStart).toBeGreaterThan(-1);
    expect(notFoundStart).toBeGreaterThan(failedStart);
    expect(screen.slice(failedStart, notFoundStart)).not.toContain('notFoundRef.current');
  });

  it('shows a connection failure before it can claim the lot is missing', () => {
    const failedLookup = screen.indexOf('if (lookupError) {');
    const notFound = screen.indexOf("'Lot not found'");
    expect(failedLookup).toBeGreaterThan(-1);
    expect(notFound).toBeGreaterThan(-1);
    expect(failedLookup).toBeLessThan(notFound);
    expect(screen).toContain("Can't reach the server");
  });
});

describe('#770 staff layout renders a retry screen for a failed role check', () => {
  const layout = read('apps/field-mobile/app/(staff)/_layout.tsx');

  it('handles the error kind before the not-staff fallthrough', () => {
    const errorBranch = layout.indexOf("if (role.kind === 'error')");
    const notStaff = layout.indexOf("if (role.kind !== 'staff')");
    expect(errorBranch).toBeGreaterThan(-1);
    expect(notStaff).toBeGreaterThan(-1);
    expect(errorBranch).toBeLessThan(notStaff);
  });

  it('offers the retry callback to staff', () => {
    expect(layout).toContain('onPress={role.retry}');
    expect(layout).toContain('Retry');
  });
});
