-- 0236 — Square directory sync + loyalty accrual (marketing integration)
--
-- Owner, 2026-07-06: Square runs both the auction charges AND the
-- brick-and-mortar stores (incl. Square Loyalty). Two opt-in bridges:
--
--   square_sync_enabled     every bidder becomes a Square customer (name,
--                           email, phone, reference_id = bidder id) and is
--                           added to the "BinGo Auction Bidders" customer
--                           group — targetable from Square Marketing next
--                           to the in-store directory.
--   square_loyalty_enabled  paid invoices with a square_payment_id
--                           accumulate points in the account's MAIN Square
--                           Loyalty program (Square's own earn rules apply;
--                           accounts are keyed by phone, so phone-less
--                           bidders are skipped).
--
-- Both default OFF; toggled from the console /marketing page. The hourly
-- square-sync cron (lib/cron/square-sync.ts) does the work incrementally:
--   bidders.square_synced_at    stamped once the directory record is
--                               complete + grouped (re-set to NULL to force
--                               a re-sync of a bidder)
--   invoices.loyalty_accrued_at stamped once points accumulated — the
--                               exactly-once guard for loyalty
--   platform_settings.square_group_id  caches the created group's id

BEGIN;

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS square_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS square_loyalty_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS square_group_id TEXT;

ALTER TABLE public.bidders
  ADD COLUMN IF NOT EXISTS square_synced_at TIMESTAMPTZ;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS loyalty_accrued_at TIMESTAMPTZ;

COMMIT;
