// POST /api/bidder/promo/redeem — redeem a promo code for BinGo credit
// (mig 0268). Body: { code }.
//
// The minted 'promo' credit is auto-applied to the bidder's next invoice by
// the auto-charge drain, before the Square charge — same bridge referral
// (0229) and loyalty (0237) credit use. There is no bidder "checkout" to
// apply a code at; the auction auto-charges the card on file at close.
//
// Idempotency: the bidder_credits partial UNIQUE index (promo_code_id,
// bidder_id) WHERE reason='promo' makes redemption exactly-once per
// (code, bidder) — a replay inserts, hits 23505, and reports the same
// "already redeemed" outcome without double-minting.

import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

const UNIQUE_VIOLATION = '23505';

// Invoice statuses that mean the bidder has already transacted — used by the
// 'new_bidders_only' eligibility gate.
const PAID_STATUSES = ['paid', 'partially_refunded', 'refunded'];

export async function POST(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 });
  }
  const code = (body.code ?? '').trim().toUpperCase();
  if (!code || code.length > 40) {
    return NextResponse.json({ ok: false, error: 'Enter a promo code.' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  const { data: promo } = await admin
    .from('promo_codes')
    .select('id, amount_cents, active, eligibility, max_redemptions, starts_at, expires_at')
    .eq('code', code)
    .maybeSingle();

  // Generic "invalid" for not-found / inactive / out-of-window so we don't
  // leak which codes exist.
  const now = Date.now();
  const invalid =
    !promo ||
    !promo.active ||
    (promo.starts_at && new Date(promo.starts_at as string).getTime() > now) ||
    (promo.expires_at && new Date(promo.expires_at as string).getTime() <= now);
  if (invalid) {
    return NextResponse.json(
      { ok: false, error: "That code isn't valid or has expired." },
      { status: 400 },
    );
  }

  // Already redeemed by this bidder? (exact-once index would catch it on
  // insert too, but this gives a clean message without a wasted write.)
  const { data: existing } = await admin
    .from('bidder_credits')
    .select('id')
    .eq('promo_code_id', promo.id)
    .eq('bidder_id', caller.userId)
    .eq('reason', 'promo')
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { ok: false, error: "You've already used this code." },
      { status: 400 },
    );
  }

  // New-bidders-only gate: refuse if they've ever had a transacted invoice.
  if (promo.eligibility === 'new_bidders_only') {
    const { count } = await admin
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('bidder_id', caller.userId)
      .in('status', PAID_STATUSES);
    if ((count ?? 0) > 0) {
      return NextResponse.json(
        { ok: false, error: 'This code is for first-time bidders only.' },
        { status: 400 },
      );
    }
  }

  // Overall cap: soft check (a race can overrun by a few — acceptable for a
  // marketing code). Counts credits already minted for this code.
  if (promo.max_redemptions != null) {
    const { count } = await admin
      .from('bidder_credits')
      .select('id', { count: 'exact', head: true })
      .eq('promo_code_id', promo.id)
      .eq('reason', 'promo');
    if ((count ?? 0) >= (promo.max_redemptions as number)) {
      return NextResponse.json(
        { ok: false, error: 'This promo has been fully claimed.' },
        { status: 400 },
      );
    }
  }

  // Mint the credit — exactly-once on (promo_code_id, bidder_id).
  const { error: insErr } = await admin.from('bidder_credits').insert({
    bidder_id: caller.userId,
    amount_cents: promo.amount_cents,
    reason: 'promo',
    promo_code_id: promo.id,
  });
  if (insErr) {
    if (insErr.code === UNIQUE_VIOLATION) {
      // A concurrent request beat us — treat as already redeemed.
      return NextResponse.json(
        { ok: false, error: "You've already used this code." },
        { status: 400 },
      );
    }
    console.error('[promo/redeem] credit insert failed for', caller.userId, insErr.message);
    return NextResponse.json({ ok: false, error: 'Redemption failed — try again.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, credit_cents: promo.amount_cents });
}
