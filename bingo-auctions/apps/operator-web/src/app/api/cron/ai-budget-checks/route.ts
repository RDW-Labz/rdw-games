// POST /api/cron/ai-budget-checks
// Called every 30 minutes by the bingo-cron Worker. For each operator:
//   - Computes month-to-date AI spend via check_operator_ai_budget
//   - Enqueues notifications_outbox rows at 50%, 80%, 100% thresholds
//   - Logs an hourly Sentry metric for $5/hr (warning) and $20/hr (error)
//     alerting — set up matching rules in the Sentry dashboard.
//
// See lib/cron/ai-budget-checks.ts for the full logic.

import { NextResponse } from 'next/server';
import { checkCronSecret } from '@/lib/cron-auth';
import { runAiBudgetChecks } from '@/lib/cron/ai-budget-checks';

export async function POST(req: Request) {
  const unauth = checkCronSecret(req);
  if (unauth) return unauth;

  const result = await runAiBudgetChecks();
  return NextResponse.json(result);
}
