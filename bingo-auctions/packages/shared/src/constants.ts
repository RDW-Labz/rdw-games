// Application-wide constants. Keep this file pure (no imports beyond types).

export const SOFT_CLOSE_DEFAULT_MINUTES = 3;

export const DEFAULT_BUYER_PREMIUM_BPS = 1500; // 15%
export const DEFAULT_APPLICATION_FEE_BPS = 200; // 2%

export const MIN_STARTING_BID_CENTS = 100; // $1.00

export const PICKUP_WINDOW_DEFAULT_DAYS = 4;

export const NO_SHOW_PENALTY_CENTS = 100; // $1 per missed pickup
export const RELIST_FEE_BPS = 500; // 5% of sale price

// Bidders pay no friction for small bids; once their max ticks above this
// threshold and they aren't yet verified, we route them through Stripe
// Identity. Tune via the legal/risk review.
export const IDENTITY_VERIFICATION_THRESHOLD_CENTS = 500_00; // $500

// Bin location code regex: e.g., "A-02-3-04" or "01-04-2-01"
export const BIN_CODE_REGEX = /^[A-Z0-9]{1,3}-[0-9]{1,3}(-[0-9]+)?(-[0-9]+)?$/;

// Stripe Connect — application fee is computed on the (winning bid + buyer
// premium), NOT on tax. operator gets the rest minus Stripe processing fees.

export const REALTIME_CHANNELS = {
  lot: (lotId: string) => `lot:${lotId}`,
  auction: (auctionId: string) => `auction:${auctionId}`,
  operatorPickups: (operatorId: string) => `operator:${operatorId}:pickups`,
} as const;

export const PUSH_EVENTS = {
  outbid: 'outbid',
  won: 'won',
  pickupReady: 'pickup_ready',
  pickupConfirmed: 'pickup_confirmed',
  disputeUpdate: 'dispute_update',
} as const;
