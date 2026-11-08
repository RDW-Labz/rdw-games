// POST /api/bidders/me/pay-fees
//
// Settle a bidder's outstanding relot fees (bidders.unpaid_fees_cents > 0) in
// one tap: charge their Square card-on-file (buyer NOT present), then clear the
// fee ledger + zero the aggregate so place_bid's `unpaid_fees` gate (mig 0105)
// lets them bid again. This is the Square replacement for the old Stripe
// pay-fees endpoint the two clients were built against.
//
// WHY THE PLURAL `/api/bidders/` PATH: both the web form
// (profile/pay-fees/PayFeesForm.tsx) and the ALREADY-SHIPPED mobile screen
// (bidder-app/app/profile/pay-fees.tsx) POST to `/api/bidders/me/pay-fees`.
// Living at that exact path means no client change and the deployed bidder app
// works without a rebuild — hence plural here, not the singular `/api/bidder/`
// convention used by save-card etc.
//
// Response contract (consumed verbatim by both clients — see their reason maps):
//   200 { ok: true,  charged_cents }                       — charged (or $0 owed)
//   402 { ok: false, reason: 'no_payment_method' }         — no card on file
//   402 { ok: false, reason: 'card_declined', detail }     — Square declined
//   401 { error: 'not_authenticated' } / 403 { error: 'not_a_bidder' }
//   500 { ok: false, error: 'pay_fees_failed' | 'fees_charged_not_cleared' }

import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { chargeCardOnFile, SquareApiError } from '@/lib/square';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
  }

  const admin = getSupabaseAdmin();

  // Read card + balance with the admin client: square_customer_id can be
  // RLS-hidden from the bidder and we need it to charge. The fee-clear RPC
  // below is service_role only too (mig 0435).
  const { data: bidder, error: bidderErr } = await admin
    .from('bidders')
    .select('id, unpaid_fees_cents, square_customer_id, default_payment_method_id')
    .eq('id', caller.userId)
    .maybeSingle();
  if (bidderErr) {
    return NextResponse.json({ ok: false, error: 'bidder_lookup_failed' }, { status: 500 });
  }
  if (!bidder) {
    return NextResponse.json({ error: 'not_a_bidder' }, { status: 403 });
  }

  const unpaidCents = (bidder.unpaid_fees_cents as number | null) ?? 0;

  // Nothing owed — idempotent success. Clients bounce to /profile. Covers the
  // double-submit race where a prior request already cleared the balance.
  if (unpaidCents <= 0) {
    return NextResponse.json({ ok: true, charged_cents: 0 });
  }

  const customerId = bidder.square_customer_id as string | null;
  const cardId = bidder.default_payment_method_id as string | null;
  if (!customerId || !cardId) {
    return NextResponse.json({ ok: false, reason: 'no_payment_method' }, { status: 402 });
  }

  // Idempotency: key on the newest unpaid ledger row id. A double-submit of the
  // SAME balance reuses the key → Square replays the one payment (no double
  // charge); a later balance (new ledger rows after this clears) gets a fresh
  // key → charges again. Fallback to the bidder id if the aggregate is set but
  // no ledger rows exist (data drift) — still dedupes repeat attempts.
  const { data: newestFee } = await admin
    .from('bidder_fee_ledger')
    .select('id')
    .eq('bidder_id', caller.userId)
    .is('paid_at', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  const idempotencyKey = newestFee?.id ? `sqfee:${newestFee.id}` : `sqfee:${caller.userId}`;

  try {
    const pay = await chargeCardOnFile({
      customerId,
      cardId,
      amountCents: unpaidCents,
      idempotencyKey,
      referenceId: caller.userId,
      note: 'BinGo relot fees',
    });

    if (pay.status !== 'COMPLETED' && pay.status !== 'APPROVED') {
      // PENDING / FAILED / CANCELED — treat as a decline; do NOT clear fees.
      return NextResponse.json(
        { ok: false, reason: 'card_declined', detail: `square_${pay.status.toLowerCase()}` },
        { status: 402 },
      );
    }

    // Charge cleared → mark ledger paid + zero unpaid_fees_cents. Mig 0435:
    // service_role only, keyed on the verified caller. The old caller-keyed
    // clear_paid_relot_fees let any signed-in bidder clear fees without paying.
    const { error: clearErr } = await admin.rpc('clear_relot_fees_for_bidder', {
      p_bidder_id: caller.userId,
      p_payment_id: pay.paymentId,
    });
    if (clearErr) {
      // Money left the card but the ledger didn't clear. Loud alert so it's
      // reconciled. Safe to retry: the same balance yields the same idempotency
      // key, so a re-POST replays this exact payment (no double charge) and
      // re-runs the clear.
      Sentry.captureException(new Error('pay-fees: charged but clear_paid_relot_fees failed'), {
        level: 'error',
        tags: { route: 'bidders/pay-fees' },
        extra: {
          bidder_id: caller.userId,
          payment_id: pay.paymentId,
          charged_cents: unpaidCents,
          db_error: clearErr.message,
        },
      });
      console.error(
        '[bidders/pay-fees] charge succeeded but clear failed',
        caller.userId,
        pay.paymentId,
        clearErr.message,
      );
      return NextResponse.json(
        { ok: false, error: 'fees_charged_not_cleared', detail: pay.paymentId },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, charged_cents: unpaidCents });
  } catch (err) {
    if (err instanceof SquareApiError) {
      // e.g. CARD_DECLINED, CVV_FAILURE, GENERIC_DECLINE — surface the code but
      // keep the client-facing reason in its known set so the "Update card" CTA
      // fires. Fees are untouched (nothing charged).
      const code = err.errors[0]?.code ?? 'card_error';
      return NextResponse.json(
        { ok: false, reason: 'card_declined', detail: code },
        { status: 402 },
      );
    }
    console.error('[bidders/pay-fees] unexpected error:', (err as Error).message);
    return NextResponse.json({ ok: false, error: 'pay_fees_failed' }, { status: 500 });
  }
}
