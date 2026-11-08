// Refund form copy and line availability. Fake amounts only.
import { describe, it, expect } from 'vitest';
import { refundErrorMessage, refundLineRefusal, refundLotAvailability, remainingRefundableCents } from '../refund-copy';

describe('remainingRefundableCents', () => {
  it('is what was paid minus what already went back, cash and credit', () => {
    expect(remainingRefundableCents({ total_cents: 10014, refunded_cash_cents: 8694, refunded_credit_cents: 0 })).toBe(1320);
    expect(remainingRefundableCents({ total_cents: 10014, refunded_cash_cents: 4347 })).toBe(5667);
    expect(remainingRefundableCents({ total_cents: 10014 })).toBe(10014);
  });
  it('never goes below zero', () => {
    expect(remainingRefundableCents({ total_cents: 100, refunded_cash_cents: 150 })).toBe(0);
  });
});

describe('refundErrorMessage', () => {
  it('turns the cap refusal into "Only $X left", preferring the server figure', () => {
    expect(refundErrorMessage({ error: 'refund_exceeds_invoice_total', remaining_cents: 1320 }, 400, 5667)).toBe(
      'Only $13.20 left to refund on this invoice.',
    );
    expect(refundErrorMessage({ error: 'refund_exceeds_invoice_total' }, 400, 5667)).toBe(
      'Only $56.67 left to refund on this invoice.',
    );
  });
  it('names an already-refunded item', () => {
    expect(refundErrorMessage({ error: 'lot_already_refunded', lot_code: 'BIN-028843' }, 409, 0)).toMatch(
      /^BIN-028843 was already refunded\./,
    );
  });
  it('names a forfeited item', () => {
    expect(refundErrorMessage({ error: 'lot_forfeited', lot_code: 'BIN-000001' }, 409, 0)).toBe(
      'BIN-000001 was forfeited by a no-show, so it cannot be refunded.',
    );
  });
  it('says a refund is already running on the in-flight refusal', () => {
    expect(refundErrorMessage({ error: 'refund_in_flight', retry_after_seconds: 60 }, 409, 0)).toMatch(/already being processed/);
  });
  it('explains an offline-paid invoice and points to Refund override (TEA3828564, 2026-10-27)', () => {
    for (const code of ['no_card_payment', 'no_payment_to_refund']) {
      expect(refundErrorMessage({ error: code }, 409, 0)).toMatch(/paid offline.*Refund override/);
    }
  });
  it('passes server sentences through and falls back to the status', () => {
    expect(refundErrorMessage({ error: 'outside the 48h refund window' }, 409, 0)).toBe('outside the 48h refund window');
    expect(refundErrorMessage({}, 502, 0)).toBe('Server returned 502');
    expect(refundErrorMessage(null, 500, 0)).toBe('Server returned 500');
  });
});

describe('refundLotAvailability', () => {
  it('lets owed and picked-up lines through', () => {
    expect(refundLotAvailability('owed')).toEqual({ refundable: true, note: null });
    expect(refundLotAvailability('picked_up')).toEqual({ refundable: true, note: null });
  });
  it('greys refunded, forfeited, relisted and unpaid lines with a note', () => {
    expect(refundLotAvailability('refunded', 'Oct 4, 1:50 PM')).toEqual({ refundable: false, note: 'Already refunded Oct 4, 1:50 PM' });
    expect(refundLotAvailability('forfeited', null)).toEqual({ refundable: false, note: 'Forfeited' });
    expect(refundLotAvailability('relisted')).toEqual({ refundable: false, note: 'Relisted — back in stock' });
    expect(refundLotAvailability('not_paid')).toEqual({ refundable: false, note: 'Not paid' });
  });
});

describe('refundLotAvailability: missing (mig 0393)', () => {
  it('keeps a line reported missing refundable, with a note', () => {
    expect(refundLotAvailability('missing', 'Oct 5, 6:00 PM')).toEqual({ refundable: true, note: 'Missing — refund owed' });
  });
});

describe('refundLineRefusal (server authority, mig 0393)', () => {
  const at = '2026-01-01T00:00:00Z';
  it('lets an untouched line through', () => {
    expect(refundLineRefusal({ refunded_at: null, forfeited_at: null }, false)).toBeNull();
  });
  it('refuses a refunded line, missing or not', () => {
    expect(refundLineRefusal({ refunded_at: at, forfeited_at: null }, false)).toBe('lot_already_refunded');
    expect(refundLineRefusal({ refunded_at: at, forfeited_at: at }, true)).toBe('lot_already_refunded');
  });
  it('refuses a forfeited line', () => {
    expect(refundLineRefusal({ refunded_at: null, forfeited_at: at }, false)).toBe('lot_forfeited');
  });
  it('lets a forfeited line through when the counter reported it missing', () => {
    expect(refundLineRefusal({ refunded_at: null, forfeited_at: at }, true)).toBeNull();
  });
});

describe('refundLotAvailability: forfeit undone for a refund (mig 0444)', () => {
  it('is refundable with a note, even while the relist keeps running', () => {
    expect(refundLotAvailability('forfeit_undone')).toEqual({ refundable: true, note: 'Forfeit undone — refund owed' });
  });
});
