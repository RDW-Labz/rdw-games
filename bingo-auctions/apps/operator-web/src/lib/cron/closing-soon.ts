// Pre-close notification scanner. Finds watched lots within
// CLOSING_SOON_MINUTES of close_at and writes one notifications_outbox row
// per (bidder, lot, close_at). Direct port of
// packages/auction-engine/src/closingSoon.ts tick().
//
// Idempotency key 'closing_soon:<bidder>:<lot>:<close_at>' means a fresh
// close_at (after a soft-close extension) re-fires intentionally -- the
// new countdown is news worth notifying about.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

const CLOSING_SOON_MINUTES = 10;
// PostgREST caps one select at 1,000 rows, so page it. The lot filters below
// run in SQL through the `!inner` embed, so a page holds only watched lots
// that are actually closing inside the window.
const PAGE_SIZE = 1000;

type WatchedLotRow = {
  bidder_id: string;
  lot_id: string;
  close_at: string;
  title: string;
  current_bid_cents: number | null;
};

type JoinedWatchlistRow = {
  bidder_id: string;
  lot_id: string;
  lots: {
    id: string;
    title: string;
    close_at: string;
    current_bid_cents: number | null;
    winner_bidder_id: string | null;
    status: string;
  } | null;
};

export type ClosingSoonResult = {
  scanned: number;
  enqueued: number;
};

export type ClosingSoonDeps = {
  supabase?: SupabaseClient;
  now?: Date;
};

export async function runClosingSoon(deps: ClosingSoonDeps = {}): Promise<ClosingSoonResult> {
  const supabase = deps.supabase ?? getSupabaseAdmin();

  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const horizon = new Date(now.getTime() + CLOSING_SOON_MINUTES * 60_000).toISOString();

  // Only fetch watched lots that can fire: still open, closing inside the
  // window. The `!inner` embed pushes `status` and `close_at` into SQL; the
  // old query pulled the whole 30k-row watchlist through PostgREST's 1,000-row
  // cap and filtered in JS, so almost every watched lot was never scanned.
  const watched: JoinedWatchlistRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('watchlist')
      .select(
        'bidder_id, lot_id, lots!inner(id, title, close_at, current_bid_cents, winner_bidder_id, status)',
      )
      .in('lots.status', ['live', 'scheduled'])
      .gt('lots.close_at', nowIso)
      .lte('lots.close_at', horizon)
      .order('bidder_id', { ascending: true })
      .order('lot_id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`closing-soon: watchlist query failed — ${error.message}`);

    const page = (data ?? []) as unknown as JoinedWatchlistRow[];
    watched.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const candidates: WatchedLotRow[] = [];
  for (const w of watched) {
    const l = w.lots;
    if (!l) continue;
    // Don't panic the bidder who is already the leader on the lot.
    if (l.winner_bidder_id === w.bidder_id) continue;

    candidates.push({
      bidder_id: w.bidder_id,
      lot_id: l.id,
      close_at: l.close_at,
      title: l.title,
      current_bid_cents: l.current_bid_cents,
    });
  }

  if (candidates.length === 0) {
    return { scanned: watched.length, enqueued: 0 };
  }

  const inserts = candidates.map((c) => ({
    kind: 'closing_soon' as const,
    target_user_id: c.bidder_id,
    payload: {
      lot_id: c.lot_id,
      lot_title: c.title,
      close_at: c.close_at,
      current_bid_cents: c.current_bid_cents,
    },
    idempotency_key: `closing_soon:${c.bidder_id}:${c.lot_id}:${c.close_at}`,
  }));

  const { error: outboxError } = await supabase
    .from('notifications_outbox')
    .upsert(inserts, { onConflict: 'idempotency_key', ignoreDuplicates: true });

  if (outboxError) throw new Error(`closing-soon: outbox upsert failed — ${outboxError.message}`);

  return { scanned: watched.length, enqueued: inserts.length };
}
