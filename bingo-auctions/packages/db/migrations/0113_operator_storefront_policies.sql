-- ============================================================================
-- 0113_operator_storefront_policies.sql
--
-- Adds per-operator storefront-display policy fields that bidders see on
-- the public auction + lot pages. These are simple, human-friendly fields
-- distinct from the full operator_policies record (which is the legal
-- terms-of-service surface bidders ACCEPT before bidding).
--
-- Schema audit before this migration:
--   - operators.default_buyer_premium_bps INTEGER NOT NULL DEFAULT 1500
--     (0001_init.sql; already used by build_invoices_for_auction in 0072)
--   - auctions.buyer_premium_bps INTEGER NOT NULL DEFAULT 1500
--     (per-auction override; build_invoices_for_auction reads THIS, not the
--      operator default — the auction inherits the operator default at
--      create-time)
--   - invoices.buyer_premium_cents BIGINT (already populated by 0072)
--   - operator_policies.refund_window_post_pickup_hours (legal terms;
--     default 48h post-pickup dispute window per 0093)
--   - operator_policies.terms_md (full legal terms — accepted by bidders)
--   - operators.stripe_tax_acknowledged_at TIMESTAMPTZ (Stripe Tax opt-in)
--   - warehouses.pickup_hours JSONB (machine-readable per-warehouse schedule)
--
-- This migration adds operator-level *display* fields so the storefront
-- can show concise human-readable policy snippets WITHOUT requiring the
-- bidder to expand the full operator_policies record. They live alongside
-- (not replacing) the legal fields.
--
-- Fields added on operators:
--   - pickup_hours_text  TEXT — free-form, eg "Mon-Fri 9-5, Sat 9-12"
--   - dispute_window_days INT NOT NULL DEFAULT 2 — display version of the
--     48-hour post-pickup dispute window from operator_policies.
--   - custom_terms_md   TEXT — operator-specific addenda shown on auction
--     and lot pages. Distinct from operator_policies.terms_md (which is
--     the legal doc bidders accept). Defaults NULL (no custom text).
--   - collect_sales_tax BOOLEAN NOT NULL DEFAULT FALSE — display + Stripe
--     automatic_tax opt-in. Complements stripe_tax_acknowledged_at: the
--     timestamp records when the operator acknowledged responsibility;
--     this BOOL records whether they actively want Stripe to collect.
--
-- Backfill: Michael's first/test operator (Cluer / Bingo) keeps the
-- default buyer's premium (already 15% via default_buyer_premium_bps);
-- we ensure pickup_hours_text starts as a sensible placeholder.
-- ============================================================================

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS pickup_hours_text   TEXT,
  ADD COLUMN IF NOT EXISTS dispute_window_days INT  NOT NULL DEFAULT 2
        CHECK (dispute_window_days BETWEEN 0 AND 30),
  ADD COLUMN IF NOT EXISTS custom_terms_md     TEXT,
  ADD COLUMN IF NOT EXISTS collect_sales_tax   BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN operators.pickup_hours_text IS
  'Free-form display string shown on auction + lot pages, eg "Mon-Fri 9-5, Sat 9-12". '
  'Distinct from warehouses.pickup_hours JSONB (which is the machine-readable per-warehouse '
  'schedule used by pickup-slot RPCs). NULL means the operator has not configured a display '
  'string and the storefront shows a generic "Contact operator for hours" hint.';

COMMENT ON COLUMN operators.dispute_window_days IS
  'Storefront-display version of the post-pickup dispute window. Default 2 days mirrors '
  'the 48-hour window cited by operator_policies (migration 0093). Operators can extend '
  'but not shorten below the platform-minimum (the legal doc still applies).';

COMMENT ON COLUMN operators.custom_terms_md IS
  'Operator-specific addenda shown on auction + lot pages (markdown). Display-only; '
  'distinct from operator_policies.terms_md which is the legal terms-of-service the '
  'bidder explicitly accepts before placing their first bid. Use for: return policy '
  'clarifications, condition disclaimers, weather closures, etc.';

COMMENT ON COLUMN operators.collect_sales_tax IS
  'Operator opts into Stripe automatic_tax on PaymentIntents. Requires the operator to '
  'have enabled Stripe Tax on their connected account (stamped in stripe_tax_acknowledged_at '
  'per migration 0083). When TRUE, build_invoices_for_auction-style flows can pass '
  'automatic_tax: { enabled: true } to Stripe.';

-- Initial backfill: ensure the first/test operator (Cluer / Bingo) has
-- the default buyer premium already in place. operators.default_buyer_premium_bps
-- defaults to 1500 (15%) for all operators, so this is a no-op in practice —
-- we re-affirm it here to make the intent explicit and to fix any
-- hand-modified test operators that ran a different value.
UPDATE operators
   SET default_buyer_premium_bps = 1500
 WHERE default_buyer_premium_bps IS NULL
    OR default_buyer_premium_bps = 0;
