export { supabase, refreshSessionIfNeeded, getCurrentUserId } from './client';
export type { RefreshOutcome } from './client';
export { useSession, ensureBidderRow } from './session';
export { useRole } from './role';
export type { StaffRole, Role, RoleState } from './role';
export { useOperatorFeatures } from './operator-features';
export { useOperatorRole, hasOperatorRole, shouldKeepPriorRoleOnFailure } from './operator-role';
export { RoleCheckArbiter } from './operator-role-arbiter';
export type { RoleCheckToken } from './operator-role-arbiter';
export type { OperatorRole, OperatorRoleState } from './operator-role';
export { resolveOperatorIdForUpload } from './operator-upload-id';
export { useBidderRole } from './bidder-role';
export type { BidderRoleState } from './bidder-role';
export { track, setTracker } from './tracker';
export {
  submitFeedback,
  collectDiagnostics,
  listMyReports,
  unseenResolved,
  FEEDBACK_MIN_LENGTH,
  FEEDBACK_STATUS_LABEL,
} from './feedback';
export type {
  FeedbackApp,
  FeedbackKind,
  FeedbackDiagnostics,
  FeedbackAttachment,
  FeedbackReport,
  FeedbackStatus,
  SubmitFeedbackInput,
  SubmitFeedbackResult,
} from './feedback';
