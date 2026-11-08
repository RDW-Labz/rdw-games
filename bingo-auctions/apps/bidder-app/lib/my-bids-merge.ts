// My Bids row assembly (2026-09-26). Pure — no React, no supabase — so the
// merge rule is unit-testable.
//
// The screen reads two lists of the bidder's manual bids, both newest first:
//   recent — her latest 200 bid ROWS, any lot (won/lost history)
//   active — every bid of hers on a lot still open (ACTIVE_LOT_STATUSES)
// The recent cap is rows, not lots: a heavy bidder (1,775 manual bids) had
// 267 newer bids elsewhere than her last one on a live lot she was leading,
// so that lot vanished from My Bids. The active list closes that hole.
//
// Rule: one row per lot — the lot's NEWEST manual bid (what the screen has
// always shown; "Your max" reads from it). Concatenating recent then active
// and keeping the first row per lot gives exactly that, with no timestamp
// parsing:
//   - A lot with any row in `recent` has its newest row there too (recent is
//     the global top-N by placed_at), and each list is newest-first per lot.
//   - A lot only in `active` has every row older than all of `recent`, so
//     appending keeps the whole result in placed_at-desc order.

/** Lot statuses where bidding hasn't closed (lot_status enum, mig 0001) —
 *  the same pair Browse lists. The screen treats won/unsold (or past
 *  close_at) as closed; canceled/relisted/etc. never come back to live. */
export const ACTIVE_LOT_STATUSES = ['scheduled', 'live'] as const;

export function mergeLatestBidPerLot<T extends { lot_id: string }>(
  recent: readonly T[],
  active: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of [...recent, ...active]) {
    if (seen.has(row.lot_id)) continue;
    seen.add(row.lot_id);
    out.push(row);
  }
  return out;
}

// "Your max" on an open lot = the greatest max_amount_cents across ALL her
// rows on it, manual or auto. The representative row above is her newest
// MANUAL bid, but place_bid's self-raise (mig 0216) UPDATEs her newest row of
// ANY kind — often her own is_auto=true defending row — so the manual row can
// hold a stale, lower max. Greatest-across-rows is her live max because every
// write only ever raises it (migs 0263 + 0350):
//   - a new manual row needs max >= price + increment, and while she's outbid
//     the price is already >= her old max;
//   - an auto (defending) row copies her current max;
//   - a self-raise is GREATEST(old, new) since 0350.
// Display only: returns new row objects, never changes which row is kept.
export function withEffectiveMax<T extends { lot_id: string; max_amount_cents: number }>(
  rows: readonly T[],
  otherRows: readonly { lot_id: string; max_amount_cents: number }[],
): T[] {
  const best = new Map<string, number>();
  for (const r of otherRows) {
    if (r.max_amount_cents > (best.get(r.lot_id) ?? -Infinity)) best.set(r.lot_id, r.max_amount_cents);
  }
  return rows.map((r) => {
    const m = best.get(r.lot_id);
    return m !== undefined && m > r.max_amount_cents ? { ...r, max_amount_cents: m } : r;
  });
}
