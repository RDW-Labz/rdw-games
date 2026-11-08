/**
 * Final Call live-count helpers.
 *
 * The nav link in `(public)/layout.tsx` and the homepage CTA card both need
 * "how many lots are in the 2-min window RIGHT NOW?" for every public page
 * load. Doing that query inline on each render would be a tax — the public
 * layout fires on EVERY request. Instead we wrap a count-only Supabase
 * query in `unstable_cache` with a 15-second TTL.
 *
 * Why 15 seconds:
 *   - The cache is shared across all visitors hitting the public layout.
 *   - 15s is short enough that the count feels live, long enough to flatten
 *     a request burst into one DB hit.
 *   - The /final-call page itself self-heals every 15s on the client, so the
 *     nav badge can lag by up to ~30s without confusing anyone.
 *
 * Why a HEAD count (head: true + count: 'exact'):
 *   - PostgREST sends back ONLY a Content-Range header — no rows. Cheap.
 *   - The composite index `lots_close_at_idx` on (close_at) WHERE status IN
 *     ('scheduled', 'live') (migration 0001) already covers this filter.
 *
 * Error handling: any failure returns 0 — the link still renders (just
 * dimmed) instead of breaking the entire public layout.
 */

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getDemoOperatorIds, demoExclusionList } from '@/lib/demo-operators';

/** Hard ceiling on the Final Call window. Single source of truth — the page
 *  query and this count must use the same boundary so the badge can't drift. */
export const FINAL_CALL_WINDOW_MS = 2 * 60 * 1000;

async function fetchFinalCallCount(): Promise<number> {
  try {
    const supabase = getSupabaseAdmin();
    const nowIso = new Date().toISOString();
    const cutoffIso = new Date(Date.now() + FINAL_CALL_WINDOW_MS).toISOString();

    // H4-c: resolve active, non-demo auction IDs first so the demo operator's
    // lots never inflate the Final Call badge/callout count. This count gates a
    // public surface (nav badge + homepage callout) and the lots table has no
    // operator_id, so the exclusion must go through the auction gate — same
    // pattern as (public)/browse/page.tsx and final-call/page.tsx.
    const demoExclude = demoExclusionList(await getDemoOperatorIds());
    let activeAuctionQuery = supabase
      .from('auctions')
      .select('id')
      .in('status', ['scheduled', 'live'])
      .eq('unlisted', false);
    if (demoExclude) activeAuctionQuery = activeAuctionQuery.not('operator_id', 'in', demoExclude);
    const { data: activeAuctions } = await activeAuctionQuery;
    const activeAuctionIds = ((activeAuctions ?? []) as Array<{ id: string }>).map((a) => a.id);
    if (activeAuctionIds.length === 0) return 0;

    const { count, error } = await supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .in('auction_id', activeAuctionIds)
      .eq('status', 'live')
      .is('deleted_at', null)
      .gt('close_at', nowIso)
      .lt('close_at', cutoffIso);
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Direct per-render count — deliberately NOT unstable_cache (the Workers
 * runtime froze the first cached value; see browse counts, 2026-07-04).
 * One head-count query per render.
 */
export const getFinalCallCount = fetchFinalCallCount;
