// Auto-bid ("we raised your bid for you") display — decision + wording for
// the proxy-bidding raises BinGo's engine places on a bidder's behalf.
//
// Background (BID-CONFIRM, 2026-10): place_bid's proxy defense inserts (or
// self-raise UPDATEs — mig 0216) a row with is_auto = true when the engine
// defends a leader's existing max against a rival bid. Today's "My bids" /
// lot-page UI reads only her manual (is_auto = false) rows, so when the
// newest thing that happened on a lot was an automatic defense, she never
// sees it — a customer reported bids that "happened on their own" because
// the price moved and nothing in the app said why.
//
// This module is pure — no React, no supabase — so the decision is
// unit-testable; the two apps feed it their own query shapes and their own
// currency formatter.
//
// "Your max" (maxCents below) is the greatest max_amount_cents across ALL of
// the bidder's own rows on the lot, not just her newest row's. That mirrors
// apps/bidder-app/lib/my-bids-merge.ts withEffectiveMax, and for the same
// reason: a self-raise (mig 0216) UPDATEs her newest row of ANY kind — often
// her own is_auto defending row — so her newest MANUAL row can hold a stale,
// lower max. Every write to max_amount_cents only ever raises it (migs 0263 +
// 0350: an auto row's max is either copied from her prior max or set to
// GREATEST(old, new) on a self-raise), so whatever value ends up in any of
// her own rows is a max she herself entered at some point — there is no path
// where the server invents a max she never typed. The greatest value across
// her rows is therefore always her most recent entered max, auto row or not.

import type { Cents } from './money';

/** One of a bidder's own rows (manual or her own proxy-defense row) on a
 *  single lot. */
export interface BidderOwnBidRow {
  amount_cents: Cents;
  max_amount_cents: Cents;
  is_auto: boolean;
  /** ISO timestamp (bids.placed_at). */
  placed_at: string;
}

export interface AutoRaiseStatus {
  /** True when the bidder's newest row (by placed_at) on this lot is a
   *  server-placed proxy defense, not something she tapped herself. */
  isAutoRaise: boolean;
  /** What that newest auto row actually bid — the "raised to" amount.
   *  Null when isAutoRaise is false. */
  raisedToCents: Cents | null;
  /** Her live max across every row of hers on the lot — see the module doc
   *  comment above for why this is "the max she entered." Null when she has
   *  no rows at all. */
  maxCents: Cents | null;
}

const NO_STATUS: AutoRaiseStatus = { isAutoRaise: false, raisedToCents: null, maxCents: null };

/** Decide whether a bidder's current status on a lot is an auto-raise, from
 *  all of her own rows on that lot (manual + auto, any order). */
export function describeAutoRaise(rows: readonly BidderOwnBidRow[]): AutoRaiseStatus {
  if (rows.length === 0) return NO_STATUS;

  let newest: BidderOwnBidRow | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  let maxCents = Number.NEGATIVE_INFINITY;

  for (const r of rows) {
    const ms = Date.parse(r.placed_at);
    if (Number.isFinite(ms) && (newest === null || ms > newestMs)) {
      newest = r;
      newestMs = ms;
    }
    if (r.max_amount_cents > maxCents) maxCents = r.max_amount_cents;
  }

  // Every row has an unparseable placed_at in the (never-expected) worst
  // case: fall back to the first row rather than leaving newest null.
  const effectiveNewest = newest ?? rows[0]!;

  return {
    isAutoRaise: effectiveNewest.is_auto,
    raisedToCents: effectiveNewest.is_auto ? effectiveNewest.amount_cents : null,
    maxCents,
  };
}

/** Wording for the auto-raise line, e.g.
 *    "We raised your bid to $12.50 — your max is $40.00."
 *  Returns null when there's nothing to say. Takes a formatter so each app
 *  renders currency with its own existing helper (both apps already have
 *  one) rather than this module picking a display format for them. */
export function autoRaiseMessage(
  status: AutoRaiseStatus,
  formatCents: (cents: Cents) => string,
): string | null {
  if (!status.isAutoRaise || status.raisedToCents == null || status.maxCents == null) {
    return null;
  }
  return `We raised your bid to ${formatCents(status.raisedToCents)} — your max is ${formatCents(
    status.maxCents,
  )}.`;
}
