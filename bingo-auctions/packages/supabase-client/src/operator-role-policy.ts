// Pure decisions for the operator-role gate (#770).
//
// Kept in its own module (no React, no Supabase client) so the fail-open rules
// can be exercised directly in unit tests instead of only asserted against the
// hook's source text.

import type { OperatorRoleState } from './operator-role';

/**
 * Whether a failed role check may keep the previously established staff role.
 *
 * Only the same auth user — or an unknown user, when the local session read
 * itself failed — may fail open. A different account must not inherit the
 * previous staff identity just because its own role query also failed.
 */
export function shouldKeepPriorRoleOnFailure(
  priorKind: OperatorRoleState['kind'],
  priorUserId: string | null,
  observedUserId: string | null,
): boolean {
  if (priorKind !== 'staff') return false;
  return observedUserId === null || observedUserId === priorUserId;
}
