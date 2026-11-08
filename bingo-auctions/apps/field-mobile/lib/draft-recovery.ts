/**
 * Deciding what to do with a persisted lotting draft.
 *
 * The app can restore a draft before the operator role has loaded. The old
 * code marked the draft "offered" on the first pass and then gave up when the
 * role was still loading, so a saved lot never got its queued photos
 * (RED TEAM #683). A decision of `wait` leaves the draft untouched so the
 * screen can try again when the role resolves.
 */
export type SavedPhotoDraft = {
  editable: unknown;
  created?: { lotId: string; lotCode: string } | null;
  /**
   * The operator who captured the draft. A persisted draft can be restored in
   * a process signed in as someone else (shared warehouse tablet), and the old
   * recovery uploaded its photos under the CURRENT operator's namespace.
   */
  operatorId?: string;
};

export type DraftRecoveryDecision =
  | { action: 'none' }
  | { action: 'wait' }
  | { action: 'offer' }
  | { action: 'finish'; operatorId: string }
  | { action: 'blocked'; reason: 'owner_unknown' | 'owner_mismatch' };

type RoleLike = { kind: string; operatorId?: string };

export function decideDraftRecovery(
  saved: SavedPhotoDraft | null | undefined,
  role: RoleLike,
): DraftRecoveryDecision {
  if (!saved?.editable) return { action: 'none' };
  if (saved.created) {
    if (role.kind !== 'staff' || !role.operatorId) return { action: 'wait' };
    // Never upload a queued photo under a different operator (RED TEAM #683
    // HIGH). Older drafts carry no owner, so ownership cannot be verified and
    // the same rule applies: leave everything untouched.
    if (!saved.operatorId) return { action: 'blocked', reason: 'owner_unknown' };
    if (saved.operatorId !== role.operatorId) {
      return { action: 'blocked', reason: 'owner_mismatch' };
    }
    return { action: 'finish', operatorId: role.operatorId };
  }
  return { action: 'offer' };
}
