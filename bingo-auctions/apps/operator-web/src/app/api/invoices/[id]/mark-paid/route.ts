// POST /api/invoices/[id]/mark-paid
//
// Operator-initiated OFFLINE payment. Marks an unpaid invoice 'paid' WITHOUT a
// card charge. Two uses:
//   1. Cash / check / other off-platform payment collected at pickup — a
//      PERMANENT capability (auctions take in-person cash buyers).
//   2. Payments-disabled mode (migration 0198): advance close→win→paid so the
//      fulfillment loop (checkout/queue, pickup-verify — both gate on
//      status='paid') is testable without a live processor.
//
// Auth: operator admin/manager of the invoice's operator (mirrors the refund
// route). AAL2-gated for admins with a TOTP factor (money-state mutation).
//
// Guards:
//   • only from a non-terminal UNPAID state (pending / payment_failed_grace);
//     never from paid / refunded / canceled.
//   • NOT while the invoice's auction still has live/scheduled lots — marking
//     paid early would let build_invoices_for_auction (ON CONFLICT WHERE
//     status='pending') strand later-closing wins (the same money-leak the
//     auto-charge worker's settled-gate prevents).
//
// No processor call or settlement/transfer row is created. Any pending
// auto_charge_jobs row is dropped so the worker does not charge it later.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { bidderDeepLink } from '@/lib/app-links';
import { primaryLotDisplayCode } from '@/lib/invoice-lot-code';
import { requireAAL2ForAdmin } from '@/lib/require-aal2';
import { recordChargeAttempt } from '@/lib/charge-attempts';
import { ensurePickupRow } from '@/lib/pickup-row';

export const runtime = 'nodejs';

const PAYABLE_FROM = ['pending', 'payment_failed_grace'] as const;

// Both optional — the console button may post no body at all (back-compat for
// any existing caller), and a bare offline settlement with no note is still a
// valid staff action.
const bodySchema = z.object({
  method: z.enum(['cash', 'check', 'card_terminal', 'other']).optional(),
  reason: z.string().trim().max(500).optional(),
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

  // Money-state mutation → same AAL2 gate as refunds (admins with a TOTP factor).
  const aalCheck = await requireAAL2ForAdmin(supabase);
  if (!aalCheck.ok) return aalCheck.response;

  // A missing/empty body is fine (back-compat with any caller that still posts
  // no payload) — only a body that fails to PARSE as JSON falls back to {}.
  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues[0]?.message }, { status: 400 });
  }

  // Service-role read: a payment_failed_grace invoice may be hidden by some RLS
  // policies; operator identity is already proven above.
  const admin = getSupabaseAdmin();
  const { data: invoice, error } = await admin
    .from('invoices')
    .select(
      'id, status, operator_id, auction_id, fulfillment_method, bidder_id, total_cents, paid_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'lookup_failed' }, { status: 500 });
  if (!invoice) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  if (invoice.operator_id !== staff.operator_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!PAYABLE_FROM.includes(invoice.status as (typeof PAYABLE_FROM)[number])) {
    return NextResponse.json(
      { error: `cannot mark paid from status=${invoice.status}` },
      { status: 409 },
    );
  }

  // Money-leak guard: don't mark paid while the auction still has open lots, or
  // build_invoices_for_auction can no longer extend this (now non-pending)
  // invoice with later-closing wins.
  if (invoice.auction_id) {
    const { data: openLots, error: lotsErr } = await admin
      .from('lots')
      .select('id')
      .eq('auction_id', invoice.auction_id as string)
      .in('status', ['live', 'scheduled'])
      .is('deleted_at', null)
      .limit(1);
    if (lotsErr) return NextResponse.json({ error: 'settle_check_failed' }, { status: 500 });
    if (openLots && openLots.length > 0) {
      return NextResponse.json({ error: 'auction_not_settled' }, { status: 409 });
    }
  }

  const paidAt = new Date().toISOString();
  const { error: updErr } = await admin
    .from('invoices')
    .update({
      status: 'paid',
      paid_at: paidAt,
      // 0332: last_auto_charge_error is NOT touched here any more. Stamping
      // 'offline_paid_by_operator' over it destroyed the issuer's decline code
      // — the reason a customer's card failed was erased by the very act of
      // rescuing them at the counter (customer report: ten declines, no surviving
      // code). The offline settlement is recorded in charge_attempts instead,
      // which is append-only.
    })
    .eq('id', invoice.id);
  if (updErr) {
    return NextResponse.json({ error: 'update_failed', detail: updErr.message }, { status: 500 });
  }

  // charge_attempts has no actor column (mig 0332) — it's an append-only
  // record of WHAT happened to the money, not WHO acted; WHO belongs in
  // operator_audit_log below. Not adding one here (no migrations in this PR).
  await recordChargeAttempt(admin, {
    invoiceId: invoice.id as string,
    operatorId: invoice.operator_id as string,
    bidderId: invoice.bidder_id as string | null,
    source: 'offline_mark_paid',
    outcome: 'settled_offline',
    amountCents: invoice.total_cents as number,
  });

  // Audit trail (was missing on this route — 4 prod invoices were marked paid
  // offline with no record of who did it or why). The invoices.update above
  // already committed the real-world fact (cash/check was collected at the
  // counter), so — same choice as the refund route and pay-fees' post-charge
  // ledger write — a failure here must NOT fail this response: that would
  // tell staff the payment didn't register when it did. Log loudly + report to
  // Sentry so it gets reconciled instead.
  const { error: auditErr } = await admin.from('operator_audit_log').insert({
    operator_id: invoice.operator_id as string,
    actor_user_id: user.id,
    action_type: 'invoice.mark_paid_offline',
    target_id: invoice.id as string,
    before_state: { status: invoice.status, paid_at: invoice.paid_at ?? null },
    after_state: {
      status: 'paid',
      paid_at: paidAt,
      amount_cents: invoice.total_cents,
      method: body.data.method ?? null,
    },
    reason_note: body.data.reason ?? null,
  });
  if (auditErr) {
    Sentry.captureException(new Error('mark-paid: invoice paid but audit_log insert failed'), {
      level: 'error',
      tags: { route: 'invoices/mark-paid' },
      extra: {
        invoice_id: invoice.id,
        operator_id: invoice.operator_id,
        actor_user_id: user.id,
        db_error: auditErr.message,
      },
    });
    console.error('[mark-paid] audit_log insert failed', invoice.id, auditErr.message);
  }

  // Preserve the existing pickup behavior (mig 0094/0095): create the idempotent pickups
  // row so the bidder app can render the QR check-in token the moment the
  // invoice is paid. Ship invoices skip this — they go to the shipping queue
  // instead. ON CONFLICT DO NOTHING in the RPC makes this safe to re-run, and
  // a failure here must never fail the (already committed) mark-paid.
  if (invoice.fulfillment_method !== 'ship') {
    await ensurePickupRow(admin, invoice.id as string, 'mark-paid');
  }

  // Payment receipt to the bidder — cash/check collected in person is still a
  // payment they should get written confirmation of. Shared idempotency key
  // 'receipt:{invoice_id}' with the auto-charge worker + Square webhook means
  // exactly one receipt however the invoice reached 'paid'.
  await admin
    .from('notifications_outbox')
    .insert({
      target_user_id: invoice.bidder_id,
      kind: 'payment_succeeded',
      idempotency_key: `receipt:${invoice.id}`,
      payload: {
        invoice_id: invoice.id,
        amount_cents: invoice.total_cents,
        lot_code: await primaryLotDisplayCode(admin, invoice.id),
        deep_link: bidderDeepLink(`invoice/${invoice.id}`),
      },
    })
    .then(undefined, (err: unknown) => {
      console.warn('[mark-paid] receipt enqueue failed:', (err as Error)?.message);
    });

  // Drop any pending auto-charge job so the worker doesn't try to charge.
  await admin.from('auto_charge_jobs').delete().eq('invoice_id', invoice.id);

  return NextResponse.json({ ok: true });
}
