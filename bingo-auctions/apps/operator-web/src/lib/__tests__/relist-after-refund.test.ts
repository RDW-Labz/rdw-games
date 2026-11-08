import { describe, expect, it } from 'vitest';
import { canRelistAfterRefund, relistAfterRefundInputError, relistAfterRefundMessage } from '../relist-after-refund';

describe('canRelistAfterRefund', () => {
  it('refunded lots, and legacy won lots with every line refunded and none picked up', () => {
    expect(canRelistAfterRefund({ lotStatus: 'refunded', lines: [] })).toBe(true);
    expect(canRelistAfterRefund({ lotStatus: 'won', lines: [{ refunded_at: 'x', picked_up_at: null }] })).toBe(true);
    expect(canRelistAfterRefund({ lotStatus: 'won', lines: [{ refunded_at: 'x', picked_up_at: 'y' }] })).toBe(false);
    expect(canRelistAfterRefund({ lotStatus: 'won', lines: [{ refunded_at: null, picked_up_at: null }] })).toBe(false);
    expect(canRelistAfterRefund({ lotStatus: 'won', lines: [] })).toBe(false);
    expect(canRelistAfterRefund({ lotStatus: 'unsold', lines: [] })).toBe(false);
  });
});

describe('form + messages', () => {
  const ok = { managerId: 'w1', pin: '2468', staffName: 'Jared', reason: 'Box on 10-03-01, sellable' };
  it('needs manager, PIN, name and reason', () => {
    expect(relistAfterRefundInputError(ok)).toBeNull();
    expect(relistAfterRefundInputError({ ...ok, managerId: '' })).toMatch(/manager/);
    expect(relistAfterRefundInputError({ ...ok, pin: '12' })).toMatch(/PIN/);
    expect(relistAfterRefundInputError({ ...ok, staffName: ' ' })).toMatch(/name/);
    expect(relistAfterRefundInputError({ ...ok, reason: 'ok' })).toMatch(/why/);
  });
  it('every refusal is plain words', () => {
    for (const reason of ['pin_bad_pin', 'pin_locked', 'pin_not_manager', 'not_refunded', 'not_fully_refunded', 'buyer_took_it', 'relist_refused']) {
      expect(relistAfterRefundMessage({ ok: false, reason })).not.toMatch(/failed:/);
    }
    expect(relistAfterRefundMessage({ ok: true, to_inventory: true, lot_code: 'BIN-040001' })).toMatch(/^Back in inventory as BIN-040001/);
  });
});
