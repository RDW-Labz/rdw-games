// POST /api/bidder/loyalty/redeem — convert Square Loyalty points into
// BinGo credit (mig 0237, Phase 2). Body: { tier_id, redemption_id }.
//
// Sequence (each step idempotent on redemption_id so a retry converges):
//   1. validate tier against the LIVE program (fixed-dollar tiers only)
//   2. createLoyaltyReward  — Square LOCKS the points (fails on
//      INSUFFICIENT_POINTS, which we surface as a clean error)
//   3. redeemLoyaltyReward  — points consumed for good
//   4. insert bidder_credits (+ loyalty_reward_id, UNIQUE) — the credit the
//      auto-charge applies to their next invoice
//   Rollback: a failure between 2 and 3 deletes the reward (points return).
//   A failure after 3 retries the credit insert in-request; the UNIQUE
//   index makes any replay exactly-once.

import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import {
  SquareApiError,
  getLoyaltyProgramFull,
  findOrCreateLoyaltyAccount,
  createLoyaltyReward,
  redeemLoyaltyReward,
  deleteLoyaltyReward,
} from '@/lib/square';
import { normalizePhoneE164 } from '@/lib/cron/square-sync';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const caller = await verifyAuth(req);
  if (!caller) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  let body: { tier_id?: string; redemption_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 });
  }
  const tierId = (body.tier_id ?? '').trim();
  const redemptionId = (body.redemption_id ?? '').trim();
  if (!tierId || !/^[0-9a-f-]{16,40}$/i.test(redemptionId)) {
    return NextResponse.json({ ok: false, error: 'Missing tier or redemption id' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data: settings } = await admin
    .from('platform_settings')
    .select('square_loyalty_enabled')
    .eq('id', true)
    .maybeSingle();
  if (!settings?.square_loyalty_enabled) {
    return NextResponse.json({ ok: false, error: 'Loyalty redemption is not enabled.' }, { status: 400 });
  }

  const { data: bidder } = await admin
    .from('bidders')
    .select('phone')
    .eq('id', caller.userId)
    .maybeSingle();
  const phone = normalizePhoneE164((bidder?.phone as string | null) ?? null);
  if (!phone) {
    return NextResponse.json({ ok: false, error: 'A phone number is required for loyalty.' }, { status: 400 });
  }

  try {
    const program = await getLoyaltyProgramFull();
    if (!program || program.status !== 'ACTIVE') {
      return NextResponse.json({ ok: false, error: 'No active loyalty program.' }, { status: 400 });
    }
    const tier = program.tiers.find((t) => t.id === tierId);
    if (!tier || !tier.fixedCents || tier.fixedCents <= 0) {
      return NextResponse.json(
        { ok: false, error: 'That reward can only be redeemed in store.' },
        { status: 400 },
      );
    }

    const accountId = await findOrCreateLoyaltyAccount(program.id, phone);

    // 2. Lock points.
    let rewardId: string;
    try {
      rewardId = await createLoyaltyReward({ accountId, tierId, redemptionId });
    } catch (err) {
      if (err instanceof SquareApiError && err.errors.some((e) => e.code === 'INSUFFICIENT_POINTS')) {
        return NextResponse.json({ ok: false, error: 'Not enough points for that reward.' }, { status: 400 });
      }
      throw err;
    }

    // 3. Consume points. On failure, unlock and bail.
    try {
      await redeemLoyaltyReward(rewardId, redemptionId);
    } catch (err) {
      try {
        await deleteLoyaltyReward(rewardId);
      } catch {
        console.error('[loyalty/redeem] rollback delete failed for reward', rewardId);
      }
      throw err;
    }

    // 4. Mint the credit — exactly-once on loyalty_reward_id.
    const { error: insErr } = await admin.from('bidder_credits').insert({
      bidder_id: caller.userId,
      amount_cents: tier.fixedCents,
      reason: 'loyalty_redeem',
      loyalty_reward_id: rewardId,
    });
    if (insErr && insErr.code !== '23505') {
      // Points are spent but the credit didn't record — retry once, then
      // scream. (23505 = already recorded by a replay: success.)
      const { error: retryErr } = await admin.from('bidder_credits').insert({
        bidder_id: caller.userId,
        amount_cents: tier.fixedCents,
        reason: 'loyalty_redeem',
        loyalty_reward_id: rewardId,
      });
      if (retryErr && retryErr.code !== '23505') {
        console.error(
          '[loyalty/redeem] CREDIT INSERT FAILED AFTER REDEEM — reward',
          rewardId,
          'bidder',
          caller.userId,
          retryErr.message,
        );
        return NextResponse.json(
          { ok: false, error: 'Points were redeemed but the credit hit an error — contact support.' },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ ok: true, credit_cents: tier.fixedCents });
  } catch (err) {
    console.error('[loyalty/redeem] failed:', (err as Error).message);
    return NextResponse.json({ ok: false, error: 'Redemption failed — try again.' }, { status: 500 });
  }
}
