-- ============================================================================
-- Migration 0203 — single_account_mode flag (Track B: Connect → single account)
-- (renumbered from 0200 → 0203: 0200 was taken by relist_uuid_ossp_fix on master)
--
-- Adds a reversible switch on the platform_settings singleton (the same row as
-- 0198's payments_disabled). When TRUE, the PaymentIntent + refund code paths
-- run as PLAIN DIRECT CHARGES on the one platform Stripe account: they drop all
-- Connect params (application_fee_amount, transfer_data.destination,
-- on_behalf_of, reverse_transfer, refund_application_fee) and bypass the
-- operator-onboarded / charges-enabled gates (operators have no connected
-- account in single-account mode).
--
-- Default FALSE -> 100% inert until a deliberate cutover. Read TS-side via
-- isSingleAccountMode() (apps/operator-web/src/lib/payments-mode.ts), mirroring
-- isPaymentsDisabled(). No SQL function is needed: the charge topology lives
-- entirely in TS routes/cron -- place_bid() does not create PaymentIntents, so
-- (unlike payments_disabled) this flag never needs a SECURITY DEFINER reader.
--
-- Cutover is a separate, deliberate step (swap Stripe keys to the live single
-- account, mint a new webhook secret, clear stale bidder customer/PM ids, set
-- the operator charges-enabled flags) -- NOT performed by this migration.
-- ============================================================================

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS single_account_mode BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.platform_settings.single_account_mode IS
  'Track B: when TRUE, charges/refunds run as plain direct charges on the single platform Stripe account (no Connect destination / application_fee / transfer / reverse_transfer). Default FALSE. Toggle deliberately at cutover.';
