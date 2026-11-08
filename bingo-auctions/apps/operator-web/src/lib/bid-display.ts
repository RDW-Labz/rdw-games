// What the lot page shows a bidder, and where that number is allowed to come
// from.
//
// Reported 2026-09-17 (BRN4982296, iPad Safari): the page read "current bid
// $11, 4 bids, next bid $12" while the response to the bid the customer had
// just placed said "you've been outbid, the current bid is now $15". Both
// numbers were on screen at once. The customer was reading a price that no
// longer existed and bidding against it.
//
// Two separate causes, either of which produced that on its own:
//
//   A. The success path applied only the leader id from place_bid's result,
//      never the price. The toast read result.current_bid_cents and was
//      right; the page body read the stale lot row and was wrong; "next bid"
//      was derived from the stale number, so it was wrong too. The bidder app
//      had consumed the result properly since it shipped — the web never did.
//
//   B. The realtime subscription was the ONLY thing that refreshed the price,
//      and it had no failure handling: a bare .subscribe() with no status
//      callback, no reconnect, no refetch on wake. Safari suspends WebSockets
//      on backgrounded tabs and on device sleep, so the page went stale
//      permanently and gave no sign it had.
//
// The rule these helpers exist to enforce: a displayed price is only ever the
// server's answer — from the RPC result, the realtime echo, or a refetch —
// and never something the client worked out for itself.

/** The subset of a lot row the bid widget renders. */
export interface LotDisplayRow {
  status: string;
  starting_bid_cents: number;
  current_bid_cents: number | null;
  bid_count: number;
  close_at: string | null;
  /** Optional because the widget's own row type has it optional — a lot row
   *  fetched without the column is legitimately absent rather than leaderless. */
  winner_bidder_id?: string | null;
}

/** The fields of place_bid_result this module needs. Mirrors the SQL type in
 *  migration 0003 — note there is no bid_count on it. */
export interface BidResultFields {
  current_bid_cents: number | null;
  current_leader_id: string | null;
  close_at: string | null;
}

/**
 * Merge a partial row into the displayed one.
 *
 * The partial-ness is the whole difficulty. Postgres CDC only carries columns
 * that actually changed, so for the nullable fields there are THREE cases and
 * they are not interchangeable:
 *
 *   key absent        → no change; keep what we have
 *   key present, null → a real value (a retract clearing the leader)
 *   key present, set  → adopt it
 *
 * `??` collapses the first two and would null out a leader on any UPDATE that
 * did not happen to include the column. Hence the explicit `in` / `!==
 * undefined` checks. The non-nullable fields (status, bid_count,
 * starting_bid_cents) can use `??` safely because null is not meaningful for
 * them.
 */
export function mergeLotRow<T extends LotDisplayRow>(
  prev: T,
  next: Partial<LotDisplayRow>,
): T {
  return {
    ...prev,
    status: next.status ?? prev.status,
    starting_bid_cents: next.starting_bid_cents ?? prev.starting_bid_cents,
    current_bid_cents:
      next.current_bid_cents !== undefined
        ? next.current_bid_cents
        : prev.current_bid_cents,
    bid_count: next.bid_count ?? prev.bid_count,
    close_at: next.close_at !== undefined ? next.close_at : prev.close_at,
    winner_bidder_id:
      'winner_bidder_id' in next
        ? (next.winner_bidder_id as string | null)
        : prev.winner_bidder_id,
  };
}

/**
 * Turn a successful place_bid result into the patch the display should adopt.
 *
 * This is cause A in one function. place_bid has already decided the outcome
 * and handed it back; the page renders THAT rather than waiting to be told the
 * same thing again by the realtime echo — which, per cause B, may never come.
 *
 * `fallbackCurrentCents` covers a result that somehow carries a null price:
 * keep the last known figure rather than blanking the widget. A stale price is
 * bad; an empty one where a customer is about to commit money is worse.
 *
 * Three deliberate omissions:
 *
 *   bid_count — not on place_bid_result, and NOT inferred by adding one. A
 *   single bid can insert two rows: the bidder's, plus the leader's proxy
 *   counter-bid. Guessing a number shown to a customer is the exact class of
 *   bug this module exists to fix. It comes from a refetch or the echo.
 *
 *   status — a bid never changes it, and a soft-close race could hand back a
 *   staler value than the page already has.
 *
 *   close_at only when present — it moves on a soft-close extension, and that
 *   extension is part of this same result.
 */
export function lotPatchFromBidResult(
  result: BidResultFields,
  fallbackCurrentCents: number | null,
): Partial<LotDisplayRow> {
  const patch: Partial<LotDisplayRow> = {
    current_bid_cents: result.current_bid_cents ?? fallbackCurrentCents,
    // Trust current_leader_id verbatim, including null. ok:true does NOT mean
    // the bidder is winning — an existing higher max can out-proxy them in the
    // same call, and the OUTBID badge has to be able to say so.
    winner_bidder_id: result.current_leader_id ?? null,
  };
  if (result.close_at) patch.close_at = result.close_at;
  return patch;
}
