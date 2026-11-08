// Saved-searches matcher. Port of packages/auction-engine/src/savedSearchesMatcher.ts.
// Scans each notify=true saved_search for lots created since last_matched_at
// that match its criteria (text search, category leaves, operator, MSRP%),
// then INSERTs notifications_outbox rows with a per-(search, lot)
// idempotency key.
//
// last_matched_at is advanced BEFORE matching so a crash mid-tick never
// double-delivers -- prefer missing one match to spamming the bidder twice.

import { getSupabaseAdmin } from '@/lib/supabase-admin';

const MAX_MATCHES_PER_SEARCH_PER_TICK = 25;
const MIN_LAST_MATCHED_AT = '1970-01-01T00:00:00Z';

type SavedSearchRow = {
  id: string;
  bidder_id: string;
  name: string;
  criteria: {
    q?: string;
    category_id?: string;
    operator_id?: string;
    min_discount_pct?: number;
  };
  last_matched_at: string | null;
};

type LotMatch = {
  id: string;
  title: string;
  current_bid_cents: number | null;
  starting_bid_cents: number;
  msrp_cents: number | null;
};

async function categoryLeafIds(parentOrLeafId: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from('categories')
    .select('id, parent_id')
    .or(`id.eq.${parentOrLeafId},parent_id.eq.${parentOrLeafId}`);
  if (!data || data.length === 0) return [parentOrLeafId];
  return data.map((c) => c.id as string);
}

async function matchOne(search: SavedSearchRow, since: string): Promise<LotMatch[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from('lots')
    // 0242: !inner join drops lots in unlisted (link-only) test auctions —
    // they must never trigger alert emails.
    .select('id, title, current_bid_cents, starting_bid_cents, msrp_cents, category_id, operator_id, created_at, auctions!inner(unlisted)')
    .in('status', ['scheduled', 'live'])
    .eq('auctions.unlisted', false)
    .gt('created_at', since)
    .gt('close_at', new Date().toISOString())
    .limit(MAX_MATCHES_PER_SEARCH_PER_TICK);

  const { criteria } = search;
  if (criteria.q) {
    const ftsQuery = criteria.q
      .split(/\s+/)
      .map((t) => (/^[a-zA-Z0-9'-]+$/.test(t) ? `${t}:*` : t))
      .join(' & ');
    query = query.textSearch('search_tsv', ftsQuery);
  }
  if (criteria.operator_id) query = query.eq('operator_id', criteria.operator_id);
  if (criteria.category_id) {
    const ids = await categoryLeafIds(criteria.category_id);
    query = query.in('category_id', ids);
  }

  const { data } = await query;
  let rows = (data ?? []) as Array<LotMatch & { msrp_cents: number | null }>;

  // MSRP discount is in-process: postgrest can't do the arithmetic. Lots
  // without an MSRP fail the filter when one is set.
  if (criteria.min_discount_pct) {
    const min = criteria.min_discount_pct / 100;
    rows = rows.filter((r) => {
      if (r.msrp_cents == null || r.msrp_cents <= 0) return false;
      const price = r.current_bid_cents ?? r.starting_bid_cents;
      return 1 - price / r.msrp_cents >= min;
    });
  }

  return rows;
}

export type SavedSearchesResult = {
  searches: number;
  hits: number;
};

export async function runSavedSearches(): Promise<SavedSearchesResult> {
  const supabase = getSupabaseAdmin();

  const { data: searches } = await supabase
    .from('saved_searches')
    .select('id, bidder_id, name, criteria, last_matched_at')
    .eq('notify', true)
    .order('last_matched_at', { ascending: true, nullsFirst: true })
    .limit(500);

  if (!searches || searches.length === 0) {
    return { searches: 0, hits: 0 };
  }

  let totalHits = 0;
  for (const raw of searches) {
    const search = raw as SavedSearchRow;
    const since = search.last_matched_at ?? MIN_LAST_MATCHED_AT;
    const tickStartedAt = new Date().toISOString();

    // Optimistically advance last_matched_at BEFORE matching.
    await supabase
      .from('saved_searches')
      .update({ last_matched_at: tickStartedAt })
      .eq('id', search.id);

    const matches = await matchOne(search, since);
    if (matches.length === 0) continue;

    const rows = matches.map((m) => ({
      kind: 'saved_search_hit' as const,
      target_user_id: search.bidder_id,
      payload: {
        lot_id: m.id,
        lot_title: m.title,
        current_bid_cents: m.current_bid_cents ?? m.starting_bid_cents,
        saved_search_id: search.id,
        saved_search_name: search.name,
      },
      idempotency_key: `saved_search_hit:${search.id}:${m.id}`,
    }));

    await supabase
      .from('notifications_outbox')
      .upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true });

    totalHits += matches.length;
  }

  return { searches: searches.length, hits: totalHits };
}
