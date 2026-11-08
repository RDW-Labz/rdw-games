// POST /api/invoices/[id]/refund-items — per-item (partial) refund via Square.
//
// HISTORY: the Stripe-era version of this route (refund_jobs queue + per-item
// Stripe refunds) was deleted in the Stripe→Square cutover (3c68ca9) and never
// rebuilt — field-mobile's RefundItemsSheet kept POSTing here and got 404s
// (tester report 2026-07-02). This is the Square-native rebuild: one immediate
// RefundPayment for the item sum (single-account model — money returns from
// the Bingo Square balance), plus one operator_audit_log row per item.
//
// Auth is dual-surface (cookie session OR Bearer token) — identical to
// manual-checkout — because field-mobile calls with a Bearer access token.
//
// Gating (mirrors the original):
//   1. signed-in user (cookie or Bearer)
//   2. operatorCan('refund.in_window') — admin/manager/lead per role matrix
//   3. AAL2 for admin money-movement (require-aal2)
//   4. invoice exists, belongs to caller's operator, status paid/partially_refunded
//   5. a card payment (square_payment_id) when any of the refund is cash;
//      a credit-paid portion returns as store credit with no Square call
//      (2026-10-27: TEA3828564, a $2.52 invoice paid fully with credit, was
//      refused here as no_payment_to_refund although the credit-only path
//      below already handled it)
//   6. pickup completed_at (or checked_in_at) within
//      operator_policies.refund_window_post_pickup_hours, unless
//      admin_can_refund_outside_window && caller can refund.out_of_window
//   7. every item.lot_id is on this invoice's invoice_lots
//   8. item sum <= invoice total
//
// Response mirrors what RefundItemsSheet expects: { job_ids: string[] } —
// there's no job queue anymore, so it carries the Square refund id.

import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { REFUND_CLAIM_WINDOW_SECONDS, refundItemsClaimKey } from '@/lib/refund-claim';
import { z } from 'zod';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { refundPayment, SquareApiError } from '@/lib/square';
import { operatorCan } from '@/lib/operator-can';
import { requireAAL2ForAdmin } from '@/lib/require-aal2';
import { computeRefundSplit } from '@/lib/refund-math';
import { returnRefundCredit } from '@/lib/referral-credits';
import { refundLineRefusal } from '@/lib/refund-copy';

export const runtime = 'nodejs';

const bodySchema = z.object({
  items: z
    .array(
      z.object({
        lot_id: z.string().uuid(),
        amount_cents: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(100),
  sub_reason: z.enum(['defective_item', 'wrong_item', 'damaged_in_transit', 'other']),
  reason_note: z.string().trim().max(500).optional(),
});

async function resolveAuthClient(req: NextRequest): Promise<SupabaseClient> {
  const authHeader = req.headers.get('authorization') ?? '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';
  if (bearerToken) {
    const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
    const anon = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
    if (!url || !anon) throw new Error('Missing Supabase env vars');
    return createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${bearerToken}` } },
    });
  }
  return getSupabaseServer();
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await resolveAuthClient(req);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });

  const { data: staffRow } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .maybeSingle();
  const staff = staffRow as { operator_id: string; role: string } | null;
  if (!staff) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  if (!(await operatorCan(supabase, 'refund.in_window'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const aalCheck = await requireAAL2ForAdmin(supabase);
  if (!aalCheck.ok) return aalCheck.response;

  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues[0]?.message }, { status: 400 });
  }

  const { data: invoiceRow, error: invErr } = await supabase
    .from('invoices')
    .select(
      'id, status, operator_id, bidder_id, total_cents, tax_cents, credit_applied_cents, ' +
        'refunded_cash_cents, refunded_credit_cents, refunded_tax_cents, refunded_at, square_payment_id',
    )
    .eq('id', id)
    .maybeSingle();
  const invoice = invoiceRow as unknown as {
    id: string;
    status: string;
    operator_id: string;
    bidder_id: string;
    total_cents: number;
    tax_cents: number | null;
    credit_applied_cents: number | null;
    refunded_cash_cents: number | null;
    refunded_credit_cents: number | null;
    refunded_tax_cents: number | null;
    refunded_at: string | null;
    square_payment_id: string | null;
  } | null;
  if (invErr || !invoice) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (invoice.operator_id !== staff.operator_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (invoice.status !== 'paid' && invoice.status !== 'partially_refunded') {
    return NextResponse.json(
      { error: `cannot refund from status=${invoice.status}` },
      { status: 409 },
    );
  }
  // ── refund window (operator policy; admin override) ──────────────────
  const { data: pickupRow } = await supabase
    .from('pickups')
    .select('completed_at, checked_in_at')
    .eq('invoice_id', id)
    .maybeSingle();
  const pickup = pickupRow as { completed_at: string | null; checked_in_at: string | null } | null;
  const pickupRefAt = pickup?.completed_at ?? pickup?.checked_in_at ?? null;

  const { data: policyRow } = await supabase
    .from('operator_policies')
    .select('refund_window_post_pickup_hours, admin_can_refund_outside_window')
    .eq('operator_id', staff.operator_id)
    .maybeSingle();
  const policy = policyRow as {
    refund_window_post_pickup_hours: number | null;
    admin_can_refund_outside_window: boolean | null;
  } | null;
  const windowHours = policy?.refund_window_post_pickup_hours ?? 48;

  if (pickupRefAt) {
    const pickupTs = Date.parse(pickupRefAt);
    const inWindow =
      Number.isFinite(pickupTs) && Date.now() <= pickupTs + windowHours * 60 * 60 * 1000;
    if (!inWindow) {
      const adminCanOverride = policy?.admin_can_refund_outside_window ?? true;
      const mayOverride = adminCanOverride && (await operatorCan(supabase, 'refund.override'));
      if (!mayOverride) {
        return NextResponse.json(
          { error: `outside the ${windowHours}h refund window` },
          { status: 409 },
        );
      }
    }
  }

  // ── items must be on this invoice; sum sanity ─────────────────────────
  const { data: invoiceLots } = await supabase
    .from('invoice_lots')
    .select('lot_id, refunded_at, forfeited_at, lots(lot_code, sticker_code, display_code)')
    .eq('invoice_id', id);
  type LineRow = {
    lot_id: string;
    refunded_at: string | null;
    forfeited_at: string | null;
    lots:
      | { lot_code?: string; sticker_code?: string | null; display_code?: string | null }
      | { lot_code?: string; sticker_code?: string | null; display_code?: string | null }[]
      | null;
  };
  const lineByLot = new Map(
    ((invoiceLots ?? []) as unknown as LineRow[]).map((r) => [r.lot_id, r]),
  );
  // Every refusal below is logged: on 2026-10-05 a refusal reached staff as a
  // bare code and nothing on the server said why. Counts and ids only.
  const refuse = (code: string, status: number, extra: Record<string, unknown> = {}) => {
    console.error('[refund-items] refused', { invoice_id: id, code, actor: user.id, ...extra });
    return NextResponse.json({ error: code, ...extra }, { status });
  };
  // Lines the counter reported missing on this invoice's pickup (mig 0393).
  // Their refund is owed even when the no-show sweep stamped them forfeited
  // (it did until 0393): a missing item was never the customer's to forfeit.
  // Looked up only when a requested line is forfeited.
  const reportedMissing = new Set<string>();
  const forfeitedAsked = body.data.items.some((i) => lineByLot.get(i.lot_id)?.forfeited_at);
  if (forfeitedAsked) {
    const { data: pickupIds, error: pkErr } = await supabase
      .from('pickups')
      .select('id')
      .eq('invoice_id', id);
    const ids = ((pickupIds ?? []) as { id: string }[]).map((p) => p.id);
    const { data: missingRows, error: moErr } = ids.length
      ? await supabase
          .from('pickup_lot_outcomes')
          .select('lot_id')
          .in('pickup_id', ids)
          .eq('outcome', 'missing')
      : { data: [], error: null };
    if (pkErr || moErr) {
      console.error('[refund-items] missing-outcome lookup failed', (pkErr ?? moErr)?.message);
      return refuse('refund_failed', 500);
    }
    for (const r of (missingRows ?? []) as { lot_id: string }[]) reportedMissing.add(r.lot_id);
  }
  for (const item of body.data.items) {
    const line = lineByLot.get(item.lot_id);
    if (!line) return refuse('lot_not_in_invoice', 400, { lot_id: item.lot_id });
    const lot = Array.isArray(line.lots) ? line.lots[0] : line.lots;
    const lotCode = lot?.display_code ?? lot?.sticker_code ?? lot?.lot_code ?? null;
    // 2026-10-05: the same line was refunded twice, 40 s apart, because only
    // the invoice-wide remaining amount was checked. A refunded line is done.
    const refusal = refundLineRefusal(line, reportedMissing.has(item.lot_id));
    if (refusal === 'lot_already_refunded') {
      return refuse('lot_already_refunded', 409, {
        lot_id: item.lot_id,
        lot_code: lotCode,
        refunded_at: line.refunded_at,
      });
    }
    if (refusal === 'lot_forfeited') {
      return refuse('lot_forfeited', 409, { lot_id: item.lot_id, lot_code: lotCode });
    }
  }
  // Per-lot refundable amounts are each computed independently as
  // hammer + Math.round(premium × ratio) + Math.round(tax × ratio)
  // (see lib/refund-math computeLotFullRefundableCents). Because each lot's
  // tax/premium share is rounded on its own, selecting EVERY lot can sum to a
  // few cents ABOVE the invoice total — e.g. a $15.11 invoice whose $1.31 tax
  // splits 65.5¢/65.5¢ rounds to 66¢+66¢, making two lots total $15.12 and
  // tripping the old hard guard (staff report 2026-07-10). The
  // customer only ever paid invoice.total_cents, so absorb a small rounding
  // overshoot by trimming it off the largest line (keeps audit rows == the
  // Square refund) and refund exactly what they paid. Reject only a genuine
  // over-refund beyond the rounding tolerance.
  // Refund accounting (mig 0270): guard the FACE sum against what's still
  // refundable (total - already-refunded face), NOT total_cents, so successive
  // partials can't over-refund. Then split the face sum into cash (capped at
  // captured = total - credit_applied) + credit returned to the bidder.
  const totalCents = invoice.total_cents;
  const creditApplied = invoice.credit_applied_cents ?? 0;
  const priorCash = invoice.refunded_cash_cents ?? 0;
  const priorCredit = invoice.refunded_credit_cents ?? 0;
  const priorTax = invoice.refunded_tax_cents ?? 0;
  const remainingFace = Math.max(0, totalCents - (priorCash + priorCredit));

  const items = body.data.items.map((i) => ({ ...i }));
  const rawSum = items.reduce((acc, i) => acc + i.amount_cents, 0);
  let sumCents = rawSum;
  if (rawSum > remainingFace) {
    const overshoot = rawSum - remainingFace;
    // Each lot contributes at most ~1¢ of premium + ~1¢ of tax rounding.
    const roundingTolerance = items.length * 2;
    if (overshoot > roundingTolerance) {
      return refuse('refund_exceeds_invoice_total', 400, {
        requested_cents: rawSum,
        remaining_cents: remainingFace,
      });
    }
    // Trim the overshoot off the largest-amount line (guaranteed >> overshoot
    // for any real lot, but floored at 1¢ defensively).
    let idxMax = 0;
    for (let i = 1; i < items.length; i++) {
      if (items[i]!.amount_cents > items[idxMax]!.amount_cents) idxMax = i;
    }
    items[idxMax]!.amount_cents = Math.max(1, items[idxMax]!.amount_cents - overshoot);
    sumCents = items.reduce((acc, i) => acc + i.amount_cents, 0);
  }
  if (sumCents <= 0) {
    return refuse('nothing_left_to_refund', 409, { remaining_cents: remainingFace });
  }

  const split = computeRefundSplit({
    totalCents,
    creditAppliedCents: creditApplied,
    refundedCashCents: priorCash,
    taxCents: invoice.tax_cents ?? 0,
    requestedFaceCents: sumCents,
  });
  // Square can only return what it captured. A cash portion with no card
  // payment means the invoice was settled offline (cash/check at the counter).
  const squarePaymentId = invoice.square_payment_id;
  if (split.cashCents > 0 && !squarePaymentId) {
    return refuse('no_card_payment', 409, { cash_cents: split.cashCents });
  }

  // ── one Square refund for the CASH portion (skipped when fully credit) ─
  // ── in-flight claim (mig 0389) ─────────────────────────────────────────
  // The per-line check above stops a SECOND click after the first finished.
  // This stops the second click while the first is still running: the same
  // refund shape on this invoice is refused for a minute, released early when
  // this request completes. A crashed request's claim expires on its own.
  const admin = getSupabaseAdmin();
  const claimKey = refundItemsClaimKey(
    id,
    items.map((i) => i.lot_id),
    sumCents,
  );
  const claim = await admin.rpc('claim_refund', {
    p_invoice_id: id,
    p_claim_key: claimKey,
    p_window_seconds: REFUND_CLAIM_WINDOW_SECONDS,
    p_claimed_by: user.id,
  });
  if (claim.error) {
    console.error('[refund-items] claim_refund failed', claim.error.message);
    return refuse('refund_failed', 500);
  }
  if (claim.data !== true) {
    return refuse('refund_in_flight', 409, { retry_after_seconds: REFUND_CLAIM_WINDOW_SECONDS });
  }
  try {
    let refund: { refundId: string; status: string } = { refundId: '', status: 'CREDIT_ONLY' };
    if (split.cashCents > 0) {
      try {
        refund = await refundPayment({
          paymentId: squarePaymentId as string,
          amountCents: split.cashCents,
          // Keyed on (invoice, SORTED lot set, cash, prior cash) via a short sha256.
          // A network retry of the SAME submission reuses the Square refund instead
          // of double-refunding; two SEPARATE single-item refunds on the same
          // invoice for the same dollar amount (common — auctions have many
          // same-priced lots) no longer collide (prior cash makes sequential
          // refunds distinct). 'refi:' + 32 hex = 37 chars, under the 45-char cap.
          idempotencyKey: `refi:${createHash('sha256')
            .update(
              `${id}|${items
                .map((i) => i.lot_id)
                .sort()
                .join(',')}|${split.cashCents}|${priorCash}`,
            )
            .digest('hex')
            .slice(0, 32)}`,
          reason: 'requested_by_customer',
        });
      } catch (err) {
        if (err instanceof SquareApiError) {
          console.error('[refund-items] square refund failed', {
            invoice_id: id,
            payment_id: invoice.square_payment_id,
            code: err.errors[0]?.code,
            detail: err.errors[0]?.detail,
          });
          return NextResponse.json(
            {
              error:
                'Refund could not be created. ' +
                (err.errors[0]?.detail ?? 'Try again or contact support.'),
            },
            { status: 400 },
          );
        }
        console.error('[refund-items] unexpected error', (err as Error).message);
        return NextResponse.json({ error: 'refund_failed' }, { status: 500 });
      }
    }

    // Credit side (mig 0270): return the consumed store credit to the bidder so a
    // credit-discounted purchase isn't shortchanged on refund. Best-effort.
    if (split.creditCents > 0 && invoice.bidder_id) {
      await returnRefundCredit(admin, {
        bidderId: invoice.bidder_id,
        invoiceId: id,
        amountCents: split.creditCents,
      });
    }

    // ── audit rows (service-role; no client INSERT policy on the log) ─────
    const auditRows = items.map((item) => ({
      operator_id: invoice.operator_id,
      actor_user_id: user.id,
      action_type: 'invoice.refund_item',
      target_id: invoice.id,
      before_state: null,
      after_state: {
        lot_id: item.lot_id,
        amount_cents: item.amount_cents,
        square_refund_id: refund.refundId || null,
        sub_reason: body.data.sub_reason,
        reason_note: body.data.reason_note ?? null,
      },
    }));
    const { error: auditErr } = await admin.from('operator_audit_log').insert(auditRows);
    if (auditErr) {
      // The money already moved — never fail the request over the audit write,
      // but make the gap loud in logs.
      console.error('[refund-items] audit insert failed', auditErr.message);
    }

    // Accumulate refund totals + set status (admin, error-checked). Full when the
    // whole FACE value (cash + credit) has been refunded, so a credit-covered
    // invoice reaches 'refunded'. square.webhook still reconciles on refund.updated.
    const newCash = priorCash + split.cashCents;
    const newCredit = priorCredit + split.creditCents;
    const isFull = newCash + newCredit >= totalCents;
    const { error: updErr } = await admin
      .from('invoices')
      .update({
        refunded_cash_cents: newCash,
        refunded_credit_cents: newCredit,
        refunded_tax_cents: priorTax + split.taxCents,
        ...(refund.refundId ? { square_refund_id: refund.refundId } : {}),
        status: isFull ? 'refunded' : 'partially_refunded',
        // Nothing ever set this — the operator invoice page reads it, so every
        // refunded invoice showed a blank refund date. First refund wins.
        refunded_at: invoice.refunded_at ?? new Date().toISOString(),
      })
      .eq('id', id);
    if (updErr) {
      console.error(
        '[refund-items] CRITICAL: money moved but invoice update failed',
        id,
        updErr.message,
      );
    }

    // ── per-lot refund stamp + pickup reconciliation (mig 0245) ───────────
    // A refunded lot is no longer owed: stamp invoice_lots.refunded_at so the
    // Pickup Pass / staff checkout drop it, and close the pickup once nothing
    // on the invoice is owed anymore (otherwise it strands on the dashboard
    // with only the destructive No-show/Forfeit actions enabled).
    const refundedAt = new Date().toISOString();
    const { error: stampErr } = await admin
      .from('invoice_lots')
      .update({ refunded_at: refundedAt })
      .eq('invoice_id', id)
      .in(
        'lot_id',
        items.map((i) => i.lot_id),
      )
      .is('refunded_at', null);
    if (stampErr) console.error('[refund-items] refunded_at stamp failed', stampErr.message);

    const { count: owedCount } = await admin
      .from('invoice_lots')
      .select('lot_id', { count: 'exact', head: true })
      .eq('invoice_id', id)
      .is('picked_up_at', null)
      .is('refunded_at', null);
    if ((owedCount ?? 0) === 0) {
      const { error: closeErr } = await admin
        .from('pickups')
        .update({ status: 'completed', completed_at: refundedAt })
        .eq('invoice_id', id)
        .in('status', ['pending', 'scheduled', 'checked_in']);
      if (closeErr) console.error('[refund-items] pickup auto-complete failed', closeErr.message);
    }

    return NextResponse.json({
      job_ids: refund.refundId ? [refund.refundId] : [],
      cash_cents: split.cashCents,
      credit_cents: split.creditCents,
    });
  } finally {
    const rel = await admin.rpc('release_refund', { p_invoice_id: id, p_claim_key: claimKey });
    if (rel.error) console.error('[refund-items] release_refund failed', rel.error.message);
  }
}
