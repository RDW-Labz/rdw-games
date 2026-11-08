import { describe, it, expect } from 'vitest';
import { QUICK_BID_CONFIRM_MIN_MS, quickBidClick } from '../quick-bid-confirm';

describe('quickBidClick', () => {
  it('first click arms the confirmation and does not place a bid', () => {
    expect(quickBidClick(false)).toEqual({ nextConfirming: true, shouldPlaceBid: false });
  });

  it('second click (while confirming) places the bid and disarms', () => {
    expect(quickBidClick(true)).toEqual({ nextConfirming: false, shouldPlaceBid: true });
    expect(quickBidClick(true, 1500)).toEqual({ nextConfirming: false, shouldPlaceBid: true });
  });

  it('a double-click does not bid: a second click within the minimum stays armed', () => {
    expect(quickBidClick(true, 120)).toEqual({ nextConfirming: true, shouldPlaceBid: false });
    expect(quickBidClick(true, QUICK_BID_CONFIRM_MIN_MS - 1)).toEqual({ nextConfirming: true, shouldPlaceBid: false });
    expect(quickBidClick(true, QUICK_BID_CONFIRM_MIN_MS)).toEqual({ nextConfirming: false, shouldPlaceBid: true });
  });
});
