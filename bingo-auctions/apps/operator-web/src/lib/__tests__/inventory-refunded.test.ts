import { describe, expect, it } from 'vitest';
import { isRefundedLot, REFUNDED_TAG, showRefundedTab } from '../inventory-refunded';

describe('inventory refunded tag', () => {
  it('tags only refunded lots', () => {
    expect(isRefundedLot('refunded')).toBe(true);
    for (const s of ['in_inventory', 'won', 'unsold', 'relisted', '', null, undefined]) {
      expect(isRefundedLot(s)).toBe(false);
    }
  });

  it('uses the owner wording', () => {
    expect(REFUNDED_TAG).toBe('Refunded – relist');
  });

  it('hides the tab when empty (always, before 0475) unless it is open', () => {
    expect(showRefundedTab(0, false)).toBe(false);
    expect(showRefundedTab(0, true)).toBe(true);
    expect(showRefundedTab(3, false)).toBe(true);
  });
});
