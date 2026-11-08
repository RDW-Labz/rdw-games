// Refund override (mig 0474) form rules and copy. Fake amounts only.
import { describe, expect, it } from 'vitest';
import {
  allowedOverrideMethods,
  canOfferRefundOverride,
  parseDollarsToCents,
  refundOverrideDoneMessage,
  refundOverrideErrorMessage,
  refundOverrideInputError,
} from '../refund-override';

describe('canOfferRefundOverride', () => {
  it('only on a paid invoice with no card payment', () => {
    expect(canOfferRefundOverride({ status: 'paid', square_payment_id: null, stripe_charge_id: null })).toBe(true);
    expect(canOfferRefundOverride({ status: 'partially_refunded', square_payment_id: null, stripe_charge_id: null })).toBe(true);
    expect(canOfferRefundOverride({ status: 'paid', square_payment_id: 'sq', stripe_charge_id: null })).toBe(false);
    expect(canOfferRefundOverride({ status: 'paid', square_payment_id: null, stripe_charge_id: 'ch' })).toBe(false);
    expect(canOfferRefundOverride({ status: 'pending', square_payment_id: null, stripe_charge_id: null })).toBe(false);
  });
});

describe('allowedOverrideMethods', () => {
  it('credit-paid money goes back only as credit', () => {
    expect(allowedOverrideMethods({ total_cents: 252, credit_applied_cents: 252, refunded_cash_cents: 0 })).toEqual(['store_credit']);
    expect(allowedOverrideMethods({ total_cents: 1242, credit_applied_cents: 0, refunded_cash_cents: 0 })).toEqual(['cash', 'store_credit']);
    expect(allowedOverrideMethods({ total_cents: 1242, credit_applied_cents: 0, refunded_cash_cents: 1242 })).toEqual(['store_credit']);
  });
});

describe('parseDollarsToCents', () => {
  it('reads plain dollar amounts only', () => {
    expect(parseDollarsToCents('2.52')).toBe(252);
    expect(parseDollarsToCents('$10')).toBe(1000);
    expect(parseDollarsToCents('0')).toBeNull();
    expect(parseDollarsToCents('2.525')).toBeNull();
    expect(parseDollarsToCents('abc')).toBeNull();
  });
});

describe('refundOverrideInputError', () => {
  const ok = { lotId: 'l', amountCents: 252, lineMaxCents: 252, method: 'store_credit' as const, staffName: 'Jared', reason: 'Broken lock' };
  it('passes a complete form', () => expect(refundOverrideInputError(ok)).toBeNull());
  it('never more than the line was paid', () => {
    expect(refundOverrideInputError({ ...ok, amountCents: 253 })).toBe('That is more than this item was paid ($2.52).');
  });
  it('needs a name and a reason', () => {
    expect(refundOverrideInputError({ ...ok, staffName: ' ' })).toMatch(/Type your name/);
    expect(refundOverrideInputError({ ...ok, reason: 'x' })).toMatch(/Say why/);
  });
});

describe('refundOverrideErrorMessage', () => {
  it('every refusal is plain words', () => {
    for (const reason of ['manager_only', 'use_card_refund', 'over_line_paid', 'cash_over_paid_offline', 'over_per_use_cap', 'over_daily_cap', 'lot_forfeited', 'invoice_already_refunded']) {
      expect(refundOverrideErrorMessage({ ok: false, reason })).not.toMatch(/failed/);
    }
    expect(refundOverrideErrorMessage({ ok: false, reason: 'over_daily_cap', cap_cents: 10000, used_today_cents: 9000 }))
      .toBe("Today's override limit is $100.00 and $90.00 is used. An admin must handle it.");
    expect(refundOverrideErrorMessage({ ok: false, reason: 'cash_over_paid_offline', cash_left_cents: 0 }))
      .toMatch(/only go back as account credit/);
  });
  it('done line says how the money goes back', () => {
    expect(refundOverrideDoneMessage({ ok: true, amount_cents: 252, method: 'store_credit' }, 'TEA3828564'))
      .toBe('Recorded: $2.52 back as account credit for TEA3828564.');
  });
});
