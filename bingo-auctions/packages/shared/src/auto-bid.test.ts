import { describe, it, expect } from 'vitest';
import { describeAutoRaise, autoRaiseMessage, type BidderOwnBidRow } from './auto-bid';

const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;

function row(p: Partial<BidderOwnBidRow> & Pick<BidderOwnBidRow, 'placed_at'>): BidderOwnBidRow {
  return {
    amount_cents: 1000,
    max_amount_cents: 1000,
    is_auto: false,
    ...p,
  };
}

describe('describeAutoRaise', () => {
  it('returns no status for no bids', () => {
    expect(describeAutoRaise([])).toEqual({
      isAutoRaise: false,
      raisedToCents: null,
      maxCents: null,
    });
  });

  it('a single manual bid is not an auto-raise', () => {
    const status = describeAutoRaise([
      row({ amount_cents: 1200, max_amount_cents: 2000, is_auto: false, placed_at: '2026-10-01T00:00:00Z' }),
    ]);
    expect(status.isAutoRaise).toBe(false);
    expect(status.raisedToCents).toBeNull();
    expect(status.maxCents).toBe(2000);
  });

  it('newest row auto (defended) -> isAutoRaise true, raisedToCents = that row amount', () => {
    const status = describeAutoRaise([
      row({ amount_cents: 1200, max_amount_cents: 4000, is_auto: false, placed_at: '2026-10-01T00:00:00Z' }),
      row({ amount_cents: 1800, max_amount_cents: 4000, is_auto: true, placed_at: '2026-10-01T00:05:00Z' }),
    ]);
    expect(status.isAutoRaise).toBe(true);
    expect(status.raisedToCents).toBe(1800);
    expect(status.maxCents).toBe(4000);
  });

  it('order of input rows does not matter — newest is found by placed_at', () => {
    const rows: BidderOwnBidRow[] = [
      row({ amount_cents: 1800, max_amount_cents: 4000, is_auto: true, placed_at: '2026-10-01T00:05:00Z' }),
      row({ amount_cents: 1200, max_amount_cents: 4000, is_auto: false, placed_at: '2026-10-01T00:00:00Z' }),
    ];
    expect(describeAutoRaise(rows)).toEqual(describeAutoRaise([...rows].reverse()));
  });

  it('newest row manual after an older auto row -> not an auto-raise', () => {
    const status = describeAutoRaise([
      row({ amount_cents: 1800, max_amount_cents: 4000, is_auto: true, placed_at: '2026-10-01T00:05:00Z' }),
      row({ amount_cents: 2200, max_amount_cents: 5000, is_auto: false, placed_at: '2026-10-01T00:10:00Z' }),
    ]);
    expect(status.isAutoRaise).toBe(false);
    expect(status.raisedToCents).toBeNull();
    expect(status.maxCents).toBe(5000);
  });

  it('max is the greatest max_amount_cents across all rows, even if it is not on the newest row', () => {
    // Self-raise (mig 0216) can UPDATE an older auto row's max past the
    // newest manual row's — the greatest-across-rows rule must still surface it.
    const status = describeAutoRaise([
      row({ amount_cents: 1200, max_amount_cents: 3000, is_auto: false, placed_at: '2026-10-01T00:00:00Z' }),
      row({ amount_cents: 1800, max_amount_cents: 6000, is_auto: true, placed_at: '2026-09-30T23:50:00Z' }),
    ]);
    expect(status.maxCents).toBe(6000);
  });
});

describe('autoRaiseMessage', () => {
  it('is null when there is no auto-raise', () => {
    const status = describeAutoRaise([
      row({ amount_cents: 1200, max_amount_cents: 2000, is_auto: false, placed_at: '2026-10-01T00:00:00Z' }),
    ]);
    expect(autoRaiseMessage(status, fmt)).toBeNull();
  });

  it('is null for an empty lot (no rows)', () => {
    expect(autoRaiseMessage(describeAutoRaise([]), fmt)).toBeNull();
  });

  it('names the raised-to amount and the max', () => {
    const status = describeAutoRaise([
      row({ amount_cents: 1200, max_amount_cents: 4000, is_auto: false, placed_at: '2026-10-01T00:00:00Z' }),
      row({ amount_cents: 1800, max_amount_cents: 4000, is_auto: true, placed_at: '2026-10-01T00:05:00Z' }),
    ]);
    expect(autoRaiseMessage(status, fmt)).toBe(
      'We raised your bid to $18.00 — your max is $40.00.',
    );
  });
});
