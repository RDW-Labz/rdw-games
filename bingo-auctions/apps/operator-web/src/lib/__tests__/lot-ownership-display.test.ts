// Lot page ownership text. Fake dates only.
import { describe, expect, it } from 'vitest';
import { embeddedPickup, handedOver, pickupLabel, purchasedLabel, type OwnershipInput } from '../lot-ownership-display';

const fmt = (iso: string) => iso.slice(5, 10);
const base: OwnershipInput = {
  linePickedUpAt: null,
  lineRefundedAt: null,
  lineForfeitedAt: null,
  invoiceStatus: 'paid',
  invoicePaidAt: '2026-10-21T23:05:35Z',
  pickup: null,
  rowRelisted: false,
  fmt,
};

describe('embeddedPickup (pickups.invoice_id is UNIQUE, so PostgREST sends an object)', () => {
  it('reads the object shape prod actually returns', () => {
    expect(embeddedPickup({ status: 'completed', completed_at: '2026-10-26T22:08:56Z' })).toEqual({ status: 'completed', completed_at: '2026-10-26T22:08:56Z' });
  });
  it('still reads an array, and nothing', () => {
    expect(embeddedPickup([{ status: 'pending', completed_at: null }])?.status).toBe('pending');
    expect(embeddedPickup([])).toBeNull();
    expect(embeddedPickup(null)).toBeNull();
  });
  it('the old `pickups?.[0]` read of the object is what produced "Awaiting pickup"', () => {
    const obj = { status: 'completed', completed_at: 'x' } as unknown as { status: string }[];
    expect(obj?.[0]).toBeUndefined();
  });
});

describe('pickupLabel', () => {
  it('Lot #14 (TEA4842561): refunded line, invoice pickup completed -> refunded, not "Awaiting pickup"', () => {
    expect(pickupLabel({ ...base, lineRefundedAt: '2026-10-26T22:07:14Z', pickup: { status: 'completed', completed_at: '2026-10-26T22:08:56Z' } }))
      .toBe('Refunded 10-26 — not handed over');
  });
  it('picked-up line (the other items on that invoice)', () => {
    expect(pickupLabel({ ...base, linePickedUpAt: '2026-10-26T22:08:56Z' })).toBe('Picked up 10-26');
  });
  it('old relisted row with a declined invoice (BIN-031301)', () => {
    expect(pickupLabel({ ...base, invoiceStatus: 'payment_failed_relisted', invoicePaidAt: null, rowRelisted: true })).toBe('Relisted — sale cancelled');
  });
  it('forfeited line', () => {
    expect(pickupLabel({ ...base, lineForfeitedAt: '2026-10-18T21:00:00Z' })).toBe('Forfeited 10-18 (no-show)');
  });
  it('unpaid invoice is not "waiting for pickup"', () => {
    expect(pickupLabel({ ...base, invoiceStatus: 'pending', invoicePaidAt: null })).toBe('Not paid — nothing to hand over');
  });
  it('invoice pickup completed and line not stamped', () => {
    expect(pickupLabel({ ...base, pickup: { status: 'completed', completed_at: '2026-10-26T22:08:56Z' } })).toBe('Picked up 10-26');
  });
  it('checked in, and a genuinely waiting paid item', () => {
    expect(pickupLabel({ ...base, pickup: { status: 'checked_in', completed_at: null } })).toBe('checked in');
    expect(pickupLabel({ ...base, pickup: { status: 'pending', completed_at: null } })).toBe('Awaiting pickup');
    expect(pickupLabel(base)).toBe('Awaiting pickup');
  });
});

describe('purchasedLabel / handedOver', () => {
  it('declined-and-relisted invoice says so', () => {
    expect(purchasedLabel({ invoiceStatus: 'payment_failed_relisted', invoicePaidAt: null, fmt })).toBe('Card declined — relisted');
    expect(purchasedLabel({ invoiceStatus: 'paid', invoicePaidAt: '2026-10-21T23:05:35Z', fmt })).toBe('10-21');
  });
  it('a refunded line was never handed over even if the invoice pickup completed', () => {
    expect(handedOver({ linePickedUpAt: null, lineRefundedAt: 'x', lineForfeitedAt: null, pickup: { status: 'completed', completed_at: 'y' } })).toBe(false);
    expect(handedOver({ linePickedUpAt: 'x', lineRefundedAt: null, lineForfeitedAt: null, pickup: null })).toBe(true);
  });
});
