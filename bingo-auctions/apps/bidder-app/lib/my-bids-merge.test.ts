// My Bids lost a live lot a heavy bidder was leading (2026-09-26): her bids
// on it were older than her latest 200 rows. These pin the merge that adds
// the open-lot bids back without changing which row each lot shows.

import { describe, it, expect } from 'vitest';
import { mergeLatestBidPerLot, withEffectiveMax } from './my-bids-merge';

type Row = { lot_id: string; placed_at: string; max_amount_cents: number };
const row = (lot_id: string, placed_at: string, max_amount_cents = 100): Row => ({
  lot_id,
  placed_at,
  max_amount_cents,
});

describe('mergeLatestBidPerLot', () => {
  it('keeps an open lot that fell off the recent-rows cap (the bug)', () => {
    const recent = [row('A', '2026-09-26T10:00:00Z'), row('B', '2026-09-26T09:00:00Z')];
    const active = [row('LIVE', '2026-09-20T08:00:00Z', 5000), row('LIVE', '2026-09-19T08:00:00Z', 3000)];
    const out = mergeLatestBidPerLot(recent, active);
    expect(out.map((r) => r.lot_id)).toEqual(['A', 'B', 'LIVE']);
    // the lot's newest row, as the recent-only dedupe always kept
    expect(out[2]?.max_amount_cents).toBe(5000);
  });

  it('keeps one row per lot — the newest — when a lot is in both lists', () => {
    const recent = [
      row('A', '2026-09-26T10:00:00Z', 900),
      row('B', '2026-09-26T09:00:00Z'),
      row('A', '2026-09-26T08:00:00Z', 400),
    ];
    const active = [row('A', '2026-09-26T10:00:00Z', 900), row('A', '2026-09-26T08:00:00Z', 400)];
    const out = mergeLatestBidPerLot(recent, active);
    expect(out.map((r) => r.lot_id)).toEqual(['A', 'B']);
    expect(out[0]?.max_amount_cents).toBe(900);
  });

  it('matches the old recent-only result when there are no open-lot bids', () => {
    const recent = [row('A', '3'), row('B', '2'), row('A', '1')];
    expect(mergeLatestBidPerLot(recent, [])).toEqual([row('A', '3'), row('B', '2')]);
  });

  it('works with only open-lot bids (history read failed or empty)', () => {
    const active = [row('X', '2'), row('Y', '1'), row('X', '0')];
    expect(mergeLatestBidPerLot([], active).map((r) => r.lot_id)).toEqual(['X', 'Y']);
  });

  it('does not mutate its inputs', () => {
    const recent = [row('A', '2')];
    const active = [row('A', '2'), row('B', '1')];
    mergeLatestBidPerLot(recent, active);
    expect(recent).toHaveLength(1);
    expect(active).toHaveLength(2);
  });
});

describe('withEffectiveMax', () => {
  it('shows the raised max a self-raise wrote onto her auto row (the stale "Your max")', () => {
    const rows = [row('LIVE', '2026-09-20T08:00:00Z', 3000)];
    const auto = [
      { lot_id: 'LIVE', max_amount_cents: 3000 },
      { lot_id: 'LIVE', max_amount_cents: 8000 },
    ];
    expect(withEffectiveMax(rows, auto)[0]?.max_amount_cents).toBe(8000);
  });

  it('never lowers the manual max, and leaves lots without auto rows alone', () => {
    const rows = [row('A', '2', 5000), row('B', '1', 700)];
    const out = withEffectiveMax(rows, [{ lot_id: 'A', max_amount_cents: 4000 }]);
    expect(out).toEqual(rows);
    expect(out[0]).toBe(rows[0]);
    expect(out[1]).toBe(rows[1]);
  });

  it('keeps row order and identity fields; does not mutate its inputs', () => {
    const rows = [row('A', '2', 100), row('B', '1', 200)];
    const out = withEffectiveMax(rows, [{ lot_id: 'B', max_amount_cents: 900 }]);
    expect(out.map((r) => [r.lot_id, r.placed_at, r.max_amount_cents])).toEqual([
      ['A', '2', 100],
      ['B', '1', 900],
    ]);
    expect(rows[1]?.max_amount_cents).toBe(200);
  });
});
