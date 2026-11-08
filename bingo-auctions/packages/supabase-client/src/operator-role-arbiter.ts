// Sequence and identity arbitration for the operator-role gate (#770).
//
// RED TEAM #770 HIGH 1: an explicit sign-out cleared the rendered state but did
// not invalidate the request sequence, so an older initial or refresh lookup
// could resolve AFTER `SIGNED_OUT` and restore the previous staff/admin UI.
//
// Every role lookup now receives a token from this arbiter and may write state
// only through `commit(token, apply)`. Signing out bumps the sequence and drops
// the bound identity, so every in-flight lookup becomes permanently stale —
// including one that succeeds later. A new sign-in must call `begin()` again
// before any result can apply.
//
// Kept free of React and Supabase so the exact sign-out/refresh ordering can be
// exercised without mounting the hook.

export type RoleCheckToken = number;

export class RoleCheckArbiter {
  private seq = 0;
  private identity: string | null = null;
  private signedOut = false;

  /**
   * Start a lookup. Bumps the sequence so every earlier in-flight lookup is
   * stale, and clears the signed-out latch for the new session.
   */
  begin(): RoleCheckToken {
    this.signedOut = false;
    this.seq += 1;
    return this.seq;
  }

  /** Whether `token` still owns the gate and no sign-out has intervened. */
  isCurrent(token: RoleCheckToken): boolean {
    return !this.signedOut && token === this.seq;
  }

  /**
   * Run `apply` only when `token` still owns the gate. Returns whether it ran,
   * so a late success/failure writes nothing after sign-out or a newer check.
   */
  commit(token: RoleCheckToken, apply: () => void): boolean {
    if (!this.isCurrent(token)) return false;
    apply();
    return true;
  }

  /**
   * Explicit sign-out: no identity survives and no in-flight lookup may apply.
   * The sequence bump makes even a successful late result stale.
   */
  invalidate(): void {
    this.seq += 1;
    this.signedOut = true;
    this.identity = null;
  }

  /** Account switch: drop the previous identity but keep accepting the new check. */
  clearIdentity(): void {
    this.identity = null;
  }

  /**
   * Effect teardown (unmount or a Retry re-run). No lookup started under this
   * arbiter may apply after it is disposed; the next effect creates a new one.
   */
  dispose(): void {
    this.invalidate();
  }

  setIdentity(userId: string | null): void {
    this.identity = userId;
  }

  getIdentity(): string | null {
    return this.identity;
  }

  get isSignedOut(): boolean {
    return this.signedOut;
  }
}
