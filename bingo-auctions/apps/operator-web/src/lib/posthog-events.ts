// PostHog event helpers — bidder + operator funnel.
//
// posthog-js is already wired up via PostHogProvider / initPostHog in
// the (operator) layout, with pageview + pageleave auto-capture and
// posthog.identify on the operator side. This module adds the
// hand-crafted lifecycle events that don't have an auto-capture
// equivalent. Each helper is a thin wrapper around posthog.capture so
// the call sites stay one-liners and the event names stay typed.
//
// Funnel we care about (bidder side, launch priority):
//   bidder_onboarded  -> bidder_card_saved -> bidder_bid_placed
//   -> bidder_won (server-driven; not captured here)
//   -> bidder_invoice_paid (server-driven; not captured here)
//
// Server-driven events live in Supabase status-history tables; the
// PostHog dashboard reads them via the daily Supabase → PostHog export
// (set up post-launch). Until then the client-side funnel captures the
// browse → bid step which is the most decision-relevant one.
//
// Why thin wrappers and not a generic capture():
//   - Compile-time check that event names match between call sites and
//     dashboards / insights (PostHog itself is string-typed).
//   - Centralized property shape per event — analysts know which
//     fields they can slice by.
//   - Easy to swap providers later (Amplitude, Mixpanel, custom) —
//     callers stay untouched.

'use client';

import posthog from 'posthog-js';

/**
 * Bidder finished step 1 of onboarding (DOB + consents). Fires
 * immediately after POST /api/bidder/signup succeeds, just before
 * the redirect to the card-save step.
 */
export function captureBidderOnboarded(): void {
  try {
    posthog.capture('bidder_onboarded');
  } catch {
    // posthog might not be initialized (e.g. NEXT_PUBLIC_POSTHOG_KEY
    // missing in dev). Swallow — analytics must never break the flow.
  }
}

/**
 * Bidder saved their first (or updated) payment method. Fires after
 * POST /api/bidder/payment-method returns ok, before the bounce to
 * /browse. The is_first flag lets the funnel distinguish first-card
 * (high-value conversion) from update-card (maintenance).
 */
export function captureCardSaved(props: { is_first: boolean }): void {
  try {
    posthog.capture('bidder_card_saved', {
      is_first: props.is_first,
    });
  } catch {
    /* see captureBidderOnboarded */
  }
}

/**
 * Bidder placed a bid via the web BidWidget. Fires after the
 * place_bid RPC returns ok. We capture the lot code (not id) so
 * dashboards can group by lot without joining lots.
 */
export function captureBidPlaced(props: {
  lot_code: string;
  max_amount_cents: number;
  was_extended: boolean;
}): void {
  try {
    posthog.capture('bidder_bid_placed', {
      lot_code: props.lot_code,
      max_amount_cents: props.max_amount_cents,
      // Dollar-denominated copy so dashboards can chart $ without
      // dividing by 100 in every insight. Keep both.
      max_amount_usd: props.max_amount_cents / 100,
      was_extended: props.was_extended,
    });
  } catch {
    /* see captureBidderOnboarded */
  }
}

/**
 * Bidder toggled the watchlist star on a LotCard. Fires after the
 * insert/delete against the `watchlist` table succeeds. The `watched`
 * flag is the NEW state (true = just added, false = just removed) so
 * dashboards can compute conversion of watch → bid downstream.
 */
export function captureWatchlistToggled(props: {
  lot_code: string;
  watched: boolean;
}): void {
  try {
    posthog.capture('bidder_watchlist_toggled', {
      lot_code: props.lot_code,
      watched: props.watched,
    });
  } catch {
    /* see captureBidderOnboarded */
  }
}

/**
 * Bidder landed on the FinalCall view. Fires from the mount of the
 * /final-call client island. The `source` property lets the funnel
 * separate nav-driven entries from homepage-CTA entries from direct
 * links / bookmarks — informs where FinalCall awareness comes from.
 */
export type FinalCallSource = 'nav' | 'homepage' | 'direct';

export function captureFinalCallEntered(props: {
  source: FinalCallSource;
}): void {
  try {
    posthog.capture('bidder_final_call_entered', {
      source: props.source,
    });
  } catch {
    /* see captureBidderOnboarded */
  }
}
