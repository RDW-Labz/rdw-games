// referral-credits.ts — the "Give $5, get $5" ledger (mig 0229).
//
// bidder_credits is append-only: positive rows grant, negative rows consume,
// balance = SUM(amount_cents). Exactly-once semantics come from the table's
// partial UNIQUE indexes — every function here inserts and treats a 23505
// unique-violation as "already done", so crash-retry paths (the auto-charge
// drain re-processing an invoice, the sweep re-scanning a bidder) are safe
// to call repeatedly.
//
// Spend policy (owner, 2026-07-05): credit applies to the WHOLE invoice
// total, before the Square charge. Earn policy: $5 to BOTH sides when the
// referred bidder's first invoice is paid AND picked up (see
// lib/cron/referral-credit-sweep.ts for why pickup is the fraud gate).

import type { SupabaseClient } from '@supabase/supabase-js';

export const REFERRAL_CREDIT_CENTS = 500;

const UNIQUE_VIOLATION = '23505';

export async function getCreditBalanceCents(
  admin: SupabaseClient,
  bidderId: string,
): Promise<number> {
  const { data, error } = await admin
    .from('bidder_credits')
    .select('amount_cents')
    .eq('bidder_id', bidderId);
  if (error) throw new Error(`credit balance read failed: ${error.message}`);
  return (data ?? []).reduce((sum, r) => sum + (r.amount_cents as number), 0);
}

/**
 * Apply available credit to an invoice, up to its full total. Returns the
 * cents applied (0 when the bidder has no balance). Idempotent per invoice:
 * a second call returns the already-recorded spend instead of double-dipping.
 */
export async function applyCreditToInvoice(
  admin: SupabaseClient,
  args: { invoiceId: string; bidderId: string; totalCents: number },
): Promise<number> {
  // Already spent on this invoice? (retry path)
  const { data: existing } = await admin
    .from('bidder_credits')
    .select('amount_cents')
    .eq('invoice_id', args.invoiceId)
    .eq('reason', 'spend')
    .maybeSingle();
  if (existing) {
    // A reversal (failed charge) may have undone it — check.
    const { data: reversal } = await admin
      .from('bidder_credits')
      .select('id')
      .eq('invoice_id', args.invoiceId)
      .eq('reason', 'spend_reversal')
      .maybeSingle();
    return reversal ? 0 : -(existing.amount_cents as number);
  }

  const balance = await getCreditBalanceCents(admin, args.bidderId);
  const apply = Math.min(Math.max(balance, 0), Math.max(args.totalCents, 0));
  if (apply <= 0) return 0;

  const { error: insErr } = await admin.from('bidder_credits').insert({
    bidder_id: args.bidderId,
    amount_cents: -apply,
    reason: 'spend',
    invoice_id: args.invoiceId,
  });
  if (insErr) {
    if (insErr.code === UNIQUE_VIOLATION) {
      // Concurrent tick beat us — recurse once to read what it recorded.
      return applyCreditToInvoice(admin, args);
    }
    throw new Error(`credit spend insert failed: ${insErr.message}`);
  }

  await admin
    .from('invoices')
    .update({ credit_applied_cents: apply })
    .eq('id', args.invoiceId);

  return apply;
}

/**
 * Return previously-consumed store credit to a bidder when their purchase is
 * refunded (mig 0270). When an invoice was partly paid with bidder_credits,
 * the card only captured `total - credit`; the refund returns the cash portion
 * to the card and this returns the credit portion to the bidder's balance so
 * they aren't shortchanged. Positive ledger row, reason 'refund_return'.
 *
 * Best-effort by design: the cash refund has already succeeded by the time
 * this is called, so a failure here must not fail the request — it's logged
 * loudly instead (same policy as the audit-row write in the refund routes).
 * Not strictly idempotent across a full request retry; the cash side is
 * protected by Square's idempotency key, and a rare double-return only inflates
 * a marketing-credit balance, never real money.
 */
export async function returnRefundCredit(
  admin: SupabaseClient,
  args: { bidderId: string; invoiceId: string; amountCents: number },
): Promise<void> {
  if (args.amountCents <= 0) return;
  const { error } = await admin.from('bidder_credits').insert({
    bidder_id: args.bidderId,
    amount_cents: args.amountCents,
    reason: 'refund_return',
    invoice_id: args.invoiceId,
  });
  if (error) {
    console.error(
      '[referral-credits] refund credit return FAILED for invoice',
      args.invoiceId,
      'bidder',
      args.bidderId,
      `$${(args.amountCents / 100).toFixed(2)}`,
      error.message,
    );
  }
}

/**
 * Undo a spend after the card charge for the remainder failed — the bidder
 * keeps their credit for the retry (which will re-apply it). Idempotent.
 */
export async function reverseCreditSpend(
  admin: SupabaseClient,
  invoiceId: string,
): Promise<void> {
  const { data: spend } = await admin
    .from('bidder_credits')
    .select('bidder_id, amount_cents')
    .eq('invoice_id', invoiceId)
    .eq('reason', 'spend')
    .maybeSingle();
  if (!spend) return;

  const { error } = await admin.from('bidder_credits').insert({
    bidder_id: spend.bidder_id,
    amount_cents: -(spend.amount_cents as number), // spend is negative → this is positive
    reason: 'spend_reversal',
    invoice_id: invoiceId,
  });
  if (error && error.code !== UNIQUE_VIOLATION) {
    // A stuck reversal means real money risk on the NEXT apply — surface loudly.
    console.error('[referral-credits] spend reversal failed for', invoiceId, error.message);
    return;
  }

  await admin.from('invoices').update({ credit_applied_cents: 0 }).eq('id', invoiceId);
}

/**
 * Grant $5 to both sides of a completed referral + notify both. Called by
 * the referral-credit-sweep once the referred bidder's first invoice is
 * paid and picked up. Idempotent via the ledger's unique indexes AND the
 * caller's referral_credited_at stamp.
 */
export async function grantReferralCredits(
  admin: SupabaseClient,
  referred: { id: string; referred_by: string },
): Promise<void> {
  const rows = [
    {
      bidder_id: referred.referred_by,
      amount_cents: REFERRAL_CREDIT_CENTS,
      reason: 'referral_earn',
      related_bidder_id: referred.id,
    },
    {
      bidder_id: referred.id,
      amount_cents: REFERRAL_CREDIT_CENTS,
      reason: 'referral_welcome',
      related_bidder_id: referred.referred_by,
    },
  ];
  for (const row of rows) {
    const { error } = await admin.from('bidder_credits').insert(row);
    if (error && error.code !== UNIQUE_VIOLATION) {
      throw new Error(`referral grant insert failed (${row.reason}): ${error.message}`);
    }
  }

  await admin
    .from('bidders')
    .update({ referral_credited_at: new Date().toISOString() })
    .eq('id', referred.id);

  // Tell both sides. Kind 'referral_credited' (mig 0229); title/body ride in
  // the payload so the push drain's generic fallback renders correctly even
  // before its dedicated case deploys.
  const notifications = [
    {
      target_user_id: referred.referred_by,
      kind: 'referral_credited',
      idempotency_key: `referral_earn:${referred.id}`,
      payload: {
        amount_cents: REFERRAL_CREDIT_CENTS,
        role: 'referrer',
        title: 'You earned $5 in BinGo credit',
        body: 'Your friend picked up their first win. $5 comes off your next invoice automatically.',
      },
    },
    {
      target_user_id: referred.id,
      kind: 'referral_credited',
      idempotency_key: `referral_welcome:${referred.id}`,
      payload: {
        amount_cents: REFERRAL_CREDIT_CENTS,
        role: 'referred',
        title: 'You earned $5 in BinGo credit',
        body: 'Thanks for joining through a friend — $5 comes off your next invoice automatically.',
      },
    },
  ];
  for (const n of notifications) {
    await admin
      .from('notifications_outbox')
      .insert(n)
      .then(undefined, (err: unknown) => {
        console.warn('[referral-credits] notify enqueue failed:', (err as Error)?.message);
      });
  }
}
