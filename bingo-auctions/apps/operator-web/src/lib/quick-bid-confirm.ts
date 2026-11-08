// Quick-bid confirm state machine (BID-CONFIRM, 2026-10).
//
// Customer report: "bids happened on their own" — the web "Quick bid $X"
// button placed a bid on ONE click, no confirmation (the typed "Place bid"
// flow is already two-step: type an amount, then click, so it's untouched).
// BidWidget.tsx now gates the click on this instead of calling onPlaceBid
// directly — an inline confirm, not window.confirm.
//
// Pure so the state transition is unit-tested without mounting the widget —
// this app's vitest config is node-env, pure-logic only (see
// apps/operator-web/vitest.config.ts); BidWidget itself needs the Playwright
// e2e suite for interaction coverage.
export interface QuickBidClickResult {
  /** Next value for the component's confirmingQuickBid state. */
  nextConfirming: boolean;
  /** True exactly on the SECOND click of the same (unchanged) amount — the
   *  caller should place the bid. */
  shouldPlaceBid: boolean;
}

/** A second click sooner than this after arming is a double-click, not a
 *  decision: it must not place the bid (the accident this exists to stop). */
export const QUICK_BID_CONFIRM_MIN_MS = 600;

/**
 * wasConfirming: the confirmingQuickBid state before this click.
 * msSinceArmed: time since the click that armed it (null when not armed).
 */
export function quickBidClick(wasConfirming: boolean, msSinceArmed: number | null = null): QuickBidClickResult {
  if (!wasConfirming) return { nextConfirming: true, shouldPlaceBid: false };
  if (msSinceArmed !== null && msSinceArmed < QUICK_BID_CONFIRM_MIN_MS) {
    // Double-click: stay armed, place nothing.
    return { nextConfirming: true, shouldPlaceBid: false };
  }
  return { nextConfirming: false, shouldPlaceBid: true };
}
