import { describe, expect, it } from 'vitest';
import {
  isRefundedLot,
  managersOnly,
  refundedCountFromProbe,
  relistAfterRefundInputError,
  relistAfterRefundMessage,
  REFUNDED_TAG,
} from './relist-after-refund';

const ok = { managerId: 'm1', pin: '1234', staffName: 'Jo', reason: 'on shelf, fine' };

describe('relist after refund (staff app)', () => {
  it('only a refunded lot takes the PIN path', () => {
    expect(isRefundedLot('refunded')).toBe(true);
    for (const s of ['won', 'unsold', 'in_inventory', 'relisted', null, undefined]) {
      expect(isRefundedLot(s)).toBe(false);
    }
  });

  it('tag text matches the owner decision', () => {
    expect(REFUNDED_TAG).toBe('Refunded – relist');
  });

  it('hides the Refunded pill until 0475 exists', () => {
    expect(refundedCountFromProbe({ count: null, error: { code: '22P02' } })).toBeNull();
    expect(refundedCountFromProbe({ count: null, error: null })).toBe(0);
    expect(refundedCountFromProbe({ count: 3, error: null })).toBe(3);
  });

  it('offers managers and admins only', () => {
    const list = managersOnly([
      { id: 'a', role: 'picker' },
      { id: 'b', role: 'manager' },
      { id: 'c', role: 'admin' },
    ]);
    expect(list.map((w) => w.id)).toEqual(['b', 'c']);
  });

  it('checks every field before calling the server', () => {
    expect(relistAfterRefundInputError(ok)).toBeNull();
    expect(relistAfterRefundInputError({ ...ok, managerId: '' })).toMatch(/manager/);
    expect(relistAfterRefundInputError({ ...ok, pin: '12' })).toMatch(/PIN/);
    expect(relistAfterRefundInputError({ ...ok, pin: '12ab' })).toMatch(/PIN/);
    expect(relistAfterRefundInputError({ ...ok, staffName: ' ' })).toMatch(/name/);
    expect(relistAfterRefundInputError({ ...ok, reason: 'ok' })).toMatch(/why/);
  });

  it('says what happened for every server answer', () => {
    expect(relistAfterRefundMessage({ ok: true, lot_code: 'BIN-1' })).toContain('BIN-1');
    expect(relistAfterRefundMessage({ ok: false, reason: 'pin_bad_pin' })).toMatch(/Wrong manager PIN/);
    expect(relistAfterRefundMessage({ ok: false, reason: 'buyer_took_it' })).toMatch(/took this item home/);
    expect(relistAfterRefundMessage({ ok: false, reason: 'wrong_status', status: 'unsold' })).toContain('unsold');
    expect(relistAfterRefundMessage({ ok: false, reason: 'relist_refused', detail: 'x' })).toContain('x');
    expect(relistAfterRefundMessage({ ok: false, reason: 'mystery' })).toContain('mystery');
    expect(relistAfterRefundMessage(null)).toMatch(/Nothing changed/);
  });
});
