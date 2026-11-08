-- ============================================================================
-- 0123_bidder_stripe_key_mode.sql
--
-- 2026-05-22 launch lockout RCA — automatic stale-row detection for Stripe IDs
-- after a key rotation.
--
-- The lockout root cause: when the Worker's STRIPE_SECRET_KEY was rotated
-- from one Stripe account/mode to another (test ↔ live, or a fresh live
-- account swap), every bidder row's persisted `stripe_customer_id` and
-- `default_payment_method_id` instantly became unresolvable — the old
-- `cus_…` and `pm_…` ids belong to a Stripe account the current keys can't
-- see. There was NO signal at the DB level that any given bidder row was
-- "from the previous key generation" so our retry / clear logic could only
-- fire AFTER a Stripe.retrieve() actually threw. That's:
--
--   1. Slow — one user has to hit the failure before we clear it.
--   2. Lossy — every page-load mid-failure burned an API call.
--   3. Mis-categorized — a real "Stripe is down" 5xx looked identical to
--      a key-rotation stale row, so we couldn't tell them apart.
--
-- The fix in this migration:
--   - Add a tiny breadcrumb column `stripe_key_mode` populated whenever we
--     create or verify the bidder's Stripe customer. The value is just
--     'test' or 'live' — the MODE of the secret key that minted the
--     persisted ids.
--   - The runtime (ensureBidderStripeCustomer + the three read sites:
--     /api/bidder/payment-method GET+POST, /bidder/onboarding/payment-method,
--     /profile) compares this against the current Worker's key mode. A
--     mismatch is a definitive "stale row" signal — clear the customer_id
--     + pm_id, surface the renew flow, no Stripe round-trip needed.
--
-- The column is nullable on purpose:
--   - Existing rows from before this migration have no breadcrumb. The
--     runtime treats NULL as "legacy, unknown — NOT stale". On the next
--     customer touch we'll populate it. That ensures we never auto-clear
--     a legacy row that's actually fine.
--   - Once populated, every subsequent customer-touch re-asserts it so
--     a row that survives a key rotation gets its mode updated at the
--     moment we verify the customer is still good under the new keys.
-- ============================================================================

-- ── 1. Add the column (idempotent) ──────────────────────────────────────────
-- TEXT not ENUM because we only ever store two string literals and the
-- CHECK constraint enforces the domain. Adding values to a Postgres ENUM
-- requires an ALTER TYPE migration; we don't need that overhead here.
ALTER TABLE bidders
  ADD COLUMN IF NOT EXISTS stripe_key_mode TEXT;

-- ── 2. Constrain the domain ─────────────────────────────────────────────────
-- Allows NULL (legacy rows we haven't backfilled) OR one of the two valid
-- key modes. Anything else is a code bug — fail loudly at INSERT/UPDATE.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bidders_stripe_key_mode_chk'
  ) THEN
    ALTER TABLE bidders
      ADD CONSTRAINT bidders_stripe_key_mode_chk
      CHECK (stripe_key_mode IS NULL OR stripe_key_mode IN ('test', 'live'));
  END IF;
END $$;

-- ── 3. Partial index for ops queries ────────────────────────────────────────
-- An ops engineer wanting to see "how many bidders are on the OLD key mode
-- after a rotation" benefits from being able to filter on this cheaply.
-- Partial WHERE NOT NULL keeps the index small — the vast majority of rows
-- are populated; we'd waste space indexing the few legacy NULLs.
CREATE INDEX IF NOT EXISTS bidders_stripe_key_mode_idx
  ON bidders (stripe_key_mode)
  WHERE stripe_key_mode IS NOT NULL;

-- ── 4. Document the column ──────────────────────────────────────────────────
COMMENT ON COLUMN bidders.stripe_key_mode IS
  'Stripe key mode (test|live) that minted this bidder''s current '
  'stripe_customer_id. When the running Worker''s STRIPE_SECRET_KEY mode '
  'differs, treat customer_id + default_payment_method_id as stale and '
  'auto-clear on next bidder visit. 2026-05-22 launch lockout RCA.';
