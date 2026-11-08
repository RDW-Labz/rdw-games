// Pre-call AI budget enforcement.
//
// Call checkAiBudget() BEFORE dispatching any OpenRouter request to enforce
// the operator's monthly AI spend cap. The cap is stored on operators.monthly_ai_budget_cents
// and enforced in check_operator_ai_budget() (migration 0085).
//
// If the operator is at or over budget, this throws 'ai_budget_exceeded'.
// The caller (route handler) catches this and returns 402.
//
// ANTICIPATED_COST_CENTS is a conservative pre-call estimate. Most calls are
// well under 50¢ (scan-photo: ~$0.02-0.05, shelf-scan: ~$0.03-0.06).
// We use 50 cents as a defensive upper bound so the cap check can say "if I
// add 50¢ to what we've spent, do I still fit in budget?" After the call
// completes and ai_calls.cost_cents is logged, the REAL cost is reflected in
// the next pre-call check — so the cap is enforced within one 50¢ window.

import { getSupabaseAdmin } from './supabase-admin';

export const ANTICIPATED_COST_CENTS = 50 as const;

export type BudgetCheckResult = {
  allowed: boolean;
  raw_cost_mtd_cents: number;
  billed_cost_mtd_cents: number;
  budget_cents: number;
  markup_bps: number;
  pct_used: number;
};

/**
 * Verifies the operator has remaining AI budget for this month.
 *
 * @throws {Error} with message 'ai_budget_exceeded' if over cap
 * @returns The budget state (useful for callers that want to surface usage).
 */
export async function checkAiBudget(
  operatorId: string,
  anticipatedCostCents: number = ANTICIPATED_COST_CENTS,
): Promise<BudgetCheckResult> {
  const admin = getSupabaseAdmin();

  const { data, error: budgetErr } = await admin.rpc('check_operator_ai_budget', {
    p_operator_id: operatorId,
    p_anticipated_cost_cents: anticipatedCostCents,
  });

  if (budgetErr) {
    // Log but do NOT block on telemetry failure — if the budget check RPC
    // itself is broken we should still allow the call (fail-open). The
    // platform absorbs the cost; we'd rather log the RPC issue than
    // silently block operators.
    console.error('[ai-budget] check_operator_ai_budget RPC failed:', budgetErr.message);
    return {
      allowed: true,
      raw_cost_mtd_cents: 0,
      billed_cost_mtd_cents: 0,
      budget_cents: 10000, // default $100
      markup_bps: 2500,
      pct_used: 0,
    };
  }

  const row = Array.isArray(data) ? (data[0] as BudgetCheckResult | undefined) : null;
  if (!row) {
    // No operator row found — shouldn't happen after auth, but fail-open.
    console.warn('[ai-budget] no row returned for operator', operatorId);
    return {
      allowed: true,
      raw_cost_mtd_cents: 0,
      billed_cost_mtd_cents: 0,
      budget_cents: 10000,
      markup_bps: 2500,
      pct_used: 0,
    };
  }

  if (!row.allowed) {
    throw new Error('ai_budget_exceeded');
  }

  return row;
}
