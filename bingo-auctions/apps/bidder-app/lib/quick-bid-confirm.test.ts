import { describe, it, expect } from 'vitest';
import { quickBidConfirmCopy } from './quick-bid-confirm';

describe('quickBidConfirmCopy', () => {
  it('names the exact amount in both the message and the confirm button', () => {
    const copy = quickBidConfirmCopy('$18.00');
    expect(copy).toEqual({
      title: 'Place a bid?',
      message: 'Bid $18.00 on this lot?',
      cancelLabel: 'Cancel',
      confirmLabel: 'Bid $18.00',
    });
  });

  it('reflects a different amount verbatim (no rounding/reformatting)', () => {
    const copy = quickBidConfirmCopy('$1,234.56');
    expect(copy.message).toBe('Bid $1,234.56 on this lot?');
    expect(copy.confirmLabel).toBe('Bid $1,234.56');
  });
});
