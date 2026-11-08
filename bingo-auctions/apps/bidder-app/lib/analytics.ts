// Centralized PostHog event registry for the bidder app.
//
// Why this file exists:
//   - Compile-time check that event names match between mobile and web
//     dashboards. PostHog itself is string-typed at the wire; mistakes
//     show up days later when an insight goes empty.
//   - Centralized property shape per event — analysts know exactly what
//     they can slice by, mobile and web stay in lockstep.
//   - Mobile parity with apps/operator-web/src/lib/posthog-events.ts.
//     The web file already covers bidder_onboarded / bidder_card_saved /
//     bidder_bid_placed / bidder_watchlist_toggled / bidder_final_call_entered.
//     This file adds the user-actions that only happen on mobile (pickup
//     QR flow) plus mirrors of the web events so funnels join cleanly.
//
// Conventions:
//   - Event name = snake_case, verb-past-tense ('bid_placed', not 'placeBid').
//   - lot_code (printed-sticker code) preferred over lot_id (uuid) so
//     dashboards can group without joining lots.
//   - Money in cents — keep one canonical unit. PostHog UI does the
//     /100 if the analyst wants dollars.
//   - Every helper swallows its own errors. Telemetry must NEVER break
//     a user flow. The underlying `track()` in lib/posthog.ts already
//     does this, but defense-in-depth: don't `await` inside callers.
//
// Existing events NOT redefined here (already shipped via the shared
// packages/supabase-client tracker shim and stay untouched):
//   bid_placed         — packages/domain-bidding/PlaceBidSheet.tsx
//   bid_rejected       — same
//   buy_succeeded      — packages/domain-bidding/BuyNowSheet.tsx
//   buy_rejected       — same
//   pickup_scheduled   — packages/domain-fulfillment/PickupScheduler.tsx
//   pickup_schedule_failed — same
//   pickup_confirmed   — packages/domain-fulfillment/BinScanner.tsx
//   dispute_opened     — apps/bidder-app/app/dispute/new.tsx
//   lot_qr_scanned     — apps/bidder-app/app/(tabs)/scan.tsx
//
// New events added in this module are listed in PostHog as
// "bidder_*" / "lot_*" / "pickup_*" / "watchlist_*" / "payment_*"
// matching the web taxonomy.

import { track } from './posthog';

// ── Type definitions ────────────────────────────────────────────────────────

/**
 * Where the bidder entered the lot detail screen from. Lets the funnel
 * separate organic browse → bid from QR-scan → bid (mobile-only) from
 * watchlist re-engagement. 'recent_wins' is the home-rail entry; 'link'
 * covers universal-link / push-notification deep-links.
 */
export type LotViewSource =
  | 'browse'
  | 'scan'
  | 'link'
  | 'watchlist'
  | 'my_bids'
  | 'recent_wins'
  | 'similar'
  | 'unknown';

// ── Signup + onboarding funnel ──────────────────────────────────────────────

/**
 * Bidder mounted the signup screen. Fires once per mount — even if the
 * user bounces without finishing, we see entry volume. Pairs with
 * bidder_signup_completed to measure abandonment.
 */
export function captureSignupStarted(): void {
  void track('bidder_signup_started');
}

/**
 * Bidder completed Supabase auth.signUp AND the operator-web
 * /api/bidder/signup call (consent + DOB persisted). Mirrors web's
 * bidder_onboarded but named to match the funnel step explicitly so
 * dashboards can split mobile vs web at the step level.
 */
export function captureSignupCompleted(props: { method: 'email' | 'oauth' }): void {
  void track('bidder_signup_completed', { method: props.method });
}

/**
 * Bidder finished the onboarding card-save step and is about to land on
 * the home tab for the first time. Equivalent to web's
 * `bidder_card_saved` with `is_first: true`, but represents the *gate*
 * (mobile only forces this on first launch via /profile/payment-method
 * ?onboarding=1).
 */
export function captureOnboardingCompleted(): void {
  void track('bidder_onboarding_completed');
}

// ── Browse / discovery ──────────────────────────────────────────────────────

/**
 * Bidder opened a lot detail screen. Highest-volume event in the funnel
 * — pairs with bid_placed to measure browse → bid conversion. Source
 * lets the funnel separate organic browse from QR scan / push-deep-link
 * / watchlist re-engagement.
 */
export function captureLotViewed(props: {
  lot_code: string;
  source: LotViewSource;
}): void {
  void track('lot_viewed', {
    lot_code: props.lot_code,
    source: props.source,
  });
}

// ── Bidding ─────────────────────────────────────────────────────────────────

/**
 * Bidder was outbid on a lot they've personally bid on (winner_bidder_id
 * flipped from me to someone else via Realtime UPDATE). Distinct from
 * `bid_rejected` (their own bid never landed) — this fires AFTER their
 * bid had been winning. Used to measure outbid → counter conversion.
 */
export function captureBidOutbid(props: {
  lot_code: string;
  new_bid_cents: number;
}): void {
  void track('bid_outbid', {
    lot_code: props.lot_code,
    new_bid_cents: props.new_bid_cents,
  });
}

// ── Win + payment ───────────────────────────────────────────────────────────

/**
 * Bidder opened an invoice that's `paid` and they're seeing it for the
 * first time (the win-confirmation moment). Fires once per
 * (invoice_id × session). Captures GMV signal independent of the
 * server-driven won funnel.
 */
export function captureWonLot(props: {
  invoice_id: string;
  total_cents: number;
  lot_count: number;
}): void {
  void track('won_lot', {
    invoice_id: props.invoice_id,
    total_cents: props.total_cents,
    lot_count: props.lot_count,
  });
}

/**
 * Invoice transitioned from a non-terminal state to `paid` while the
 * bidder was watching the invoice screen (the auto-charge worker
 * succeeded). Fires once per (invoice_id × transition). Provides the
 * client-side mirror of server-side payment_succeeded events.
 */
export function capturePaymentCompleted(props: {
  invoice_id: string;
  total_cents: number;
}): void {
  void track('payment_completed', {
    invoice_id: props.invoice_id,
    total_cents: props.total_cents,
  });
}

// ── Pickup flow (mobile-only) ───────────────────────────────────────────────

/**
 * Bidder opened the pickup detail screen for an invoice (the entry
 * point of the pickup wedge). For self-serve this is the start of the
 * floor-plan walk; for staff-assisted it's the QR-at-counter moment.
 * Fires once per mount. Pairs with pickup_completed to measure
 * abandonment between arriving at the warehouse and finishing pickup.
 */
export function capturePickupStarted(props: {
  invoice_id: string;
  mode: 'staff_assisted' | 'counter_pickup' | 'self_serve_floor_plan' | 'hybrid';
}): void {
  void track('pickup_started', {
    invoice_id: props.invoice_id,
    mode: props.mode,
  });
}

/**
 * Bidder finished a pickup — either bidder_confirm_customer_pickup
 * succeeded (self-serve) or all items in the invoice flipped to
 * `picked_up` (staff-assisted). Lots_count differentiates a one-item
 * pickup from a multi-lot pickup for analytics weighting.
 */
export function capturePickupCompleted(props: {
  invoice_id: string;
  lots_count: number;
  mode: 'staff_assisted' | 'counter_pickup' | 'self_serve_floor_plan' | 'hybrid';
}): void {
  void track('pickup_completed', {
    invoice_id: props.invoice_id,
    lots_count: props.lots_count,
    mode: props.mode,
  });
}

// ── Watchlist ───────────────────────────────────────────────────────────────

/**
 * Bidder added a lot to their watchlist. Pairs with watchlist_removed
 * to measure churn and with bid_placed to measure watch → bid
 * conversion. Mirrors web's `bidder_watchlist_toggled` with
 * `watched: true` but split for cleaner mobile/web funnel joins.
 */
export function captureWatchlistAdded(props: { lot_id: string }): void {
  void track('watchlist_added', { lot_id: props.lot_id });
}

/**
 * Bidder removed a lot from their watchlist. Mirrors web's
 * `bidder_watchlist_toggled` with `watched: false`.
 */
export function captureWatchlistRemoved(props: { lot_id: string }): void {
  void track('watchlist_removed', { lot_id: props.lot_id });
}
