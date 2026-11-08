// Grace-expiry worker — runs hourly.
//
// Finds invoices whose 48h grace_until has elapsed and tips them into the
// terminal "relisted with fee" state:
//
//   1. UPDATE invoice → status='payment_failed_relisted'
//   2. RPC apply_relot_fee → adds $5 to bidder_fee_ledger + bumps
//      bidders.unpaid_fees_cents
//   3. UPDATE lots (via invoice_lots junction) → status='unsold' so the
//      0097 auto-relist cron picks them up next tick and mints fresh
//      lots in a future auction
//   4. Notify the bidder so they know what happened (and that the $5
//      fee blocks new bidding until paid)
//
// Square first (2026-09-28): an invoice lands in grace when Square answers a
// charge PENDING as well as when it declines. A PENDING payment can complete
// after the 48h, so before relisting, an invoice with a recorded Square payment
// is looked up. COMPLETED / APPROVED / PENDING, or a failed lookup, leaves it in
// grace for another hour: the payment webhook moves a completed one to paid,
// and relisting it here would sell the customer's paid-for items to someone
// else. Only a payment Square reports FAILED / CANCELED, or none at all, relists.
//
// Idempotency:
//   - apply_relot_fee uses a UNIQUE index on (invoice_id) WHERE invoice_id
//     IS NOT NULL with ON CONFLICT DO NOTHING — re-runs are no-ops on
//     the fee side.
//   - The invoice status UPDATE is gated on the current value being
//     'payment_failed_grace' so a re-run won't reapply if a manual
//     operator action moved it elsewhere.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getPayment } from '@/lib/square';
import { bidderDeepLink } from '@/lib/app-links';

const BATCH_SIZE = 100;

type GraceRow = {
  id: string;
  bidder_id: string;
  operator_id: string;
  square_payment_id: string | null;
};

// Square payment states that mean the customer's money may still arrive.
const PAYMENT_MAY_LAND = new Set(['COMPLETED', 'APPROVED', 'PENDING']);

type PolicyRow = {
  operator_id: string;
  relist_fee_cents: number;
  version: number;
};

type LotLink = {
  invoice_id: string;
  lot_id: string;
  picked_up_at: string | null;
};

export type GraceExpiryResult = {
  scanned: number;
  relisted_invoices: number;
  fees_applied: number;
  errors: number;
  held_for_square: number;
};

export async function runGraceExpiry(): Promise<GraceExpiryResult> {
  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  const { data: rows, error } = await admin
    .from('invoices')
    .select('id, bidder_id, operator_id, square_payment_id')
    .eq('status', 'payment_failed_grace')
    .lt('grace_until', nowIso)
    .limit(BATCH_SIZE)
    .returns<GraceRow[]>();

  if (error) {
    console.error('[grace-expiry] select failed:', error.message);
    return { scanned: 0, relisted_invoices: 0, fees_applied: 0, errors: 1, held_for_square: 0 };
  }
  if (!rows || rows.length === 0) {
    return { scanned: 0, relisted_invoices: 0, fees_applied: 0, errors: 0, held_for_square: 0 };
  }

  const invoiceIds = rows.map((r) => r.id);

  // One round-trip to collect every lot we need to flip. A line the counter
  // already stamped picked up is the customer's item, not stock (2026-09-14
  // audit), so it is left alone and logged rather than released with the
  // rest. 0358 skips such a row at the table anyway; filtering here keeps
  // this job's own counts honest.
  const { data: lotLinks } = await admin
    .from('invoice_lots')
    .select('invoice_id, lot_id, picked_up_at')
    .in('invoice_id', invoiceIds)
    .returns<LotLink[]>();

  const lotIdsByInvoice = new Map<string, string[]>();
  let collectedSkipped = 0;
  for (const link of lotLinks ?? []) {
    if (link.picked_up_at !== null) {
      collectedSkipped++;
      continue;
    }
    const list = lotIdsByInvoice.get(link.invoice_id) ?? [];
    list.push(link.lot_id);
    lotIdsByInvoice.set(link.invoice_id, list);
  }
  if (collectedSkipped > 0) {
    console.warn(`[grace-expiry] ${collectedSkipped} lot(s) already collected; left untouched`);
  }

  // PR-D (2026-05-29): batch-resolve relist_fee_cents per operator from
  // operator_policies (mig 0157). Replaces the hardcoded "$5" in the push
  // body. Falls back to 500c (today's effective default) for any operator
  // without a published policy — matches the fallback inside apply_relot_fee
  // (mig 0158) so DB and push body agree on the amount.
  const operatorIds = Array.from(new Set(rows.map((r) => r.operator_id)));
  const feeByOperator = new Map<string, number>();
  if (operatorIds.length > 0) {
    const { data: policies } = await admin
      .from('operator_policies')
      .select('operator_id, relist_fee_cents, version')
      .in('operator_id', operatorIds)
      .eq('published', true)
      .order('version', { ascending: false })
      .returns<PolicyRow[]>();
    for (const p of policies ?? []) {
      // First row per operator (highest version due to ORDER BY) wins.
      if (!feeByOperator.has(p.operator_id)) {
        feeByOperator.set(p.operator_id, p.relist_fee_cents);
      }
    }
  }

  let relisted = 0;
  let feesApplied = 0;
  let errors = 0;
  let heldForSquare = 0;

  for (const row of rows) {
    try {
      if (row.square_payment_id) {
        let squareStatus: string;
        try {
          squareStatus = (await getPayment(row.square_payment_id))?.status ?? 'NOT_FOUND';
        } catch (err) {
          squareStatus = `LOOKUP_FAILED: ${(err as Error)?.message ?? String(err)}`;
        }
        if (PAYMENT_MAY_LAND.has(squareStatus) || squareStatus.startsWith('LOOKUP_FAILED')) {
          console.warn('[grace-expiry] held in grace, Square payment not final', {
            invoice_id: row.id,
            payment_id: row.square_payment_id,
            square_status: squareStatus,
          });
          heldForSquare++;
          continue;
        }
      }

      // Flip the invoice — match-where on status so concurrent admin
      // actions don't get overwritten.
      const { error: invErr } = await admin
        .from('invoices')
        .update({ status: 'payment_failed_relisted' })
        .eq('id', row.id)
        .eq('status', 'payment_failed_grace');
      if (invErr) {
        console.error(
          '[grace-expiry] invoice flip failed for',
          row.id,
          invErr.message,
        );
        errors++;
        continue;
      }
      relisted++;

      // Apply the relot fee. RPC handles idempotency via the unique
      // index on bidder_fee_ledger(invoice_id) — a re-run returns the
      // existing aggregate unchanged.
      const { error: feeErr } = await admin.rpc('apply_relot_fee', {
        p_invoice_id: row.id,
      });
      if (feeErr) {
        console.error(
          '[grace-expiry] apply_relot_fee failed for',
          row.id,
          feeErr.message,
        );
        errors++;
      } else {
        feesApplied++;
      }

      // Release the lots back to the unsold pool — the 0097 auto-relist
      // cron picks up 'unsold' lots at operators with auto_relist_enabled.
      // We also null current_bid_* so the bidder app doesn't show a stale
      // winning state, and clear winner_bidder_id so an inadvertent
      // place_bid-style lookup doesn't think the abandoning bidder still
      // owns it.
      const lotIds = lotIdsByInvoice.get(row.id) ?? [];
      if (lotIds.length > 0) {
        const { error: lotsErr } = await admin
          .from('lots')
          .update({
            status: 'unsold',
            winner_bidder_id: null,
            current_bid_id: null,
            current_bid_cents: null,
          })
          .in('id', lotIds);
        if (lotsErr) {
          console.error(
            '[grace-expiry] lot relist failed for',
            row.id,
            lotsErr.message,
          );
          errors++;
        }
      }

      // Notify the bidder. Idempotency-keyed on invoice_id so re-runs of
      // this row (or this whole batch) don't duplicate.
      //
      // PR-D (2026-05-29): body amount now reads from operator_policies.relist_fee_cents
      // (default 500c = $5 if the operator has no published policy — matches the
      // fallback in apply_relot_fee SQL function).
      //
      // 2026-09-14: deep_link was still on the clovrbid:// scheme — the second
      // of two renames (bidwizops → clovrbid → bingo) missed it, so the OS
      // refused the URI and the tap did nothing at all. It now comes from
      // bidderDeepLink() so a third rename can't strand it again.
      const feeCents = feeByOperator.get(row.operator_id) ?? 500;
      const feeStr = `$${(feeCents / 100).toFixed(feeCents % 100 === 0 ? 0 : 2)}`;
      await admin
        .from('notifications_outbox')
        .insert({
          target_user_id: row.bidder_id,
          kind: 'relot_fee_applied',
          idempotency_key: `relot_fee_applied:${row.id}`,
          payload: {
            invoice_id: row.id,
            title: 'Your lot was relisted',
            body: `Your ${feeStr} relot fee was added to your account. Update your card and pay your balance to bid again.`,
            deep_link: bidderDeepLink('profile/pay-fees'),
            relist_fee_cents: feeCents,
          },
        })
        .then(undefined, () => undefined);
    } catch (err) {
      console.error('[grace-expiry] unexpected error on', row.id, err);
      errors++;
    }
  }

  return {
    scanned: rows.length,
    relisted_invoices: relisted,
    fees_applied: feesApplied,
    errors,
    held_for_square: heldForSquare,
  };
}
