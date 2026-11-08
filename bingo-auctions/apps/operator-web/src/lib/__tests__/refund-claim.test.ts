// Double-click protection for refunds. Fake ids and amounts only.
import { describe, it, expect } from 'vitest';
import { refundAmountClaimKey, refundItemsClaimKey, REFUND_CLAIM_WINDOW_SECONDS } from '../refund-claim';
import { inFlightGate } from '../in-flight-gate';

const INV = 'ca916c68-ed6c-4f72-8c42-000000000000';

describe('refundItemsClaimKey', () => {
  it('names the refund shape: same invoice, same lots in any order, same amount → same key', () => {
    const a = refundItemsClaimKey(INV, ['lot-b', 'lot-a'], 5667);
    const b = refundItemsClaimKey(INV, ['lot-a', 'lot-b'], 5667);
    expect(a).toBe(b);
    expect(a).toMatch(/^items:[0-9a-f]{40}$/);
  });
  it('a different lot set, amount or invoice is a different key', () => {
    const base = refundItemsClaimKey(INV, ['lot-a'], 4347);
    expect(refundItemsClaimKey(INV, ['lot-b'], 4347)).not.toBe(base);
    expect(refundItemsClaimKey(INV, ['lot-a'], 4348)).not.toBe(base);
    expect(refundItemsClaimKey('00000000-0000-0000-0000-000000000001', ['lot-a'], 4347)).not.toBe(base);
  });
  it('stays within the 128-char column limit', () => {
    expect(refundItemsClaimKey(INV, Array.from({ length: 200 }, (_, i) => `lot-${i}`), 1).length).toBeLessThanOrEqual(128);
    expect(refundAmountClaimKey(INV, 1320)).toMatch(/^amount:[0-9a-f]{40}$/);
  });
  it('the window is one minute', () => {
    expect(REFUND_CLAIM_WINDOW_SECONDS).toBe(60);
  });
});

describe('inFlightGate (the double-click on the form)', () => {
  it('lets the first click through and drops the second until the first leaves', () => {
    const gate = inFlightGate();
    expect(gate.enter()).toBe(true);
    expect(gate.busy).toBe(true);
    expect(gate.enter()).toBe(false); // the double-click, same tick, before any re-render
    expect(gate.enter()).toBe(false);
    gate.leave();
    expect(gate.busy).toBe(false);
    expect(gate.enter()).toBe(true);
  });
  it('simulates two submits racing: only one request is sent', async () => {
    const gate = inFlightGate();
    let sent = 0;
    const submit = async () => {
      if (!gate.enter()) return;
      try {
        sent += 1;
        await new Promise((r) => setTimeout(r, 5));
      } finally {
        gate.leave();
      }
    };
    await Promise.all([submit(), submit(), submit()]);
    expect(sent).toBe(1);
    await submit();
    expect(sent).toBe(2);
  });
});
