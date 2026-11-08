/**
 * GET /api/search/suggest?q={query}&limit={n}
 *
 * Public auto-suggest endpoint for the SearchBar component.
 * Returns up to 5 matching categories + 5 matching lots from active auctions.
 *
 * No auth required — categories are public; lots are filtered to
 * auctions in 'scheduled' or 'live' status (already public on the browse page).
 *
 * Response shape:
 *   { categories: [{slug, name, icon_url}], lots: [{lot_code, title, photo_url}] }
 *
 * Cache: public, max-age=60 (edge-cacheable, safe for public data).
 *
 * Security: `q` ends up in PostgREST `.or(...)` filter strings (filter syntax,
 * NOT a bound parameter). It reaches them only through the builders in
 * lib/search-limits.ts, which run sanitizePostgrestPattern first.
 * Rate-limiting: rely on Cloudflare WAF rules at the edge; no in-process
 * limiter added (this endpoint is read-only public data).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { NON_SELLABLE_LOT_STATUS_FILTER } from '@/lib/auction-status';
import { lotSearchFilter, searchOrFilter } from '@/lib/search-limits';

export const runtime = 'nodejs';
// Allow the edge CDN to cache this. Each unique ?q string gets its own entry.
export const dynamic = 'force-dynamic';

const CAT_LIMIT = 5;
const LOT_LIMIT = 5;
const MAX_Q_LEN = 120; // guard against absurdly long inputs

// ── Types ─────────────────────────────────────────────────────────────────────

interface SuggestCategory {
  slug: string;
  name: string;
  icon_url: string | null;
}

interface SuggestLot {
  lot_code: string;
  title: string;
  photo_url: string | null;
}

interface SuggestResponse {
  categories: SuggestCategory[];
  lots: SuggestLot[];
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const rawQ = (searchParams.get('q') ?? '').trim().slice(0, MAX_Q_LEN);

  // rawQ is interpolated into `.or(...)` filters below, which take filter
  // SYNTAX, not a bound parameter; the builders in lib/search-limits.ts
  // sanitise it. This is a public, unauthenticated endpoint. 1–2 characters
  // match word prefixes ("TV" suggests TVs), 3+ match substrings.
  const lotFilter = lotSearchFilter(rawQ);
  const categoryFilter = searchOrFilter(rawQ, { text: ['name'] });
  if (!lotFilter || !categoryFilter) {
    const empty: SuggestResponse = { categories: [], lots: [] };
    return NextResponse.json(empty, {
      headers: { 'Cache-Control': 'public, max-age=60' },
    });
  }

  const supabase = getSupabaseAdmin();

  // Run category + lot queries in parallel.
  const [catResult, activeAuctionsResult] = await Promise.all([
    supabase
      .from('categories')
      .select('slug, name, icon_url')
      .or(categoryFilter)
      .limit(CAT_LIMIT),
    supabase
      .from('auctions')
      .select('id')
      .in('status', ['scheduled', 'live'])
      .eq('unlisted', false),
  ]);

  const categories: SuggestCategory[] = (
    (catResult.data ?? []) as Array<{ slug: string; name: string; icon_url: string | null }>
  ).map((r) => ({
    slug: r.slug,
    name: r.name,
    icon_url: r.icon_url,
  }));

  const activeIds = ((activeAuctionsResult.data ?? []) as Array<{ id: string }>).map((r) => r.id);

  let lots: SuggestLot[] = [];
  if (activeIds.length > 0) {
    const lotResult = await supabase
      .from('lots')
      .select('lot_code, title, photo_urls')
      .in('auction_id', activeIds)
      .is('deleted_at', null)
      .not('status', 'in', NON_SELLABLE_LOT_STATUS_FILTER)
      // sticker_code included: it is the label printed on the box and the code
      // the storefront renders (lotDisplayCode), so leaving it out meant
      // typing the code from a listing suggested nothing back.
      .or(lotFilter)
      .limit(LOT_LIMIT);

    lots = (
      (lotResult.data ?? []) as Array<{
        lot_code: string;
        title: string;
        photo_urls: string[] | null;
      }>
    ).map((r) => ({
      lot_code: r.lot_code,
      title: r.title,
      photo_url: r.photo_urls?.[0] ?? null,
    }));
  }

  const response: SuggestResponse = { categories, lots };

  return NextResponse.json(response, {
    headers: { 'Cache-Control': 'public, max-age=60' },
  });
}
