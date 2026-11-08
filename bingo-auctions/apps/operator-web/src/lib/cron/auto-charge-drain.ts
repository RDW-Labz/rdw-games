// Auto-charge worker — drains auto_charge_jobs and charges newly-built invoices
// via Square (card-on-file, merchant-initiated, buyer NOT present).
//
// Triggered from /api/cron/auto-charge-drain every minute.
//
// Flow per job:
//   1. Read invoice + bidder (batched).
//   2. Skip if the invoice is gone / already paid / canceled.
//   3. Defer if the auction still has live/scheduled lots (money-leak gate) —
//      build_invoices_for_auction (mig 0072) can still extend a pending invoice
//      with later-closing lots; charging now would strand them.
//   4. If payments_disabled (no live processor / pre-cutover): mark the invoice
//      paid OFFLINE (operator settles cash at pickup) + ensure the pickup row.
//   5. Otherwise charge the bidder's Square card-on-file for invoice.total_cents
//      on the Bingo location:
//        • COMPLETED/APPROVED → invoice paid + square_payment_id + pickup row.
//        • no card on file    → invoice → payment_failed_grace + push reminder.
//        • decline / API error → invoice → payment_failed_grace + push decline.
//
// Idempotency: Square idempotency_key = sq:inv:<id> (43 chars — Square caps the
// field at 45) so a race between a manual pay and the auto-charge converges on
// one payment. Jobs are DELETEd
// after handling so a second concurrent runner sees an empty row.
//
// BinGo is single-account: there is no Connect destination, application fee, or
// per-operator onboarding gate — the charge lands directly on the one Bingo
// Square location (pinned inside lib/square.ts). US-only; tax_cents stays 0.

import * as Sentry from '@sentry/nextjs';
import {
  chargeCardOnFile,
  getPayment,
  findCompletedPaymentForInvoice,
  idempotencyKey45,
  SquareApiError,
  type PaymentResult,
} from '@/lib/square';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { bidderDeepLink } from '@/lib/app-links';
import {
  recordChargeAttempt,
  persistBidderCardFacts,
  squareErrorParts,
} from '@/lib/charge-attempts';
import { applyCreditToInvoice } from '@/lib/referral-credits';
import { isPaymentsDisabled } from '@/lib/payments-mode';
import { ensurePickupRow } from '@/lib/pickup-row';

const BATCH_SIZE = 50;
// Operator-configurable grace window (operators.auto_charge_grace_hours, mig
// 0144). Default 48 if unset — matches the pre-config behavior.
const DEFAULT_GRACE_HOURS = 48;

type Job = {
  invoice_id: string;
  bidder_id: string;
  attempt_count: number;
};

type InvoiceRow = {
  id: string;
  status: string;
  total_cents: number;
  operator_id: string;
  auction_id: string;
  /** mig 0095: 'pickup' | 'ship' | null. We only create a pickups row (via
   *  ensure_pickup_row) for non-ship invoices — ship goes to the shipping
   *  queue. */
  fulfillment_method: string | null;
  /** Recorded Square payment id (set on a prior success, or when a grace flip
   *  captured a returned id). Used by reconcile-before-charge. */
  square_payment_id: string | null;
  /** Invoice creation time — the lower bound for the reconcile ListPayments
   *  window. */
  created_at: string;
  /** mig 0271: the exact params of the last CreatePayment we attempted, persisted
   *  BEFORE the network call. On a retry the reconcile replays this idempotency
   *  key so Square returns the prior payment (if it completed) or performs the
   *  single intended charge — a retry can never double-charge. Null once the
   *  invoice is paid. */
  last_charge_attempt: { key: string; amount_cents: number; card_id: string | null } | null;
  operators: { auto_charge_grace_hours: number | null } | null;
  /** First lot_code on the invoice — used only for human-friendly push copy. */
  primary_lot_code?: string | null;
};

type BidderRow = {
  id: string;
  square_customer_id: string | null;
  /** Post-cutover this holds the Square card-on-file id (ccof:...). */
  default_payment_method_id: string | null;
};

// Membership perk: a bidder's active/trialing operator membership may carry
// plan.extra_grace_hours, ADDED to the operator base grace on a charge failure.
// Kept as-is from the multi-op design; harmless when no subscriptions exist
// (the map stays empty → extraGraceFor returns 0).
type SubExtraGraceRow = {
  bidder_id: string;
  operator_id: string;
  status: string;
  current_period_end: string | null;
  operator_pro_plans: { extra_grace_hours: number | null } | null;
};

export type AutoChargeResult = {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** Jobs whose auction still has live/scheduled lots — left in the queue with
   *  bumped next_attempt_at for the next tick. Not a failure, not a skip. */
  deferred: number;
};

export async function runAutoChargeDrain(): Promise<AutoChargeResult> {
  const admin = getSupabaseAdmin();

  // Pre-cutover: when payments_disabled is true there is no live processor, so
  // settled invoices are marked paid OFFLINE in the loop below. Read once;
  // fail-safe false → live Square charge path.
  const paymentsOff = await isPaymentsDisabled();

  const nowIso = new Date().toISOString();
  const { data: jobs, error: jobsErr } = await admin
    .from('auto_charge_jobs')
    .select('invoice_id, bidder_id, attempt_count')
    .lte('next_attempt_at', nowIso)
    .order('next_attempt_at', { ascending: true })
    .limit(BATCH_SIZE)
    .returns<Job[]>();

  if (jobsErr) {
    console.error('[auto-charge-drain] job select failed:', jobsErr.message);
    return { processed: 0, succeeded: 0, failed: 0, skipped: 0, deferred: 0 };
  }
  if (!jobs || jobs.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, skipped: 0, deferred: 0 };
  }

  const invoiceIds = jobs.map((j) => j.invoice_id);
  const bidderIds = Array.from(new Set(jobs.map((j) => j.bidder_id)));

  const [{ data: invoices }, { data: bidders }, { data: lotLinks }, { data: subRows }] =
    await Promise.all([
      admin
        .from('invoices')
        .select(
          'id, status, total_cents, operator_id, auction_id, fulfillment_method, square_payment_id, created_at, last_charge_attempt, operators(auto_charge_grace_hours)',
        )
        .in('id', invoiceIds)
        .returns<InvoiceRow[]>(),
      admin
        .from('bidders')
        .select('id, square_customer_id, default_payment_method_id')
        .in('id', bidderIds)
        .returns<BidderRow[]>(),
      admin
        .from('invoice_lots')
        .select('invoice_id, lot_id, lots(lot_code)')
        .in('invoice_id', invoiceIds),
      admin
        .from('bidder_subscriptions')
        .select(
          'bidder_id, operator_id, status, current_period_end, operator_pro_plans(extra_grace_hours)',
        )
        .in('bidder_id', bidderIds)
        .in('status', ['active', 'trialing']),
    ]);

  const primaryLotCodeByInvoice = new Map<string, string | null>();
  type LotLink = { invoice_id: string; lots: { lot_code: string | null } | null };
  for (const link of (lotLinks ?? []) as unknown as LotLink[]) {
    if (!primaryLotCodeByInvoice.has(link.invoice_id)) {
      primaryLotCodeByInvoice.set(link.invoice_id, link.lots?.lot_code ?? null);
    }
  }

  const invoiceById = new Map<string, InvoiceRow>(
    (invoices ?? []).map((i) => [
      i.id,
      { ...i, primary_lot_code: primaryLotCodeByInvoice.get(i.id) ?? null },
    ]),
  );
  const bidderById = new Map<string, BidderRow>((bidders ?? []).map((b) => [b.id, b]));

  const subExtraGraceByBidderOp = new Map<string, number>();
  const nowMs = Date.now();
  for (const row of (subRows ?? []) as unknown as SubExtraGraceRow[]) {
    if (!row.bidder_id || !row.operator_id) continue;
    if (
      row.current_period_end != null &&
      new Date(row.current_period_end).getTime() <= nowMs
    ) {
      continue;
    }
    const extra = row.operator_pro_plans?.extra_grace_hours ?? 0;
    if (extra > 0) {
      subExtraGraceByBidderOp.set(`${row.bidder_id}|${row.operator_id}`, extra);
    }
  }
  const extraGraceFor = (bidderId: string, operatorId: string | null): number =>
    operatorId ? subExtraGraceByBidderOp.get(`${bidderId}|${operatorId}`) ?? 0 : 0;

  // ── Auction-settled gate (money-leak fix) ───────────────────────────────────
  // Do NOT charge while the auction still has live/scheduled lots — the pending
  // invoice can still be extended with later-closing wins. Defer (bump 60s).
  const auctionIds = Array.from(
    new Set(
      (invoices ?? []).map((i) => i.auction_id).filter((id): id is string => Boolean(id)),
    ),
  );
  const auctionsWithUnsettledLots = new Set<string>();
  if (auctionIds.length > 0) {
    const { data: pendingLotRows, error: pendingLotsErr } = await admin
      .from('lots')
      .select('auction_id')
      .in('auction_id', auctionIds)
      .in('status', ['live', 'scheduled'])
      .is('deleted_at', null);
    if (pendingLotsErr) {
      // Fail closed: if we can't verify settlement, defer rather than risk an
      // early charge that strands later lots.
      console.error('[auto-charge-drain] settled-gate query failed:', pendingLotsErr.message);
      for (const id of auctionIds) auctionsWithUnsettledLots.add(id);
    } else {
      for (const row of pendingLotRows ?? []) {
        if (row.auction_id) auctionsWithUnsettledLots.add(row.auction_id);
      }
    }
  }

  // 0293: which Square location does each invoice charge against?
  //
  // One Square account + one token serves every location; the location is just
  // an id on the payment. Before this, `location_id` was pinned to a single env
  // var, so a Kansas (Dodge City) sale booked to the Arkansas (Harrison)
  // location and Square's reporting, deposits and location tax all
  // misattributed it.
  //
  // Resolved auction → warehouse → square_location_id in one batched query,
  // reusing the auctionIds set gathered above. A warehouse with no mapping is
  // simply absent from the map, and chargeCardOnFile falls back to the env var
  // — so this is a no-op until someone fills the column in.
  const squareLocationByAuction = new Map<string, string>();
  if (auctionIds.length > 0) {
    const { data: auctionWarehouses, error: whErr } = await admin
      .from('auctions')
      .select('id, warehouses(square_location_id)')
      .in('id', auctionIds);
    if (whErr) {
      // Non-fatal: fall back to the env-var location rather than skipping the
      // charge. Mis-attributing a payment is recoverable; not charging is not.
      console.warn('[auto-charge-drain] square location lookup failed:', whErr.message);
    } else {
      for (const row of (auctionWarehouses ?? []) as Array<{
        id: string;
        warehouses: { square_location_id: string | null } | Array<{ square_location_id: string | null }> | null;
      }>) {
        const wh = Array.isArray(row.warehouses) ? row.warehouses[0] : row.warehouses;
        const loc = wh?.square_location_id?.trim();
        if (loc) squareLocationByAuction.set(row.id, loc);
      }
    }
  }

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;

  for (const job of jobs) {
    const invoice = invoiceById.get(job.invoice_id);
    const bidder = bidderById.get(job.bidder_id);

    if (!invoice) {
      await deleteJob(job.invoice_id);
      skipped++;
      continue;
    }

    if (invoice.status === 'paid' || invoice.status === 'canceled') {
      await deleteJob(job.invoice_id);
      skipped++;
      continue;
    }

    // Money-leak gate: defer until the whole auction is settled.
    if (invoice.auction_id && auctionsWithUnsettledLots.has(invoice.auction_id)) {
      const nextIso = new Date(Date.now() + 60_000).toISOString();
      const { error: deferErr } = await admin
        .from('auto_charge_jobs')
        .update({ next_attempt_at: nextIso })
        .eq('invoice_id', job.invoice_id);
      if (deferErr) {
        console.error('[auto-charge-drain] defer bump failed for', job.invoice_id, deferErr.message);
      }
      deferred++;
      continue;
    }

    // Pre-cutover: no live processor → mark paid OFFLINE so close→win→paid still
    // advances and pickup is testable. Operators settle cash at pickup.
    if (paymentsOff) {
      const { error: paidErr } = await admin
        .from('invoices')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          last_auto_charge_at: new Date().toISOString(),
          last_auto_charge_error: 'payments_disabled_offline',
          auto_charge_attempt_count: (job.attempt_count ?? 0) + 1,
        })
        .eq('id', invoice.id);
      if (paidErr) {
        console.error('[auto-charge-drain] offline mark-paid failed for', invoice.id, paidErr.message);
      } else if (invoice.fulfillment_method !== 'ship') {
        await ensurePickupRow(admin, invoice.id, 'auto-charge-drain:offline');
      }
      await deleteJob(job.invoice_id);
      succeeded++;
      continue;
    }

    if (!bidder) {
      await flipInvoiceToGrace(invoice.id, 'bidder_missing');
      await deleteJob(job.invoice_id);
      skipped++;
      continue;
    }

    // Deterministic charge note — computed once so the reconcile replay below
    // reproduces a prior CreatePayment request byte-for-byte (Square idempotency
    // matches on the full body, so the note must be identical). (mig 0271)
    const chargeNote = invoice.primary_lot_code
      ? `BinGo lot ${invoice.primary_lot_code}`
      : `BinGo invoice ${invoice.id}`;

    // ── Reconcile-before-charge (2026-07-08 incident) ────────────────────────
    // Before charging, check whether Square already has a COMPLETED payment for
    // this invoice. Catches the case where an earlier attempt actually charged
    // the card but the success never landed on our side — the CreatePayment
    // call timed out, or a second attempt reused the invoice's idempotency key
    // and errored (IDEMPOTENCY_KEY_REUSED), so we wrongly flipped to grace.
    // Reconciling here marks the invoice paid from real Square state and, since
    // it runs before every retry, prevents a double charge. Only runs when
    // there is evidence of a prior attempt — first-ever charges skip the Square
    // round-trip entirely (the happy path stays one call).
    const hadPriorAttempt =
      (job.attempt_count ?? 0) > 0 ||
      !!invoice.square_payment_id ||
      invoice.status === 'payment_failed_grace';
    if (hadPriorAttempt) {
      let lookupOk = false;
      let existing: PaymentResult | null = null;
      try {
        if (invoice.square_payment_id) {
          existing = await getPayment(invoice.square_payment_id);
        }
        // mig 0271: replay the prior attempt's EXACT idempotency key. Square
        // returns the prior payment if one was ever created (recovering a
        // timed-out-but-captured charge with no ListPayments scan at all), or
        // performs the single intended charge if it never landed. Reusing the
        // key makes a double charge impossible by construction — the old
        // per-attempt key on retry was the double-charge hole. A genuinely
        // FAILED prior comes back FAILED here and falls through to a fresh
        // attempt (new key), so same-card-funded retries still work.
        if (
          (!existing || (existing.status !== 'COMPLETED' && existing.status !== 'APPROVED')) &&
          invoice.last_charge_attempt?.key &&
          bidder.square_customer_id
        ) {
          const prior = invoice.last_charge_attempt;
          try {
            existing = await chargeCardOnFile({
              customerId: bidder.square_customer_id,
              cardId: prior.card_id ?? bidder.default_payment_method_id ?? '',
              amountCents: prior.amount_cents,
              idempotencyKey: prior.key,
              referenceId: invoice.id,
              note: chargeNote,
              // 0293: resolve the SAME location as the original attempt would
              // have. Square matches a replay on the idempotency key and rejects
              // a differing body, and resolution is deterministic per auction —
              // so this matches unless the mapping was edited between attempts,
              // which the IDEMPOTENCY_KEY_REUSED handling below already covers.
              squareLocationId: squareLocationByAuction.get(invoice.auction_id) ?? null,
            });
          } catch (replayErr) {
            // Body mismatch (IDEMPOTENCY_KEY_REUSED) or transient error — don't
            // treat as recovered; fall through to the bounded scan below.
            console.warn(
              '[auto-charge-drain] idempotency replay failed for',
              invoice.id,
              (replayErr as Error).message,
            );
          }
        }
        if (!existing || (existing.status !== 'COMPLETED' && existing.status !== 'APPROVED')) {
          const sinceIso = new Date(
            new Date(invoice.created_at).getTime() - 5 * 60_000,
          ).toISOString();
          existing = await findCompletedPaymentForInvoice({ invoiceId: invoice.id, sinceIso });
        }
        lookupOk = true;
      } catch (err) {
        console.warn(
          '[auto-charge-drain] reconcile lookup failed for',
          invoice.id,
          (err as Error).message,
        );
      }

      if (existing && (existing.status === 'COMPLETED' || existing.status === 'APPROVED')) {
        // Already charged at Square — record it, mark paid, no second charge.
        await admin
          .from('invoices')
          .update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            square_payment_id: existing.paymentId,
            last_auto_charge_at: new Date().toISOString(),
            last_auto_charge_error: null,
            last_charge_attempt: null,
          })
          .eq('id', invoice.id);
        if (invoice.fulfillment_method !== 'ship') {
          await ensurePickupRow(admin, invoice.id, 'auto-charge-drain:reconcile');
        }
        // 0332: log the reconciled payment too — the charge really happened at
        // Square, we just learned about it late. GetPayment carries the same
        // card facts a fresh charge would.
        await recordChargeAttempt(admin, {
          invoiceId: invoice.id,
          operatorId: invoice.operator_id,
          bidderId: bidder.id,
          source: 'auto_charge',
          outcome: 'succeeded',
          amountCents: existing.approvedCents ?? null,
          cardId: bidder.default_payment_method_id,
          squareStatus: existing.status,
          squarePaymentId: existing.paymentId,
          cardFacts: existing.cardFacts,
          attemptNumber: (job.attempt_count ?? 0) + 1,
        });
        await persistBidderCardFacts(admin, bidder.id, existing.cardFacts);
        await enqueueReceiptNotification(bidder.id, invoice);
        await deleteJob(job.invoice_id);
        succeeded++;
        continue;
      }

      if (existing && existing.status === 'PENDING') {
        // A prior charge is still settling at Square — do NOT issue a new one
        // (that would double-charge once it completes). Re-check next tick.
        const nextIso = new Date(Date.now() + 120_000).toISOString();
        await admin
          .from('auto_charge_jobs')
          .update({ next_attempt_at: nextIso })
          .eq('invoice_id', job.invoice_id);
        deferred++;
        continue;
      }

      if (!lookupOk) {
        // Couldn't confirm Square state → defer rather than risk charging an
        // invoice that a prior attempt may already have paid. Next tick retries
        // the reconcile.
        const nextIso = new Date(Date.now() + 120_000).toISOString();
        await admin
          .from('auto_charge_jobs')
          .update({ next_attempt_at: nextIso })
          .eq('invoice_id', job.invoice_id);
        deferred++;
        continue;
      }
    }

    // No saved card → grace + "add a card" push. Bidder returns via the card
    // screen (POST /api/bidder/square/save-card).
    if (!bidder.default_payment_method_id || !bidder.square_customer_id) {
      await flipInvoiceToGrace(
        invoice.id,
        'no_payment_method',
        undefined,
        undefined,
        extraGraceFor(bidder.id, invoice.operator_id),
      );
      await enqueueAddPmNotification(bidder.id, invoice);
      await deleteJob(job.invoice_id);
      skipped++;
      continue;
    }

    // ── Referral/store credit (mig 0229): apply before charging ──────────────
    // Whole-invoice policy: credit covers as much of total_cents as the
    // balance allows; only the remainder hits the card. applyCreditToInvoice
    // is idempotent per invoice, so drain retries can't double-spend.
    let creditApplied = 0;
    try {
      creditApplied = await applyCreditToInvoice(admin, {
        invoiceId: invoice.id,
        bidderId: bidder.id,
        totalCents: invoice.total_cents,
      });
    } catch (err) {
      // Credit is a discount, not a blocker — charge the full amount rather
      // than stall the invoice.
      console.warn('[auto-charge-drain] credit apply failed (charging full):', (err as Error).message);
      creditApplied = 0;
    }
    const chargeCents = invoice.total_cents - creditApplied;

    if (chargeCents <= 0) {
      // Fully covered by credit — no Square call at all.
      await admin
        .from('invoices')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          last_auto_charge_at: new Date().toISOString(),
          last_auto_charge_error: null,
          auto_charge_attempt_count: (job.attempt_count ?? 0) + 1,
          last_charge_attempt: null,
        })
        .eq('id', invoice.id);
      if (invoice.fulfillment_method !== 'ship') {
        await ensurePickupRow(admin, invoice.id, 'auto-charge-drain:credit');
      }
      await enqueueReceiptNotification(bidder.id, invoice);
      await deleteJob(job.invoice_id);
      succeeded++;
      continue;
    }

    // ── Square charge: card-on-file, buyer not present ────────────────────────
    // Per-ATTEMPT key: a fresh attempt gets a fresh key so a declined/updated
    // card can be re-charged (the 2026-07-08 fix). Cross-retry double-charge is
    // now prevented by the reconcile REPLAY above — which re-issues THIS exact
    // key on the next retry — not by the (fragile, capped) ListPayments scan.
    const idemKey = await idempotencyKey45(`inv:${invoice.id}:${(job.attempt_count ?? 0) + 1}`);

    // Persist the attempt BEFORE the network call (mig 0271). If CreatePayment
    // times out with no response (no square_payment_id captured), the next
    // retry's replay uses this exact key to recover the payment or perform the
    // single intended charge.
    await admin
      .from('invoices')
      .update({
        last_charge_attempt: {
          key: idemKey,
          amount_cents: chargeCents,
          card_id: bidder.default_payment_method_id,
        },
      })
      .eq('id', invoice.id);

    try {
      const pay = await chargeCardOnFile({
        customerId: bidder.square_customer_id,
        cardId: bidder.default_payment_method_id,
        amountCents: chargeCents,
        idempotencyKey: idemKey,
        referenceId: invoice.id,
        note: chargeNote,
        // 0293: charge against the auction's warehouse location. Null (no
        // mapping) falls back to the SQUARE_LOCATION_ID env var.
        squareLocationId: squareLocationByAuction.get(invoice.auction_id) ?? null,
      });

      if (pay.status === 'COMPLETED' || pay.status === 'APPROVED') {
        await admin
          .from('invoices')
          .update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            square_payment_id: pay.paymentId,
            last_auto_charge_at: new Date().toISOString(),
            last_auto_charge_error: null,
            auto_charge_attempt_count: (job.attempt_count ?? 0) + 1,
            last_charge_attempt: null,
          })
          .eq('id', invoice.id);
        if (invoice.fulfillment_method !== 'ship') {
          await ensurePickupRow(admin, invoice.id, 'auto-charge-drain:charge');
        }
        // 0332: append to the immutable attempt log and learn the card's type
        // from Square's response (the only place it is ever reported).
        await recordChargeAttempt(admin, {
          invoiceId: invoice.id,
          operatorId: invoice.operator_id,
          bidderId: bidder.id,
          source: 'auto_charge',
          outcome: 'succeeded',
          amountCents: chargeCents,
          cardId: bidder.default_payment_method_id,
          squareStatus: pay.status,
          squarePaymentId: pay.paymentId,
          cardFacts: pay.cardFacts,
          attemptNumber: (job.attempt_count ?? 0) + 1,
        });
        await persistBidderCardFacts(admin, bidder.id, pay.cardFacts);
        await enqueueReceiptNotification(bidder.id, invoice);
        await deleteJob(job.invoice_id);
        succeeded++;
      } else {
        // PENDING / FAILED / CANCELED — treat as a decline. Credit stays APPLIED
        // (#6 fix): the invoice is still owed, so its credit belongs to it — the
        // retry then charges total − credit (the discounted amount). The old
        // reverse-on-decline could never re-apply (applyCreditToInvoice is
        // idempotent per invoice under the one-spend-per-invoice index), so it
        // silently charged the FULL total on every retry. Credit is returned
        // only if the invoice is permanently abandoned (relist/forfeit) — see
        // follow-up; not on a recoverable decline.
        await flipInvoiceToGrace(
          invoice.id,
          `square_${pay.status.toLowerCase()}`,
          pay.paymentId,
          (job.attempt_count ?? 0) + 1,
          extraGraceFor(bidder.id, invoice.operator_id),
        );
        await recordChargeAttempt(admin, {
          invoiceId: invoice.id,
          operatorId: invoice.operator_id,
          bidderId: bidder.id,
          source: 'auto_charge',
          outcome: 'declined',
          amountCents: chargeCents,
          cardId: bidder.default_payment_method_id,
          squareCode: `square_${pay.status.toLowerCase()}`,
          squareStatus: pay.status,
          squarePaymentId: pay.paymentId,
          cardFacts: pay.cardFacts,
          attemptNumber: (job.attempt_count ?? 0) + 1,
        });
        await persistBidderCardFacts(admin, bidder.id, pay.cardFacts);
        await enqueueDeclineNotification(bidder.id, invoice);
        await deleteJob(job.invoice_id);
        failed++;
      }
    } catch (err) {
      // Square decline (SquareApiError.code e.g. CARD_DECLINED, CVV_FAILURE,
      // GENERIC_DECLINE) or an unexpected error. Surface to Sentry at 'warning'
      // (routine declines aren't a page) and flip to grace.
      const code =
        err instanceof SquareApiError
          ? err.errors[0]?.code ?? 'square_error'
          : (err as Error).message ?? 'unknown_square_error';
      Sentry.captureException(err, {
        level: 'warning',
        tags: { worker: 'auto-charge-drain', square_code: String(code) },
        extra: {
          invoice_id: invoice.id,
          operator_id: invoice.operator_id,
          attempt_count: (job.attempt_count ?? 0) + 1,
        },
      });
      // 0332: the issuer's verdict, kept verbatim and permanently. This is the
      // record whose absence made a customer's ten declines undiagnosable —
      // last_auto_charge_error held only the newest code, and settling the
      // invoice at the counter overwrote even that.
      const { code: sqCode, detail: sqDetail } = squareErrorParts(err);
      await recordChargeAttempt(admin, {
        invoiceId: invoice.id,
        operatorId: invoice.operator_id,
        bidderId: bidder.id,
        source: 'auto_charge',
        outcome: err instanceof SquareApiError ? 'declined' : 'error',
        amountCents: chargeCents,
        cardId: bidder.default_payment_method_id,
        squareCode: sqCode,
        squareDetail: sqDetail,
        attemptNumber: (job.attempt_count ?? 0) + 1,
      });
      // Credit stays applied on a recoverable decline (#6 — see the else branch
      // above); it is not reversed here.
      await flipInvoiceToGrace(
        invoice.id,
        String(code),
        undefined,
        (job.attempt_count ?? 0) + 1,
        extraGraceFor(bidder.id, invoice.operator_id),
      );
      await enqueueDeclineNotification(bidder.id, invoice);
      await deleteJob(job.invoice_id);
      failed++;
    }
  }

  return { processed: jobs.length, succeeded, failed, skipped, deferred };
}

// Flip an invoice to payment_failed_grace with a grace_until window. Grace hours
// = operators.auto_charge_grace_hours (default 48) + the bidder's membership
// extra_grace_hours. Optionally records the Square payment id + attempt count.
async function flipInvoiceToGrace(
  invoiceId: string,
  errorReason: string,
  squarePaymentId?: string,
  attemptCount?: number,
  extraGraceHours: number = 0,
): Promise<void> {
  const admin = getSupabaseAdmin();
  const { data: opData } = await admin
    .from('invoices')
    .select('operators(auto_charge_grace_hours)')
    .eq('id', invoiceId)
    .maybeSingle();
  type OpJoin = { operators: { auto_charge_grace_hours: number | null } | null };
  const graceHours =
    (opData as OpJoin | null)?.operators?.auto_charge_grace_hours ?? DEFAULT_GRACE_HOURS;

  const totalGraceHours = graceHours + Math.max(0, extraGraceHours);
  const graceUntil = new Date(Date.now() + totalGraceHours * 60 * 60 * 1000).toISOString();
  const update: Record<string, unknown> = {
    status: 'payment_failed_grace',
    grace_until: graceUntil,
    last_auto_charge_at: new Date().toISOString(),
    last_auto_charge_error: errorReason.slice(0, 500),
  };
  if (typeof attemptCount === 'number') {
    update.auto_charge_attempt_count = attemptCount;
  }
  if (squarePaymentId) {
    update.square_payment_id = squarePaymentId;
  }
  // Never clobber an already-settled invoice. A concurrent Square webhook or
  // the reconcile-before-charge pass can mark this invoice 'paid' (or a refund
  // can land) between the batch snapshot at tick start and this write. Without
  // these guards a stale-snapshot decline flips a genuinely-paid row back to
  // payment_failed_grace and — since nothing here clears paid_at — leaves the
  // invoice in the contradictory (grace + paid_at) state: the customer was
  // charged but is shown as owing. Root cause of the 2026-07-14 report.
  // Mirrors the webhook's own .neq('status','paid') guard.
  const { data: updated, error } = await admin
    .from('invoices')
    .update(update)
    .eq('id', invoiceId)
    .neq('status', 'paid')
    .neq('status', 'refunded')
    .neq('status', 'partially_refunded')
    .select('id');
  if (error) {
    console.error('[auto-charge-drain] grace flip failed for', invoiceId, error.message);
  } else if (!updated || updated.length === 0) {
    // Guard matched no rows — the invoice settled concurrently. Correct
    // outcome: leave it settled, do not grace it.
    console.warn(
      '[auto-charge-drain] grace flip skipped — invoice already settled (paid/refunded):',
      invoiceId,
    );
  }
}

async function deleteJob(invoiceId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  const { error } = await admin.from('auto_charge_jobs').delete().eq('invoice_id', invoiceId);
  if (error) {
    console.error('[auto-charge-drain] job delete failed for', invoiceId, error.message);
  }
}

async function enqueueAddPmNotification(bidderId: string, invoice: InvoiceRow): Promise<void> {
  await safeNotify(bidderId, 'payment_failed', {
    invoice_id: invoice.id,
    reason: 'no_payment_method',
    title: 'Add a payment method to keep your lot',
    lot_code: invoice.primary_lot_code ?? null,
    deep_link: bidderDeepLink('profile/payment-method'),
  });
}

async function enqueueDeclineNotification(bidderId: string, invoice: InvoiceRow): Promise<void> {
  await safeNotify(bidderId, 'payment_failed', {
    invoice_id: invoice.id,
    reason: 'card_declined',
    title: invoice.primary_lot_code
      ? `Your card was declined on lot ${invoice.primary_lot_code}`
      : 'Your card was declined',
    body: 'Update your payment method to keep your lot. Grace varies by operator.',
    lot_code: invoice.primary_lot_code ?? null,
    deep_link: bidderDeepLink(`invoice/${invoice.id}`),
  });
}

// Payment receipt (kind from mig 0167; email template added 2026-07-05).
// The idempotency key is 'receipt:{invoice_id}' — SHARED with the Square
// webhook backstop and the staff mark-paid route, so however an invoice
// reaches 'paid', the bidder gets exactly one receipt.
async function enqueueReceiptNotification(bidderId: string, invoice: InvoiceRow): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin
    .from('notifications_outbox')
    .insert({
      target_user_id: bidderId,
      kind: 'payment_succeeded',
      idempotency_key: `receipt:${invoice.id}`,
      payload: {
        invoice_id: invoice.id,
        amount_cents: invoice.total_cents,
        lot_code: invoice.primary_lot_code ?? null,
        deep_link: bidderDeepLink(`invoice/${invoice.id}`),
      },
    })
    .then(undefined, (err) => {
      console.warn('[auto-charge-drain] receipt enqueue failed:', (err as Error)?.message);
    });
}

async function safeNotify(
  targetUserId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin
    .from('notifications_outbox')
    .insert({
      target_user_id: targetUserId,
      kind,
      idempotency_key: `auto_charge:${kind}:${payload.invoice_id}:${payload.reason ?? 'na'}`,
      payload,
    })
    .then(undefined, (err) => {
      console.warn('[auto-charge-drain] notification enqueue failed:', (err as Error)?.message);
    });
}
