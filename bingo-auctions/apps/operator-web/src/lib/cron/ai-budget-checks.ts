// AI budget threshold alerting cron.
//
// Runs every 30 minutes. For each active operator:
//   - Calls check_operator_ai_budget (migration 0085) to get pct_used
//   - Fires notifications_outbox rows at 50%, 80%, and 100% thresholds
//   - At 100% the message is "calls are blocked" severity
//   - Idempotency keys prevent duplicate notifications per threshold per month
//
// Also logs an hourly Sentry event with aggregate spend so the platform
// owner can wire Sentry alert rules for $5/hr (email) and $20/hr (page).
//
// Sentry alert setup (do this in dashboard):
//   Alert on events with tag metric=ai_hourly_spend:
//     level=warning → email alert (fires when hourlyCents > 500, i.e. > $5/hr)
//     level=error   → page alert  (fires when hourlyCents > 2000, i.e. > $20/hr)

import * as Sentry from '@sentry/nextjs';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export type AiBudgetChecksResult = {
  operatorsChecked: number;
  notificationsSent: number;
  errors: number;
  hourlyCents: number;
};

type BudgetRow = {
  allowed: boolean;
  raw_cost_mtd_cents: number;
  billed_cost_mtd_cents: number;
  budget_cents: number;
  markup_bps: number;
  pct_used: number;
};

type OperatorRow = {
  id: string;
};

type OperatorAdminRow = {
  operator_id: string;
  user_id: string;
};

export async function runAiBudgetChecks(): Promise<AiBudgetChecksResult> {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Fetch all active operators. We check every operator every 30 min;
  // operators with zero AI usage just get allowed=true with pct_used=0
  // from the RPC — cheap and correct.
  const { data: operators, error: opErr } = await supabase
    .from('operators')
    .select('id')
    .returns<OperatorRow[]>();

  if (opErr) {
    console.error('[ai-budget-checks] operators select failed:', opErr.message);
    return { operatorsChecked: 0, notificationsSent: 0, errors: 1, hourlyCents: 0 };
  }

  if (!operators || operators.length === 0) {
    return { operatorsChecked: 0, notificationsSent: 0, errors: 0, hourlyCents: 0 };
  }

  let notificationsSent = 0;
  let errors = 0;
  let totalBilledCents = 0;

  // Pre-fetch admin user IDs for all operators in a single query so we
  // can target notifications correctly. notifications_outbox.target_user_id
  // is NOT NULL — we need a real user ID to notify.
  const { data: adminUsers } = await supabase
    .from('operator_users')
    .select('operator_id, user_id')
    .eq('role', 'admin')
    .returns<OperatorAdminRow[]>();

  // Build a map of operatorId → first admin user_id
  const adminByOperator = new Map<string, string>();
  for (const row of adminUsers ?? []) {
    if (!adminByOperator.has(row.operator_id)) {
      adminByOperator.set(row.operator_id, row.user_id);
    }
  }

  for (const op of operators) {
    try {
      const { data: budgetData, error: budgetErr } = await supabase.rpc(
        'check_operator_ai_budget',
        { p_operator_id: op.id, p_anticipated_cost_cents: 0 },
      );

      if (budgetErr) {
        console.error(
          `[ai-budget-checks] RPC failed for operator ${op.id}:`,
          budgetErr.message,
        );
        errors++;
        continue;
      }

      const budget = Array.isArray(budgetData)
        ? (budgetData[0] as BudgetRow | undefined)
        : null;
      if (!budget) continue;

      totalBilledCents += budget.billed_cost_mtd_cents ?? 0;

      // Determine which threshold notifications need to fire.
      const thresholds: Array<{
        pct: number;
        kind: 'ai_budget_50' | 'ai_budget_80' | 'ai_budget_100';
        title: string;
        body: string;
      }> = [
        {
          pct: 50,
          kind: 'ai_budget_50',
          title: 'AI usage at 50%',
          body: `You've used 50% of your monthly AI budget ($${(budget.budget_cents / 100).toFixed(2)}).`,
        },
        {
          pct: 80,
          kind: 'ai_budget_80',
          title: 'AI usage at 80%',
          body: `You've used 80% of your monthly AI budget ($${(budget.budget_cents / 100).toFixed(2)}). Consider raising your cap.`,
        },
        {
          pct: 100,
          kind: 'ai_budget_100',
          title: 'AI usage cap reached',
          body: `AI usage cap reached — calls are blocked until next month or until you raise your cap. Contact support to increase your $${(budget.budget_cents / 100).toFixed(2)}/mo limit.`,
        },
      ];

      // Resolve the admin user for this operator so we can target the
      // notification. Skip if no admin found (e.g. onboarding-incomplete op).
      const adminUserId = adminByOperator.get(op.id);
      if (!adminUserId) continue;

      for (const threshold of thresholds) {
        if (budget.pct_used < threshold.pct) continue;

        const idempotencyKey = `${threshold.kind}:${op.id}:${monthKey}`;

        // INSERT IGNORE (unique violation = already sent this month)
        const { error: insertErr } = await supabase
          .from('notifications_outbox')
          .insert({
            target_user_id: adminUserId,
            kind: threshold.kind,
            idempotency_key: idempotencyKey,
            payload: {
              operator_id: op.id,
              pct_used: budget.pct_used,
              billed_cost_mtd_cents: budget.billed_cost_mtd_cents,
              budget_cents: budget.budget_cents,
              month: monthKey,
              title: threshold.title,
              body: threshold.body,
            },
          });

        if (insertErr) {
          // Unique violation (23505) = already sent this month — expected, ignore.
          if (insertErr.code !== '23505') {
            console.error(
              `[ai-budget-checks] insert failed for ${idempotencyKey}:`,
              insertErr.message,
            );
            errors++;
          }
        } else {
          notificationsSent++;
          console.log(`[ai-budget-checks] queued ${threshold.kind} for operator ${op.id}`);
        }
      }
    } catch (err) {
      console.error(`[ai-budget-checks] error for operator ${op.id}:`, err);
      errors++;
    }
  }

  // ── Hourly Sentry spend metric ────────────────────────────────────────────
  // Approximate last hour by taking MTD total / hours since month start.
  // At the start of a month this is noisy; by day 3+ it converges.
  // For a real hourly window, we'd need a separate ai_calls query; this
  // estimate is cheap and good enough for the alert threshold use-case.
  //
  // TODO(perf): replace with a direct 1-hour window query when traffic grows:
  //   SELECT SUM(cost_cents) FROM ai_calls WHERE created_at > now() - interval '1 hour'
  const hoursIntoMonth =
    (now.getTime() - new Date(now.getFullYear(), now.getMonth(), 1).getTime()) /
    (60 * 60 * 1000);
  const hourlyCents =
    hoursIntoMonth > 0
      ? Math.round(totalBilledCents / Math.max(hoursIntoMonth, 1))
      : 0;

  // Log to Sentry so the platform owner can wire metric-based alert rules.
  // Rule suggestion (Sentry dashboard → Alerts → New Alert Rule):
  //   Event filter: tag[metric] = ai_hourly_spend
  //   Condition: level = warning → email  (fires at > $5/hr, see threshold_email)
  //   Condition: level = error   → page   (fires at > $20/hr, see threshold_page)
  Sentry.captureMessage(
    `AI spend last hour: $${(hourlyCents / 100).toFixed(2)}`,
    {
      level: hourlyCents > 2000 ? 'error' : hourlyCents > 500 ? 'warning' : 'info',
      tags: { metric: 'ai_hourly_spend' },
      extra: {
        cents: hourlyCents,
        threshold_email: 500,   // $5/hr
        threshold_page: 2000,   // $20/hr
        operators_checked: operators.length,
        total_billed_mtd_cents: totalBilledCents,
      },
    },
  );

  return {
    operatorsChecked: operators.length,
    notificationsSent,
    errors,
    hourlyCents,
  };
}
