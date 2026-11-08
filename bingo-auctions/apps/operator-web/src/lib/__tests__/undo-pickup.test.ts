import { describe, it, expect } from 'vitest';
import {
  canUndoPickup,
  undoPickupDoneMessage,
  undoPickupErrorMessage,
  undoPickupInputError,
} from '../undo-pickup';

const ok = { lotId: 'lot-1', reason: 'wrong lot scanned at the counter' };

describe('canUndoPickup', () => {
  it('offers a picked-up line on a paid invoice to an admin', () => {
    expect(canUndoPickup({ kind: 'picked_up', invoicePaid: true, isAdmin: true })).toBe(true);
  });

  it('never offers the panel to a manager or picker (mig 0487 is admin only)', () => {
    expect(canUndoPickup({ kind: 'picked_up', invoicePaid: true, isAdmin: false })).toBe(false);
  });

  it('never offers other states or an unpaid invoice', () => {
    for (const kind of [
      'owed',
      'forfeited',
      'missing',
      'refunded',
      'relisted',
      'not_paid',
      'forfeit_undone',
    ]) {
      expect(canUndoPickup({ kind, invoicePaid: true, isAdmin: true })).toBe(false);
    }
    expect(canUndoPickup({ kind: 'picked_up', invoicePaid: false, isAdmin: true })).toBe(false);
  });
});

describe('undoPickupInputError', () => {
  it('passes a complete form', () => {
    expect(undoPickupInputError(ok)).toBeNull();
  });

  it('needs an item', () => {
    expect(undoPickupInputError({ ...ok, lotId: null })).toMatch(/item/);
  });

  it('needs a reason of at least 5 characters, ignoring spaces', () => {
    expect(undoPickupInputError({ ...ok, reason: '' })).toMatch(/why/);
    expect(undoPickupInputError({ ...ok, reason: '  abcd  ' })).toMatch(/why/);
    expect(undoPickupInputError({ ...ok, reason: 'abcde' })).toBeNull();
  });
});

describe('undoPickupErrorMessage', () => {
  it('names the relisted lot to cancel first', () => {
    const msg = undoPickupErrorMessage({
      ok: false,
      code: 'relist_child_live',
      child_lot_code: 'BIN-000456',
      child_status: 'scheduled',
    });
    expect(msg).toContain('BIN-000456');
    expect(msg).toContain('scheduled');
    expect(msg).toMatch(/Cancel/);
  });

  it('keeps the manager/picker copy different from the admin copy', () => {
    expect(undoPickupErrorMessage({ ok: false, code: 'forbidden' })).toMatch(/Only an admin/);
  });

  it('explains a refunded line', () => {
    expect(undoPickupErrorMessage({ ok: false, code: 'refunded' })).toMatch(
      /money already went back/,
    );
  });

  it('names the lot status when the lot cannot be touched', () => {
    expect(
      undoPickupErrorMessage({ ok: false, code: 'lot_status', lot_status: 'relisted' }),
    ).toContain('relisted');
  });

  it('explains an expired pickup window without pretending it changed anything', () => {
    const msg = undoPickupErrorMessage({
      ok: false,
      code: 'pickup_expired',
      pickup_deadline: '2026-11-01T00:00:00Z',
    });
    expect(msg).toMatch(/window has already closed/);
    expect(msg).toMatch(/deadline/);
    expect(msg).toMatch(/Nothing was changed/);
  });

  it('points a closed visit at Undo forfeit or a manager decision', () => {
    expect(
      undoPickupErrorMessage({ ok: false, code: 'pickup_closed', pickup_status: 'forfeited' }),
    ).toMatch(/Undo forfeit/);
    expect(
      undoPickupErrorMessage({ ok: false, code: 'pickup_closed', pickup_status: 'no_show' }),
    ).toMatch(/no-show/);
  });

  it('falls back to "nothing was changed" and echoes the code', () => {
    expect(undoPickupErrorMessage({ ok: false, code: 'weird' })).toMatch(/weird/);
    expect(undoPickupErrorMessage({ ok: false, code: 'weird' })).toMatch(/Nothing was changed/);
    expect(undoPickupErrorMessage(null)).toMatch(/Nothing was changed/);
  });
});

describe('undoPickupDoneMessage', () => {
  it('says the item is owed again', () => {
    const msg = undoPickupDoneMessage({ ok: true, reverted: true, lot_code: 'TEA1' });
    expect(msg).toContain('TEA1');
    expect(msg).toMatch(/owed again/);
  });

  it('points at Undo forfeit when the line is also forfeited', () => {
    const msg = undoPickupDoneMessage({
      ok: true,
      reverted: true,
      lot_code: 'TEA1',
      forfeit_remains: true,
    });
    expect(msg).toMatch(/Undo forfeit/);
  });

  it('is a no-op message when it was already undone', () => {
    expect(undoPickupDoneMessage({ ok: true, already_undone: true, lot_code: 'TEA1' })).toMatch(
      /Nothing changed/,
    );
  });
});
