import { describe, it, expect } from 'vitest';
import {
  canUndoForfeit,
  undoForfeitDoneMessage,
  undoForfeitErrorMessage,
  undoForfeitInputError,
} from '../undo-forfeit';

const ok = { lotId: 'lot-1', purpose: 'refund' as const, reason: 'customer was at the counter', doneBy: 'Sam' };

describe('canUndoForfeit', () => {
  it('offers a forfeited line on a paid invoice', () => {
    expect(canUndoForfeit({ kind: 'forfeited', invoicePaid: true })).toBe(true);
  });

  it('never offers other states or an unpaid invoice', () => {
    for (const kind of ['owed', 'picked_up', 'missing', 'refunded', 'relisted', 'not_paid']) {
      expect(canUndoForfeit({ kind, invoicePaid: true })).toBe(false);
    }
    expect(canUndoForfeit({ kind: 'forfeited', invoicePaid: false })).toBe(false);
  });
});

describe('undoForfeitInputError', () => {
  it('passes a complete form', () => {
    expect(undoForfeitInputError(ok)).toBeNull();
    expect(undoForfeitInputError({ ...ok, purpose: 'picked_up' })).toBeNull();
  });

  it('needs an item', () => {
    expect(undoForfeitInputError({ ...ok, lotId: null })).toMatch(/item/);
  });

  it('needs what happens next', () => {
    expect(undoForfeitInputError({ ...ok, purpose: '' })).toMatch(/refund it or mark it picked up/);
  });

  it('needs a typed name (shared login), ignoring spaces', () => {
    expect(undoForfeitInputError({ ...ok, doneBy: '' })).toMatch(/name/);
    expect(undoForfeitInputError({ ...ok, doneBy: '  a  ' })).toMatch(/name/);
  });

  it('needs a reason of at least 5 characters, ignoring spaces', () => {
    expect(undoForfeitInputError({ ...ok, reason: '' })).toMatch(/why/);
    expect(undoForfeitInputError({ ...ok, reason: '  abcd  ' })).toMatch(/why/);
    expect(undoForfeitInputError({ ...ok, reason: 'abcde' })).toBeNull();
  });
});

describe('undoForfeitErrorMessage', () => {
  it('names the relist lot to pull first', () => {
    const msg = undoForfeitErrorMessage({
      ok: false,
      code: 'relist_child_live',
      child_lot_code: 'BIN-000123',
      child_status: 'scheduled',
    });
    expect(msg).toContain('BIN-000123');
    expect(msg).toContain('scheduled');
    expect(msg).toMatch(/Cancel lot/);
    expect(msg).toMatch(/A refund does not need this/);
  });

  it('still explains a relist without a lot code', () => {
    expect(undoForfeitErrorMessage({ ok: false, code: 'relist_child_live' })).toMatch(/pull the relisted lot first/);
  });

  it('has plain words for every refusal code the function returns', () => {
    const codes = [
      'forbidden',
      'bad_purpose',
      'reason_required',
      'name_required',
      'not_found',
      'invoice_not_paid',
      'not_forfeited',
      'already_refunded',
      'already_picked_up',
      'relist_child_live',
      'lot_status',
    ];
    for (const code of codes) {
      const msg = undoForfeitErrorMessage({ ok: false, code });
      expect(msg, code).not.toMatch(/failed/);
      expect(msg.length, code).toBeGreaterThan(10);
    }
  });

  it('falls back to a safe message with the code', () => {
    expect(undoForfeitErrorMessage({ ok: false, code: 'weird' })).toMatch(/weird.*Nothing was changed/);
    expect(undoForfeitErrorMessage(null)).toMatch(/Nothing was changed/);
  });
});

describe('undoForfeitDoneMessage', () => {
  it('points to the refund form for a refund', () => {
    expect(undoForfeitDoneMessage({ ok: true, purpose: 'refund', lot_code: 'BIN-1' })).toMatch(/BIN-1.*Refund items/);
  });

  it('says the relist keeps running after a refund undo with a live relist', () => {
    expect(
      undoForfeitDoneMessage({ ok: true, purpose: 'refund', lot_code: 'BIN-1', relist_kept: 'BIN-2' }),
    ).toMatch(/Refund items\. Its relist BIN-2 keeps running\./);
  });

  it('points to the pickup override for picked up', () => {
    expect(undoForfeitDoneMessage({ ok: true, purpose: 'picked_up', lot_code: 'BIN-1' })).toMatch(
      /Manual pickup override/,
    );
  });
});
