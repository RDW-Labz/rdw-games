// Copy for the Quick-bid / Outbid-banner confirm Alert (BID-CONFIRM, 2026-10).
//
// Customer report: "bids happened on their own" — the one-tap "Quick bid $X"
// CTA (and the red Outbid banner's counter, which reuses the same tap) placed
// a bid with no confirmation. Both now route through this copy before calling
// the existing place_bid path (apps/bidder-app/app/lot/[id].tsx counterBid).
//
// Pure so the exact wording is unit-tested without mounting the screen —
// this app's vitest config only runs lib/**/*.ts (no React Native component
// tree; that needs a device, via the Maestro suite).
export interface QuickBidConfirmCopy {
  title: string;
  message: string;
  cancelLabel: string;
  confirmLabel: string;
}

/** amountFormatted: the bid amount already formatted as currency (e.g. via
 *  @auction-platform/shared formatCents), named identically in the title's
 *  confirm button and the body — the whole point is the bidder sees the
 *  exact number before it's placed. */
export function quickBidConfirmCopy(amountFormatted: string): QuickBidConfirmCopy {
  return {
    title: 'Place a bid?',
    message: `Bid ${amountFormatted} on this lot?`,
    cancelLabel: 'Cancel',
    confirmLabel: `Bid ${amountFormatted}`,
  };
}
