// Guards for the 2026-09-17 stale-price report (BRN4982296).
//
// Per WORKING_AGREEMENT §7c: "Test the negative case. A regression guard that
// passes against the bug it's meant to catch is worse than no guard." Each
// block below names the bug it catches and how it was verified to fail first
// — see the PR body for the reverted-line runs.

import { describe, expect, it } from 'vitest';
import {
  lotPatchFromBidResult,
  mergeLotRow,
  type LotDisplayRow,
} from '../bid-display';

const ME = 'bidder-me';
const RIVAL = 'bidder-rival';

/** The lot as the customer's page had it: $11, 4 bids, rival leading. */
const onScreen: LotDisplayRow = {
  status: 'live',
  starting_bid_cents: 100,
  current_bid_cents: 1100,
  bid_count: 4,
  close_at: '2026-09-17T23:00:00Z',
  winner_bidder_id: RIVAL,
};

describe('lotPatchFromBidResult — the reported bug', () => {
  it('carries the price the server just returned', () => {
    // THE NEGATIVE CASE. The old success path applied only the leader id, so
    // the page kept rendering $11 while the toast said $15. If the patch ever
    // stops carrying current_bid_cents, this fails.
    const patch = lotPatchFromBidResult(
      { current_bid_cents: 1500, current_leader_id: RIVAL, close_at: null },
      onScreen.current_bid_cents,
    );
    expect(patch.current_bid_cents).toBe(1500);

    const after = mergeLotRow(onScreen, patch);
    expect(after.current_bid_cents).toBe(1500);
    // The exact pairing the customer saw: badge said outbid, price said $11.
    expect(after.current_bid_cents).not.toBe(onScreen.current_bid_cents);
  });

  it('does not claim the lead on a proxy-outbid', () => {
    // ok:true does not mean winning. Trust current_leader_id verbatim.
    const patch = lotPatchFromBidResult(
      { current_bid_cents: 1500, current_leader_id: RIVAL, close_at: null },
      null,
    );
    expect(patch.winner_bidder_id).toBe(RIVAL);
    expect(mergeLotRow(onScreen, patch).winner_bidder_id).toBe(RIVAL);
  });

  it('adopts the lead when the bidder really did take it', () => {
    const patch = lotPatchFromBidResult(
      { current_bid_cents: 1600, current_leader_id: ME, close_at: null },
      null,
    );
    expect(mergeLotRow(onScreen, patch).winner_bidder_id).toBe(ME);
  });

  it('never invents a bid_count', () => {
    // bid_count is not on place_bid_result. One bid can insert TWO rows (the
    // bidder's, plus the leader's proxy counter), so +1 would be wrong as
    // often as it was right. It must come from the server or not at all.
    const patch = lotPatchFromBidResult(
      { current_bid_cents: 1500, current_leader_id: RIVAL, close_at: null },
      null,
    );
    expect(patch).not.toHaveProperty('bid_count');
    expect(mergeLotRow(onScreen, patch).bid_count).toBe(4);
  });

  it('keeps the last known price rather than blanking on a null result', () => {
    const patch = lotPatchFromBidResult(
      { current_bid_cents: null, current_leader_id: ME, close_at: null },
      1100,
    );
    expect(patch.current_bid_cents).toBe(1100);
  });

  it('adopts an extended close_at, and omits it when absent', () => {
    const extended = lotPatchFromBidResult(
      { current_bid_cents: 1500, current_leader_id: ME, close_at: '2026-09-17T23:05:00Z' },
      null,
    );
    expect(mergeLotRow(onScreen, extended).close_at).toBe('2026-09-17T23:05:00Z');

    const noExtension = lotPatchFromBidResult(
      { current_bid_cents: 1500, current_leader_id: ME, close_at: null },
      null,
    );
    expect(noExtension).not.toHaveProperty('close_at');
    expect(mergeLotRow(onScreen, noExtension).close_at).toBe(onScreen.close_at);
  });

  it('leaves status alone — a bid does not close a lot', () => {
    const patch = lotPatchFromBidResult(
      { current_bid_cents: 1500, current_leader_id: ME, close_at: null },
      null,
    );
    expect(patch).not.toHaveProperty('status');
  });
});

describe('mergeLotRow — partial CDC semantics', () => {
  it('an ABSENT key means no change, not null', () => {
    // NEGATIVE CASE for the `??` trap. Postgres CDC omits unchanged columns,
    // so collapsing absent-and-null would clear the leader on any UPDATE that
    // happened not to include winner_bidder_id — the badge would flip to "no
    // leader" on an unrelated change.
    const after = mergeLotRow(onScreen, { current_bid_cents: 1500 });
    expect(after.winner_bidder_id).toBe(RIVAL);
    expect(after.close_at).toBe(onScreen.close_at);
    expect(after.bid_count).toBe(4);
  });

  it('an EXPLICIT null is a real value and is adopted', () => {
    // A retract clears the leader. That has to survive the merge.
    const after = mergeLotRow(onScreen, { winner_bidder_id: null });
    expect(after.winner_bidder_id).toBeNull();
  });

  it('distinguishes absent close_at from an explicit null', () => {
    expect(mergeLotRow(onScreen, {}).close_at).toBe(onScreen.close_at);
    expect(mergeLotRow(onScreen, { close_at: null }).close_at).toBeNull();
  });

  it('adopts a refetched row wholesale, including bid_count', () => {
    // What the recovery refetch delivers after a dropped socket.
    const after = mergeLotRow(onScreen, {
      status: 'live',
      starting_bid_cents: 100,
      current_bid_cents: 1500,
      bid_count: 7,
      close_at: '2026-09-17T23:05:00Z',
      winner_bidder_id: RIVAL,
    });
    expect(after).toEqual({
      status: 'live',
      starting_bid_cents: 100,
      current_bid_cents: 1500,
      bid_count: 7,
      close_at: '2026-09-17T23:05:00Z',
      winner_bidder_id: RIVAL,
    });
  });

  it('an empty patch is a no-op', () => {
    expect(mergeLotRow(onScreen, {})).toEqual(onScreen);
  });

  it('does not mutate the previous row', () => {
    const before = { ...onScreen };
    mergeLotRow(onScreen, { current_bid_cents: 9999, winner_bidder_id: null });
    expect(onScreen).toEqual(before);
  });
});
