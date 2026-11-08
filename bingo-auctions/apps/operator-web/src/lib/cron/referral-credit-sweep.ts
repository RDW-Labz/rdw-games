// referral-credit-sweep.ts
//
// The EARN side of "Give $5, get $5" (mig 0229). A referral completes when
// the referred bidder's first invoice is PAID **and PICKED UP** — the pickup
// requirement is the anti-fraud gate: someone has to physically walk into
// the warehouse and collect goods before any credit exists, which makes
// fake-account farming cost more than the $10 it mints.
//
// Runs as a sweep (hourly) instead of a hook inside the pickup-confirm SQL
// RPCs: those functions are large, have multiple entry points (QR check-in,
// staff confirm), and money logic doesn't belong in them. The sweep is
// idempotent end to end — bidders.referral_credited_at stamps completion,
// and the ledger's unique indexes make the grant itself exactly-once — so
// scanning the same bidder twice is harmless.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { grantReferralCredits } from '@/lib/referral-credits';

const BATCH_SIZE = 50;

export type ReferralSweepResult = {
  scanned: number;
  granted: number;
  failed: number;
};

export async function runReferralCreditSweep(): Promise<ReferralSweepResult> {
  const admin = getSupabaseAdmin();

  const { data: candidates, error } = await admin
    .from('bidders')
    .select('id, referred_by')
    .not('referred_by', 'is', null)
    .is('referral_credited_at', null)
    .is('deleted_at', null)
    .limit(BATCH_SIZE);

  if (error) {
    console.error('[referral-sweep] candidate fetch failed:', error.message);
    return { scanned: 0, granted: 0, failed: 0 };
  }

  const bidders = candidates ?? [];
  if (bidders.length === 0) return { scanned: 0, granted: 0, failed: 0 };

  let granted = 0;
  let failed = 0;

  for (const bidder of bidders) {
    // Completion check: any PAID invoice of theirs with a picked_up pickup row.
    const { data: paidInvoices, error: invErr } = await admin
      .from('invoices')
      .select('id')
      .eq('bidder_id', bidder.id)
      .eq('status', 'paid')
      .limit(25);
    if (invErr) {
      console.warn('[referral-sweep] invoice check failed for', bidder.id, invErr.message);
      failed++;
      continue;
    }
    const invoiceIds = (paidInvoices ?? []).map((i) => i.id);
    if (invoiceIds.length === 0) continue; // not there yet — next sweep

    // 'completed', NOT 'picked_up'.
    //
    // 'picked_up' is a real status in this codebase — on bin_assignments, where
    // it means a lot physically left its shelf. It is not in the pickups enum,
    // whose collected state is 'completed' (4,885 rows and counting). Because
    // pickups.status is an enum, the mismatch did not return zero rows: it
    // raised an invalid-input error that the catch below logged as a warning
    // and counted as `failed`. So the sweep ran hourly since launch, found
    // candidates every time, and granted nothing — while looking healthy from
    // the outside.
    //
    // Cost of the typo: 102 people arrived by referral and 46 of them became
    // paying buyers, at a 45% conversion rate that beats every other channel we
    // have. Not one referrer was ever paid the $5 they were promised.
    const { data: pickedUp, error: puErr } = await admin
      .from('pickups')
      .select('id')
      .in('invoice_id', invoiceIds)
      .eq('status', 'completed')
      .limit(1);
    if (puErr) {
      console.warn('[referral-sweep] pickup check failed for', bidder.id, puErr.message);
      failed++;
      continue;
    }
    if (!pickedUp || pickedUp.length === 0) continue; // paid but not collected yet

    try {
      await grantReferralCredits(admin, {
        id: bidder.id,
        referred_by: bidder.referred_by as string,
      });
      granted++;
    } catch (err) {
      console.error('[referral-sweep] grant failed for', bidder.id, (err as Error).message);
      failed++;
    }
  }

  return { scanned: bidders.length, granted, failed };
}
