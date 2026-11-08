import { describe, expect, it } from 'vitest';
import { buildEmailHtml, receiptLotsPhrase } from '../email-drain';

const RECEIPT_ROW = {
  id: 'n-1',
  target_user_id: 'bidder-1',
  email_attempt_count: 0,
  kind: 'payment_succeeded' as const,
  payload: { invoice_id: 'inv-1', amount_cents: 756, lot_code: 'BIN-031448' },
};

const strip = (s: string) => s.replace(/<[^>]+>/g, '');

describe('receipt email names every lot on the invoice', () => {
  it('falls back to the single payload lot_code', () => {
    expect(strip(receiptLotsPhrase(undefined, 'BIN-1'))).toBe(' for lot BIN-1');
    expect(receiptLotsPhrase(undefined, null)).toBe('');
  });

  it('names one, two and many lots', () => {
    expect(strip(receiptLotsPhrase(['BIN-1'], 'BIN-1'))).toBe(' for lot BIN-1');
    expect(strip(receiptLotsPhrase(['BIN-1', 'BIN-2'], 'BIN-1'))).toBe(' for lots BIN-1 and BIN-2');
    expect(strip(receiptLotsPhrase(['BIN-1', 'BIN-2', 'BIN-3'], 'BIN-1'))).toBe(
      ' for 3 lots: BIN-1, BIN-2, BIN-3',
    );
  });

  it('2-lot receipt mentions both lots (2026-10-13 case)', () => {
    const row = {
      ...RECEIPT_ROW,
      payload: { ...RECEIPT_ROW.payload, lot_codes: ['BIN-031448', 'TEA3828273'] },
    };
    const html = buildEmailHtml(row)?.html ?? '';
    expect(strip(html)).toContain('Your payment for lots BIN-031448 and TEA3828273 of $7.56 was processed');
  });

  it('single-lot receipt is unchanged', () => {
    const html = buildEmailHtml(RECEIPT_ROW)?.html ?? '';
    expect(strip(html)).toContain('Your payment for lot BIN-031448 of $7.56 was processed');
  });
});
