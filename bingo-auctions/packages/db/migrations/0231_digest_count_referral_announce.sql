-- 0231 — digest lot-count setting + referral announcement kind
--
-- Owner, 2026-07-05: (1) "custom number of items view button" — the digest's
-- featured-lot count becomes a dashboard setting instead of a hardcoded 12;
-- (2) existing bidders were never told about Give $5/get $5 — a one-time
-- announcement email (per-bidder personal code in the body) sent from the
-- /marketing page. Outbox idempotency key 'refannounce:{bidder_id}' is
-- once-per-bidder-EVER, so re-pressing the button later only reaches
-- bidders who never got it (i.e. new signups).
--
-- No BEGIN/COMMIT (ALTER TYPE ... ADD VALUE, mig-0167 pattern). Idempotent.

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'referral_announcement';

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS digest_lot_count INT NOT NULL DEFAULT 12;

-- Sanity bounds: an email with 100 images is a spam-filter magnet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_settings_digest_lot_count_bounds'
  ) THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_digest_lot_count_bounds
      CHECK (digest_lot_count BETWEEN 1 AND 24);
  END IF;
END $$;
