/**
 * When the photo screen may write (or clear) its persisted draft.
 *
 * The screen mounts empty: phase 'camera', no hero, no editable. Its save
 * effect fires on mount with `null`, and the draft store debounces for 800ms
 * before removing the key. If sign-in is still loading — or the saved draft
 * belongs to another operator and recovery has refused to touch it — that
 * debounced `null` deletes the created-lot recovery record and the references
 * to photos that never reached the durable queue (RED TEAM #683 HIGH).
 *
 * The writer therefore stays shut until the screen has read the stored draft
 * and decided what to do with it:
 *
 *   loading  — role (or the read itself) is not settled; do not touch storage
 *   preserve — the draft is deliberately kept (owner mismatch/unknown, or the
 *              restore prompt is still unanswered); never overwrite or delete
 *   open     — normal operation: keep a review/creating draft, clear otherwise
 *
 * Keeping this decision pure lets the lifecycle be tested without a device.
 */
import type { DraftRecoveryDecision } from './draft-recovery';

export type DraftWriteGate = 'loading' | 'preserve' | 'open';

export function gateAfterDraftLoad(decision: DraftRecoveryDecision): DraftWriteGate {
  switch (decision.action) {
    case 'wait':
      return 'loading';
    case 'blocked':
      return 'preserve';
    case 'offer':
      return 'preserve';
    case 'finish':
    case 'none':
      return 'open';
  }
}

export function mayWriteDraft(gate: DraftWriteGate): boolean {
  return gate === 'open';
}

/**
 * Whether the screen may start capturing a new item.
 *
 * A capture that cannot be persisted is not just lost on a kill: while the
 * stored draft is still being read (or a recovery is being offered), a new
 * item captured behind the closed writer can be overwritten the moment the
 * older record is restored (RED TEAM #744 HIGH). Starting a new item is
 * therefore only safe once the gate is open.
 */
export function mayStartNewItem(gate: DraftWriteGate): boolean {
  return gate === 'open';
}

/**
 * Where a blocked draft came from.
 *
 * `recovery` is a per-lot archive written by "Scan another item"; `main` is the
 * ordinary single draft key the screen itself writes.
 */
export type BlockedDraftSource = 'recovery' | 'main';

/**
 * Whether the operator may explicitly skip a blocked draft and start
 * independent work.
 *
 * A foreign or legacy ownerless *archive* must not disable capture forever: the
 * operator can dismiss it and start a new item, while the archive itself is
 * never resolved, rewritten or deleted (RED TEAM #747). A blocked *main* draft
 * cannot be skipped the same way — opening the writer would clear the very
 * record we refused to touch — so it stays preserved until its owner signs in
 * or the lot is opened in Inventory.
 */
export function maySkipBlockedDraft(source: BlockedDraftSource): boolean {
  return source === 'recovery';
}

/** The gate after an explicit, non-destructive skip. */
export function gateAfterBlockedSkip(): DraftWriteGate {
  return 'open';
}
