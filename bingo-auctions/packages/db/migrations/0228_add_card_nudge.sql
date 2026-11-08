-- 0228 — add-card nudge (funnel repair)
--
-- Owner, 2026-07-05 (marketing batch): bidders who register but never put a
-- card on file can't bid. One automated "you're one step from bidding"
-- email/push, sent once per bidder, ~24h after signup. The add-card-nudge
-- cron (lib/cron/add-card-nudge.ts, hourly) claims candidates by stamping
-- bidders.card_nudged_at, then enqueues a notifications_outbox row with
-- idempotency_key 'card_nudge:{bidder_id}' — double protection against
-- re-sends (claim column + UNIQUE outbox key).
--
-- NO BEGIN/COMMIT: ALTER TYPE ... ADD VALUE must not run inside an explicit
-- transaction that also uses the value; keeping the file transaction-free
-- follows mig 0167's pattern. Both statements are idempotent.

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'add_card_nudge';

ALTER TABLE public.bidders
  ADD COLUMN IF NOT EXISTS card_nudged_at TIMESTAMPTZ;
