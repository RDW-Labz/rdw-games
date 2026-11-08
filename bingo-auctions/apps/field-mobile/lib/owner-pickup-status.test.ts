import { describe, expect, it } from 'vitest';
import { ownerPickupStatus } from './owner-pickup-status';

describe('ownerPickupStatus (TEA4842561, 2026-10-28)', () => {
  it('declined-and-relisted sale (BIN-031301) is not "Awaiting pickup"', () => {
    expect(ownerPickupStatus({ invoice_status: 'payment_failed_relisted' })).toBe('Relisted — sale cancelled');
  });
  it('refunded line wins even when the invoice pickup completed', () => {
    expect(ownerPickupStatus({ invoice_status: 'partially_refunded', refunded_at: '2026-10-26T22:07:14Z', pickup_status: 'completed' }))
      .toMatch(/^Refunded .* — not handed over$/);
  });
  it('unpaid is never handed over', () => {
    expect(ownerPickupStatus({ invoice_status: 'pending' })).toBe('Not paid — do not hand over');
    expect(ownerPickupStatus({ invoice_status: 'payment_failed_grace' })).toBe('Not paid — do not hand over');
    expect(ownerPickupStatus({})).toBe('Not paid — do not hand over');
  });
  it('picked up, checked in, and genuinely waiting', () => {
    expect(ownerPickupStatus({ invoice_status: 'paid', picked_up_at: '2026-10-26T22:08:56Z' })).toMatch(/^Picked up /);
    expect(ownerPickupStatus({ invoice_status: 'paid', pickup_status: 'completed' })).toBe('Picked up');
    expect(ownerPickupStatus({ invoice_status: 'paid', pickup_status: 'checked_in' })).toBe('checked in');
    expect(ownerPickupStatus({ invoice_status: 'paid', pickup_status: 'pending' })).toBe('Awaiting pickup');
  });
});
