import { describe, expect, it } from 'vitest';
import { isPickupForfeited, pickupWindowFor } from './pickup-card';

const won = { pickup_starts_at: '2026-10-14T15:30:00+00:00', pickup_ends_at: '2026-10-19T23:00:00+00:00' };

describe('pickupWindowFor', () => {
  it('uses the invoice auction even when the lot was relisted off its auction', () => {
    // d684ead9 shape: lots.auction_id NULL after the relist → lot auction null.
    expect(pickupWindowFor(won, null)).toEqual(won);
  });
  it('prefers the invoice auction over a relist auction with other dates', () => {
    const relist = { pickup_starts_at: '2026-10-26T15:30:00+00:00', pickup_ends_at: '2026-10-31T23:00:00+00:00' };
    expect(pickupWindowFor(won, relist)).toEqual(won);
  });
  it('falls back to the lot auction, then to no window', () => {
    expect(pickupWindowFor(null, won)).toEqual(won);
    expect(pickupWindowFor(null, null)).toEqual({ pickup_starts_at: null, pickup_ends_at: null });
  });
});

describe('isPickupForfeited', () => {
  it('pickup status forfeited (what the no-show sweep writes)', () => {
    expect(isPickupForfeited('forfeited', [{ forfeited_at: null }])).toBe(true);
  });
  it('every owed line forfeited, pickup row not updated', () => {
    expect(isPickupForfeited('pending', [{ forfeited_at: '2026-10-19T23:00:00Z' }, { forfeited_at: '2026-10-19T23:00:00Z' }])).toBe(true);
  });
  it('only some lines forfeited → not a forfeited pickup', () => {
    expect(isPickupForfeited('pending', [{ forfeited_at: '2026-10-19T23:00:00Z' }, { forfeited_at: null }])).toBe(false);
  });
  it('no owed lines, or open pickup → false', () => {
    expect(isPickupForfeited(null, [])).toBe(false);
    expect(isPickupForfeited('pending', [{ forfeited_at: null }])).toBe(false);
    expect(isPickupForfeited('no_show', [{ forfeited_at: null }])).toBe(false);
  });
});
