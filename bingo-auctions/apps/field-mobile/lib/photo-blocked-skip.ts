/**
 * The lifecycle of the blocked-archive skip prompt inside one mount.
 *
 * A blocked foreign/legacy *archive* must not disable capture forever: the
 * operator can start a new item while the archive is left untouched
 * (RED TEAM #747). But the first alert also offers "Not now", and dismissing
 * it used to remove the only way to make that decision — the already-offered
 * guard stopped a same-mount re-prompt, so capture stayed disabled until a
 * remount (RED TEAM #752 MEDIUM).
 *
 * The dismissal therefore does not end the decision: it moves the prompt to a
 * persistent banner that can reopen the same choice until the operator either
 * resolves it or explicitly skips. A blocked *main* draft never enters this
 * flow, because opening its writer would clear the record we refused to touch.
 */
import type { DraftRecoveryDecision } from './draft-recovery';
import {
  gateAfterBlockedSkip,
  maySkipBlockedDraft,
  type BlockedDraftSource,
  type DraftWriteGate,
} from './photo-draft-gate';

export type BlockedSkipReason = Extract<DraftRecoveryDecision, { action: 'blocked' }>['reason'];

export type BlockedSkipFlow =
  | { kind: 'none' }
  | { kind: 'prompt'; reason: BlockedSkipReason }
  | { kind: 'dismissed'; reason: BlockedSkipReason }
  | { kind: 'skipped'; reason: BlockedSkipReason };

/** The initial flow for a load decision. Only a skippable archive prompts. */
export function blockedSkipFlowFor(
  decision: DraftRecoveryDecision,
  source: BlockedDraftSource,
): BlockedSkipFlow {
  if (decision.action !== 'blocked') return { kind: 'none' };
  if (!maySkipBlockedDraft(source)) return { kind: 'none' };
  return { kind: 'prompt', reason: decision.reason };
}

/** "Not now": keep the choice, move it to the persistent banner. */
export function dismissBlockedSkip(flow: BlockedSkipFlow): BlockedSkipFlow {
  return flow.kind === 'prompt' ? { kind: 'dismissed', reason: flow.reason } : flow;
}

/** Reopen the alert from the banner without touching the archive. */
export function reopenBlockedSkip(flow: BlockedSkipFlow): BlockedSkipFlow {
  return flow.kind === 'dismissed' ? { kind: 'prompt', reason: flow.reason } : flow;
}

/** The explicit skip that opens the screen's own writer for independent work. */
export function skipBlockedArchive(flow: BlockedSkipFlow): BlockedSkipFlow {
  return flow.kind === 'prompt' || flow.kind === 'dismissed'
    ? { kind: 'skipped', reason: flow.reason }
    : flow;
}

/** Whether the persistent "reopen the choice" banner should be shown. */
export function blockedSkipBannerVisible(flow: BlockedSkipFlow): boolean {
  return flow.kind === 'dismissed';
}

export const BLOCKED_SKIP_TITLE = 'Saved lot belongs to another sign-in';

export function blockedSkipMessage(reason: BlockedSkipReason): string {
  return reason === 'owner_mismatch'
    ? 'This saved lot and its photos were captured by a different staff sign-in. I left them untouched so they cannot upload into the wrong account. Sign back in as the original operator, open the lot in Inventory, or start a new item.'
    : 'This saved lot was created before the app recorded which operator captured it, so I cannot confirm these photos are yours. I left them untouched. Sign in as the operator who made the lot, open it in Inventory, or start a new item.';
}

type SetBlockedSkipFlow = (updater: (flow: BlockedSkipFlow) => BlockedSkipFlow) => void;

type BlockedSkipScreenActions = {
  setFlow: SetBlockedSkipFlow;
  /** Open the screen's own draft writer without touching the saved archive. */
  openWriter: () => void;
};

/**
 * The screen's real writer step for an explicit skip: open the gate so the
 * ordinary draft persistence effect may save the operator's new item. Shared
 * with the tests so mutating (or removing) the screen's writer fails the
 * committed skip cases (RED TEAM #760).
 */
export function openWriterForBlockedSkip(setGate: (gate: DraftWriteGate) => void): void {
  setGate(gateAfterBlockedSkip());
}

/**
 * The exact alert wiring the screen hands to `Alert.alert`, kept here so the
 * callbacks can be tested without a device. Both dismissal paths ("Not now"
 * and Android back/outside) move the flow to `dismissed`; "Start a new item"
 * opens the writer and marks the flow `skipped`.
 */
export function blockedSkipAlert(reason: BlockedSkipReason, actions: BlockedSkipScreenActions) {
  const dismiss = () => actions.setFlow((flow) => dismissBlockedSkip(flow));
  const startNew = () => {
    actions.openWriter();
    actions.setFlow((flow) => skipBlockedArchive(flow));
  };
  return {
    title: BLOCKED_SKIP_TITLE,
    message: blockedSkipMessage(reason),
    buttons: [
      { text: 'Not now', style: 'cancel' as const, onPress: dismiss },
      { text: 'Start a new item', onPress: startNew },
    ],
    options: { cancelable: true, onDismiss: dismiss },
  };
}

export type BlockedSkipAlertPayload = ReturnType<typeof blockedSkipAlert>;

export type BlockedSkipScreenWiring = {
  setFlow: SetBlockedSkipFlow;
  setGate: (gate: DraftWriteGate) => void;
  /** Present the alert on the device (`Alert.alert(...)` in the screen). */
  present: (alert: BlockedSkipAlertPayload) => void;
};

/**
 * The production composition of the blocked-skip alert/banner and the writer
 * step. `photo.tsx` builds this once and the committed tests drive the same
 * object, so disconnecting a production binding fails the suite instead of a
 * test-local reimplementation staying green (RED TEAM #762).
 */
export function createBlockedSkipScreen(actions: BlockedSkipScreenWiring) {
  const openWriter = () => openWriterForBlockedSkip(actions.setGate);

  const alertFor = (reason: BlockedSkipReason): BlockedSkipAlertPayload => {
    const alert = blockedSkipAlert(reason, {
      setFlow: actions.setFlow,
      openWriter,
    });
    actions.present(alert);
    return alert;
  };

  const bannerFor = (flow: BlockedSkipFlow) => {
    if (flow.kind !== 'dismissed') return null;
    return blockedSkipBannerActions(flow.reason, {
      setFlow: actions.setFlow,
      openWriter,
      reopenAlert: (reason) => {
        alertFor(reason);
      },
    });
  };

  return { openWriter, alertFor, bannerFor };
}

/** The banner's two handlers, shared with the screen's Pressables. */
export function blockedSkipBannerActions(
  reason: BlockedSkipReason,
  actions: BlockedSkipScreenActions & {
    /** Re-show the alert after the flow moves back to `prompt`. */
    reopenAlert: (reason: BlockedSkipReason) => void;
  },
) {
  return {
    review: () => {
      actions.setFlow((flow) => reopenBlockedSkip(flow));
      actions.reopenAlert(reason);
    },
    startNew: () => {
      actions.openWriter();
      actions.setFlow((flow) => skipBlockedArchive(flow));
    },
  };
}
