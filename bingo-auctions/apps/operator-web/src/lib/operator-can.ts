// Staff Role Matrix — TypeScript twin of the SQL operator_role_can() gate
// (migration 0205). Lets operator-web routes/RSCs ask the SAME question the DB
// asks, instead of hardcoding role lists like `staff.role !== 'admin'`.
//
// PHASE 1: not yet wired anywhere. Phase 2 replaces the scattered inline role
// checks (see docs/security/ROLE-MATRIX-PLAN-2026-06-13.md §2) with operatorCan().
//
// Pass the REQUEST-SCOPED server client (the operator's own session), so
// current_operator_role() inside the function resolves to the calling user.
// Do NOT pass the service-role admin client — it has no auth.uid() and the gate
// would always deny.

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A capability verb from the role matrix (migration 0205 seed). Keep in sync
 * with the operator_role_capabilities table.
 */
export type OperatorCapability =
  | 'inventory.intake'
  | 'inventory.putaway'
  | 'inventory.lot'
  | 'inventory.dispose'
  | 'pickup.verify'
  | 'pickup.sign'
  | 'pickup.manual_checkout'
  | 'checkout.take_payment'
  | 'payment.mark_paid_offline'
  | 'refund.in_window'
  | 'refund.override'
  | 'auction.publish'
  | 'auction.cancel'
  | 'audit.view'
  | 'settings.edit'
  | 'policy.edit'
  | 'staff.manage'
  | 'payouts.manage';

/**
 * Returns true if the calling operator user's role grants `capability`.
 *
 * Fail-CLOSED: any error (RPC failure, no session, missing function) → false.
 * This is a permission gate — a glitch must DENY, never silently allow. (Note:
 * this is the opposite default from isPaymentsDisabled(),
 * which fail-open to normal charging because a glitch there must not stop money.)
 */
export async function operatorCan(
  supabase: SupabaseClient,
  capability: OperatorCapability,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('operator_role_can', {
      p_capability: capability,
    });
    if (error) {
      console.warn(`[operator-can] ${capability} check failed, denying:`, error.message);
      return false;
    }
    return data === true;
  } catch (err) {
    console.warn(
      `[operator-can] ${capability} check threw, denying:`,
      (err as Error)?.message,
    );
    return false;
  }
}
