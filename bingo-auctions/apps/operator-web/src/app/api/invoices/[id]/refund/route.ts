// Refund an invoice (full or partial) via Square. Operator staff (manager+) only.
//
// Single-account model: the original charge was a plain Square payment on the
// one Bingo location (no Connect, no application fee, no operator settlement
// reversal — all of which the old Stripe destination-charge flow had to undo).
// So a refund is just RefundPayment against the invoice's square_payment_id; the
// money returns from the Bingo balance directly. The square.webhook reconciles
// the final refund state asynchronously.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { refundPayment, SquareApiError } from '@/lib/square';
import { requireAAL2ForAdmin } from '@/lib/require-aal2';
import { computeRefundSplit } from '@/lib/refund-math';
import { REFUND_CLAIM_WINDOW_SECONDS, refundAmountClaimKey } from '@/lib/refund-claim';
import { returnRefundCredit } from '@/lib/referral-credits';

export const runtime = 'nodejs';

const bodySchema = z.object({
  amountCents: z.number().int().positive().optional(),
  reason: z
    .enum(['duplicate', 'fraudulent', 'requested_by_customer'])
    .optional()
    .default('requested_by_customer'),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!['admin', 'manager'].includes(staff.role as string)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // AAL2 gate — refunds are admin money-movement (see lib/require-aal2.ts).
  const aalCheck = await requireAAL2ForAdmin(supabase);
  if (!aalCheck.ok) return aalCheck.response;

  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues[0]?.message }, { status: 400 });
  }

  const { data: invoiceRow, error } = await supabase
    .from('invoices')
    .select(
      'id, status, operator_id, bidder_id, total_cents, tax_cents, credit_applied_cents, ' +
        'refunded_cash_cents, refunded_credit_cents, refunded_tax_cents, refunded_at, square_payment_id',
    )
    .eq('id', id)
    .single();
  // Cast through unknown: refunded_* columns (mig 0270) aren't in the generated
  // DB types yet, so the select otherwise widens to GenericStringError.
  const invoice = invoiceRow as unknown as {
    id: string;
    status: string;
    operator_id: string;
    bidder_id: string | null;
    total_cents: number;
    tax_cents: number | null;
    credit_applied_cents: number | null;
    refunded_cash_cents: number | null;
    refunded_credit_cents: number | null;
    refunded_tax_cents: number | null;
    refunded_at: string | null;
    square_payment_id: string | null;
  } | null;
  if (error || !invoice) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  if (invoice.operator_id !== staff.operator_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (invoice.status !== 'paid' && invoice.status !== 'partially_refunded') {
    return NextResponse.json(
      { error: `cannot refund from status=${invoice.status}` },
      { status: 409 },
    );
  }

  // ── Refund accounting (mig 0270) ──────────────────────────────────────────
  // The card was only charged `captured = total - credit_applied`; refunds must
  // guard cash against captured, not total_cents, and return the credit portion
  // to the bidder. `requested` is a FACE amount (what the customer is made whole
  // by); it splits into cash (to the card) + credit (to their balance).
  const totalCents = (invoice.total_cents as number) ?? 0;
  const creditApplied = (invoice.credit_applied_cents as number) ?? 0;
  const priorCash = (invoice.refunded_cash_cents as number) ?? 0;
  const priorCredit = (invoice.refunded_credit_cents as number) ?? 0;
  const priorTax = (invoice.refunded_tax_cents as number) ?? 0;
  const refundedFace = priorCash + priorCredit;
  const remainingFace = Math.max(0, totalCents - refundedFace);

  const requestedFace = Math.min(body.data.amountCents ?? remainingFace, remainingFace);
  if (requestedFace <= 0) {
    console.error('[refund] refused', {
      invoice_id: id,
      code: 'nothing_left_to_refund',
      actor: user.id,
      remaining_cents: remainingFace,
    });
    return NextResponse.json(
      { error: 'nothing_left_to_refund', remaining_cents: remainingFace },
      { status: 409 },
    );
  }

  const split = computeRefundSplit({
    totalCents,
    creditAppliedCents: creditApplied,
    refundedCashCents: priorCash,
    taxCents: (invoice.tax_cents as number) ?? 0,
    requestedFaceCents: requestedFace,
  });
  // Square can only return what it captured: a credit-paid invoice refunds as
  // store credit (no Square call); a cash portion with no card payment means
  // the invoice was settled offline (2026-10-27, TEA3828564).
  if (split.cashCents > 0 && !invoice.square_payment_id) {
    console.error('[refund] refused', { invoice_id: id, code: 'no_card_payment', actor: user.id });
    return NextResponse.json({ error: 'no_card_payment', cash_cents: split.cashCents }, { status: 409 });
  }

  // Cash side → Square (skipped when the whole refund is credit, e.g. a
  // fully-credit-covered invoice). Keyed on (invoice, cash, prior cash) so
  // sequential refunds of the same amount never collide (the prior bug keyed on
  // amount alone and silently replayed the first refund).
  // ── in-flight claim (mig 0389): the same amount on this invoice, once a minute.
  const admin = getSupabaseAdmin();
  const claimKey = refundAmountClaimKey(id, requestedFace);
  const claim = await admin.rpc('claim_refund', {
    p_invoice_id: id,
    p_claim_key: claimKey,
    p_window_seconds: REFUND_CLAIM_WINDOW_SECONDS,
    p_claimed_by: user.id,
  });
  if (claim.error) {
    console.error('[refund] claim_refund failed', claim.error.message);
    return NextResponse.json({ error: 'refund_failed' }, { status: 500 });
  }
  if (claim.data !== true) {
    console.error('[refund] refused', {
      invoice_id: id,
      code: 'refund_in_flight',
      actor: user.id,
      requested_cents: requestedFace,
    });
    return NextResponse.json(
      { error: 'refund_in_flight', retry_after_seconds: REFUND_CLAIM_WINDOW_SECONDS },
      { status: 409 },
    );
  }
  try {
    let refundId: string | null = null;
    if (split.cashCents > 0) {
      try {
        const refund = await refundPayment({
          paymentId: invoice.square_payment_id as string,
          amountCents: split.cashCents,
          idempotencyKey: `ref:${id.replace(/-/g, '')}:${split.cashCents}:${priorCash}`,
          reason: body.data.reason,
        });
        refundId = refund.refundId;
      } catch (err) {
        if (err instanceof SquareApiError) {
          console.error('[refund] square refund failed', {
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
        console.error('[refund] unexpected error', (err as Error).message);
        return NextResponse.json({ error: 'refund_failed' }, { status: 500 });
      }
    }

    // Credit side → return the consumed store credit to the bidder (best-effort).
    if (split.creditCents > 0 && invoice.bidder_id) {
      await returnRefundCredit(admin, {
        bidderId: invoice.bidder_id as string,
        invoiceId: id,
        amountCents: split.creditCents,
      });
    }

    // Accumulate + set status (admin client, error-checked — the money already
    // moved, so a silent RLS failure here must be loud). Full when the whole face
    // value has been refunded (cash + credit), so a credit-covered invoice can
    // correctly reach 'refunded'.
    const newCash = priorCash + split.cashCents;
    const newCredit = priorCredit + split.creditCents;
    const isFull = newCash + newCredit >= totalCents;
    const { error: updErr } = await admin
      .from('invoices')
      .update({
        refunded_cash_cents: newCash,
        refunded_credit_cents: newCredit,
        refunded_tax_cents: priorTax + split.taxCents,
        ...(refundId ? { square_refund_id: refundId } : {}),
        status: isFull ? 'refunded' : 'partially_refunded',
        // Nothing ever set this — the operator invoice page reads it, so every
        // refunded invoice showed a blank refund date. First refund wins.
        refunded_at: invoice.refunded_at ?? new Date().toISOString(),
      })
      .eq('id', id);
    if (updErr) {
      console.error('[refund] CRITICAL: money moved but invoice update failed', id, updErr.message);
    }
    // A fully refunded invoice owes the customer nothing, so no line on it is
    // still "Owed". Stamp the ones that were neither collected, refunded nor
    // forfeited, or the invoice page keeps showing them as owed after the money
    // went back (2026-10-05: a $13.20 balance refund left a $45 item "Owed").
    if (isFull) {
      const { error: lineErr } = await admin
        .from('invoice_lots')
        .update({ refunded_at: new Date().toISOString() })
        .eq('invoice_id', id)
        .is('refunded_at', null)
        .is('picked_up_at', null)
        .is('forfeited_at', null);
      if (lineErr)
        console.error('[refund] line stamp after full refund failed', id, lineErr.message);
    }

    // Audit trail (was missing on this route).
    await admin
      .from('operator_audit_log')
      .insert({
        operator_id: invoice.operator_id,
        actor_user_id: user.id,
        action_type: 'invoice.refund',
        target_id: id,
        before_state: { refunded_cash_cents: priorCash, refunded_credit_cents: priorCredit },
        after_state: {
          cash_cents: split.cashCents,
          credit_cents: split.creditCents,
          square_refund_id: refundId,
          reason: body.data.reason,
        },
      })
      .then(undefined, (e: unknown) =>
        console.error('[refund] audit insert failed', (e as Error)?.message),
      );

    return NextResponse.json({
      refundId,
      amount: requestedFace,
      cashCents: split.cashCents,
      creditCents: split.creditCents,
    });
  } finally {
    const rel = await admin.rpc('release_refund', { p_invoice_id: id, p_claim_key: claimKey });
    if (rel.error) console.error('[refund] release_refund failed', rel.error.message);
  }
}
