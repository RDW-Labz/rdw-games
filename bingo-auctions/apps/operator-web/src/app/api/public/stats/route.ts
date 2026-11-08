/**
 * GET /api/public/stats
 *
 * Anonymous-readable marketplace pulse. Powers the homepage live counter
 * ("X lots live now · Y ending in the next hour · Z operators"). No auth.
 *
 * Caching: 30s public cache. Stats are wallpaper, not real-time numbers —
 * a half-minute drift is fine and protects against a thundering-herd if
 * the homepage gets traffic-spiked.
 *
 * Service role is safe here because we explicitly aggregate counts and
 * never return row data; nothing leaks beyond what the homepage already
 * surfaces via the ending-soon rail.
 */

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getDemoOperatorIds, demoExclusionList } from '@/lib/demo-operators';

export const runtime = 'nodejs';
// Stats should be cache-able at the edge. We let the Cache-Control header
// drive expiry — `force-dynamic` is unnecessary and would defeat the cache.

type StatsResponse = {
  live_lots_count: number;
  ending_within_hour_count: number;
  operators_count: number;
};

const ZERO: StatsResponse = {
  live_lots_count: 0,
  ending_within_hour_count: 0,
  operators_count: 0,
};

export async function GET(): Promise<NextResponse<StatsResponse>> {
  try {
    const supabase = getSupabaseAdmin();
    const nowIso = new Date().toISOString();
    const inOneHourIso = new Date(Date.now() + 60 * 60_000).toISOString();

    // Count only lots the storefront can show: auctions that are active,
    // listed (not a 0242 staff test auction) and not the demo operator's. Same
    // gate as Final Call and Browse; before 2026-09-28 a running test auction
    // inflated "X lots live now".
    const demoExclude = demoExclusionList(await getDemoOperatorIds());
    let auctionsQ = supabase
      .from('auctions')
      .select('id')
      .in('status', ['scheduled', 'live'])
      .eq('unlisted', false);
    if (demoExclude) auctionsQ = auctionsQ.not('operator_id', 'in', demoExclude);
    const { data: listed, error: listedErr } = await auctionsQ;
    if (listedErr) throw new Error(`listed auctions: ${listedErr.message}`);
    const listedIds = ((listed ?? []) as Array<{ id: string }>).map((a) => a.id);

    const lotCount = (closeBeforeIso: string | null) => {
      if (listedIds.length === 0) return Promise.resolve({ count: 0 });
      let q = supabase
        .from('lots')
        .select('id', { head: true, count: 'exact' })
        .in('auction_id', listedIds)
        .eq('status', 'live')
        .gt('close_at', nowIso);
      if (closeBeforeIso) q = q.lt('close_at', closeBeforeIso);
      return q;
    };

    // The three counts are independent — fire them in parallel.
    const [liveQ, soonQ, opsQ] = await Promise.all([
      lotCount(null),
      lotCount(inOneHourIso),
      supabase
        .from('operators')
        .select('id', { head: true, count: 'exact' })
        .eq('status', 'active')
        .eq('stripe_onboarding_complete', true),
    ]);
    const body: StatsResponse = {
      live_lots_count: liveQ.count ?? 0,
      ending_within_hour_count: soonQ.count ?? 0,
      operators_count: opsQ.count ?? 0,
    };

    return NextResponse.json(body, {
      status: 200,
      headers: {
        'cache-control': 'public, max-age=30, s-maxage=30',
      },
    });
  } catch (err) {
    // Never let stats brick the homepage. Log + return zeros; the UI
    // gracefully hides the counter line when everything is zero.
    console.error('[public/stats] failed', err);
    return NextResponse.json(ZERO, {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
