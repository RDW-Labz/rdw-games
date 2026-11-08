import { describe, expect, it } from 'vitest';
import { refundFailureMessage, refundSuccessMessage } from './refund-result-copy';

describe('checkout refund sheet copy (TEA3828564, 2026-10-27)', () => {
  it('says why Square could not refund and what to do', () => {
    for (const code of ['no_card_payment', 'no_payment_to_refund']) {
      expect(refundFailureMessage({ error: code }, 409)).toMatch(/not by card.*Refund override/);
    }
  });

  it('turns every known code into words, passes sentences through', () => {
    for (const code of ['lot_already_refunded', 'lot_forfeited', 'refund_exceeds_invoice_total', 'nothing_left_to_refund', 'refund_in_flight', 'lot_not_in_invoice', 'forbidden', 'refund_failed']) {
      expect(refundFailureMessage({ error: code }, 409)).not.toContain('_');
    }
    expect(refundFailureMessage({ error: 'outside the 48h refund window' }, 409)).toBe('outside the 48h refund window');
    expect(refundFailureMessage({}, 502)).toMatch(/Server returned 502/);
  });

  it('success says where the money goes', () => {
    expect(refundSuccessMessage(1, { cash_cents: 0, credit_cents: 252 })).toBe(
      'Refund for 1 item: $2.52 back as account credit (it was paid with credit). Nothing goes to a card.',
    );
    expect(refundSuccessMessage(2, { cash_cents: 500, credit_cents: 100 })).toMatch(/\$5\.00 back to the card.*\$1\.00 back as account credit/);
    expect(refundSuccessMessage(1, { cash_cents: 500, credit_cents: 0 })).toMatch(/submitted to Square/);
  });
});
