// scripts/mega-sim/personas/ai_budget.js
//
// Persona: verifies check_operator_ai_budget() cap enforcement.
//
// Tests:
//   1. Read baseline: monthly_ai_budget_cents=10000 ($100), markup=2500bps (25%)
//   2. Set budget to 1 cent → call with 100c anticipated → allowed=false
//   3. Restore budget → call with 100c anticipated → allowed=true
//   4. Insert fake ai_calls row at 9000 cents MTD cost
//      Call with 200c anticipated:
//        projected raw  = 9000 + 200 = 9200 cents
//        projected billed = 9200 * 1.25 = 11500 cents > 10000 cap
//        → allowed=false
//   5. Verify pct_used is in range (80–100% since 9000 raw * 1.25 = 11250 > 10000)
//      Actually pct_used = billed_mtd / budget = (9000 * 1.25) / 10000 = 11250/10000
//      pct_used is capped at 100 per migration 0085 (LEAST(100, ...))
//      So pct_used should be 100.00 after the fake row is inserted.
//   6. Cleanup: delete fake ai_calls row

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');

async function run({ ctx }) {
  setPhase('AI Budget');

  if (!ctx.operatorId) {
    await step('prereq: operatorId present', async () => {
      expect(false).toBeTruthy('ctx.operatorId missing — operator setup failed');
    });
    return;
  }

  let fakeAiCallId = null;

  // ── 1. Read baseline operator AI billing config ────────────────────────────
  await step('operator has monthly_ai_budget_cents=10000 + markup_bps=2500', async () => {
    const { value } = await time('supa.select.operators.aiConfig', () =>
      supa.supaSelect(
        null,
        'operators',
        'id=eq.' + ctx.operatorId,
        'monthly_ai_budget_cents,ai_billing_markup_bps',
        true,
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.length).toBe(1);
    const op = value.data[0];
    console.log(
      '      [ai_budget] budget=' + op.monthly_ai_budget_cents +
      ' markup_bps=' + op.ai_billing_markup_bps,
    );
    // Defaults from migration 0085 column definitions.
    expect(op.monthly_ai_budget_cents).toBe(10000);
    expect(op.ai_billing_markup_bps).toBe(2500);
  });

  // ── 2. Set budget to 1 cent → any call is over cap ────────────────────────
  await step('set monthly_ai_budget_cents = 1 (floor)', async () => {
    const { value } = await time('supa.update.operators.budgetTo1', () =>
      supa.supaUpdate(
        null,
        'operators',
        'id=eq.' + ctx.operatorId,
        { monthly_ai_budget_cents: 1 },
        true,
      ),
    );
    expect(value.error).toBeNull();
  });

  await step('check_operator_ai_budget with 1-cent budget + 100c anticipated → allowed=false', async () => {
    const { value } = await time('rpc.check_operator_ai_budget.over_cap', () =>
      supa.supaRpc(null, 'check_operator_ai_budget', {
        p_operator_id: ctx.operatorId,
        p_anticipated_cost_cents: 100,
      }, true),
    );
    expect(value.error).toBeNull();
    // The RPC returns a TABLE (one row). Supabase REST surfaces it as an array.
    const row = Array.isArray(value.data) ? value.data[0] : value.data;
    expect(row).toBeTruthy('check_operator_ai_budget returned a row');
    console.log('      [ai_budget] over-cap row: allowed=' + row.allowed + ' pct_used=' + row.pct_used);
    expect(row.allowed).toBe(false);
  });

  // ── 3. Restore budget to $100 → 100-cent call allowed ─────────────────────
  await step('restore monthly_ai_budget_cents = 10000', async () => {
    const { value } = await time('supa.update.operators.budgetRestore', () =>
      supa.supaUpdate(
        null,
        'operators',
        'id=eq.' + ctx.operatorId,
        { monthly_ai_budget_cents: 10000 },
        true,
      ),
    );
    expect(value.error).toBeNull();
  });

  await step('check_operator_ai_budget with $100 budget + 100c anticipated → allowed=true', async () => {
    const { value } = await time('rpc.check_operator_ai_budget.under_cap', () =>
      supa.supaRpc(null, 'check_operator_ai_budget', {
        p_operator_id: ctx.operatorId,
        p_anticipated_cost_cents: 100,
      }, true),
    );
    expect(value.error).toBeNull();
    const row = Array.isArray(value.data) ? value.data[0] : value.data;
    expect(row).toBeTruthy('check_operator_ai_budget returned a row');
    console.log('      [ai_budget] under-cap row: allowed=' + row.allowed + ' pct_used=' + row.pct_used);
    expect(row.allowed).toBe(true);
    // With $0 MTD, pct_used should be 0.
    expect(parseFloat(row.pct_used)).toBe(0);
  });

  // ── 4. Insert fake ai_calls row at 9000 cents MTD cost ────────────────────
  // After insert: raw MTD = 9000 cents
  // Billed MTD = 9000 * 1.25 = 11250 cents > 10000 budget
  // Anticipated 200 → projected raw = 9200 → billed = 11500 > 10000 → blocked
  await step('insert fake ai_calls row (9000 cents cost)', async () => {
    const { value } = await time('supa.insert.ai_calls.fake', () =>
      supa.supaInsert(
        null,
        'ai_calls',
        {
          operator_id: ctx.operatorId,
          // user_id is NOT NULL — use the operator admin as a stand-in.
          user_id: ctx.adminUserId,
          task: 'sim-budget-test',
          model: 'sim/fake-model',
          input_tokens: 100,
          output_tokens: 50,
          cost_cents: 9000,
          // created_at defaults to now() — no need to set it for current-month MTD
        },
        true,
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.id).toBeTruthy('fake ai_calls row created');
    fakeAiCallId = value.data.id;
    console.log('      [ai_budget] inserted fake ai_calls id=' + fakeAiCallId);
  });

  await step('check_operator_ai_budget: $90 MTD + $2 anticipated → billed $115 > $100 cap → allowed=false', async () => {
    const { value } = await time('rpc.check_operator_ai_budget.near_cap', () =>
      supa.supaRpc(null, 'check_operator_ai_budget', {
        p_operator_id: ctx.operatorId,
        p_anticipated_cost_cents: 200,
      }, true),
    );
    expect(value.error).toBeNull();
    const row = Array.isArray(value.data) ? value.data[0] : value.data;
    expect(row).toBeTruthy('check_operator_ai_budget returned a row');
    console.log(
      '      [ai_budget] near-cap row: allowed=' + row.allowed +
      ' raw_mtd=' + row.raw_cost_mtd_cents +
      ' billed_mtd=' + row.billed_cost_mtd_cents +
      ' pct_used=' + row.pct_used,
    );
    // projected billed = (9000 + 200) * 1.25 = 11500 > 10000 → blocked
    expect(row.allowed).toBe(false);
    // Raw MTD should reflect the 9000-cent fake row.
    expect(parseInt(row.raw_cost_mtd_cents, 10)).toBe(9000);
  });

  // ── 5. Verify pct_used is capped at 100 ───────────────────────────────────
  // billed_mtd = 9000 * 1.25 = 11250 > 10000 budget
  // pct_used = LEAST(100, 11250/10000 * 100) = LEAST(100, 112.5) = 100.00
  await step('pct_used is 100.00 (capped) when billed MTD exceeds budget', async () => {
    const { value } = await time('rpc.check_operator_ai_budget.pct_used_cap', () =>
      supa.supaRpc(null, 'check_operator_ai_budget', {
        p_operator_id: ctx.operatorId,
        p_anticipated_cost_cents: 0,
      }, true),
    );
    expect(value.error).toBeNull();
    const row = Array.isArray(value.data) ? value.data[0] : value.data;
    expect(row).toBeTruthy('check_operator_ai_budget returned a row');
    const pct = parseFloat(row.pct_used);
    console.log('      [ai_budget] pct_used=' + pct + ' (expected 100.00)');
    expect(pct).toBe(100);
  });

  // ── 6. Cleanup: delete fake ai_calls row ──────────────────────────────────
  if (fakeAiCallId) {
    await step('cleanup: delete fake ai_calls row', async () => {
      const { value } = await time('supa.delete.ai_calls.fake', () =>
        supa.supaDelete(null, 'ai_calls', 'id=eq.' + fakeAiCallId, true),
      );
      expect(value.error).toBeNull();
    });
  }
}

module.exports = { run };
