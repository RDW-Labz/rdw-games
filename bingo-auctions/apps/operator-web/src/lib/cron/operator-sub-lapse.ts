// Operator subscription-lapse worker — runs daily.
//
// The 0105/0106 grace policy: when an operator's platform subscription
// goes past_due (webhook sets operators.subscription_status='past_due'
// + lapse_at = now()+7d), we give them 7 days to fix billing. After
// that window, this cron flips operators.status to 'subscription_lapsed'.
//
// What 'subscription_lapsed' gates:
//   - New auction creation (downstream route guards check operators.status)
//   - New connect flows
// What it does NOT gate:
//   - In-flight auctions continue running. Bidders aren't stranded.
//   - Existing invoices continue to charge / settle normally.
//
// Reversibility: a successful payment flips subscription_status back to
// 'active' and clears lapse_at (see webhook handler). The operator's
// status stays 'subscription_lapsed' until a human (admin or the
// operator's own /billing reactivation flow) flips them back to 'active'.
// We're conservative on auto-reactivation because billing recovery
// doesn't always mean we want their auctions live without re-onboarding.

import { getSupabaseAdmin } from '@/lib/supabase-admin';

const BATCH_SIZE = 100;

type LapseRow = {
  id: string;
};

export type OperatorSubLapseResult = {
  lapsed_count: number;
};

export async function runOperatorSubLapse(): Promise<OperatorSubLapseResult> {
  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  // Find operators in past_due whose 7d grace window elapsed AND who
  // aren't already lapsed. The status filter prevents repeated flips
  // and keeps the row count tiny in steady state.
  const { data: rows, error } = await admin
    .from('operators')
    .select('id')
    .eq('subscription_status', 'past_due')
    .lt('lapse_at', nowIso)
    .not('status', 'eq', 'subscription_lapsed')
    .limit(BATCH_SIZE)
    .returns<LapseRow[]>();

  if (error) {
    console.error('[operator-sub-lapse] select failed:', error.message);
    return { lapsed_count: 0 };
  }
  if (!rows || rows.length === 0) {
    return { lapsed_count: 0 };
  }

  let lapsed = 0;
  for (const row of rows) {
    const { error: updErr } = await admin
      .from('operators')
      .update({ status: 'subscription_lapsed' })
      .eq('id', row.id)
      .eq('subscription_status', 'past_due');
    if (updErr) {
      console.error(
        '[operator-sub-lapse] flip failed for',
        row.id,
        updErr.message,
      );
      continue;
    }
    lapsed++;
  }

  return { lapsed_count: lapsed };
}
