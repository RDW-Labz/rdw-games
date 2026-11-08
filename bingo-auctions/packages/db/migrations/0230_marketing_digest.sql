-- 0230 — marketing digest (dashboard-controlled, gently automated)
--
-- Owner, 2026-07-05: "i dont want it nightly, maybe something we control on
-- dashboard and we can automate something less aggressive than nightly."
--
-- Shape:
--   • Console /marketing page: preview + "Send digest now" + auto toggle.
--   • Auto mode (platform_settings.digest_auto_enabled, default OFF): the
--     daily cron only sends when an auction actually closes within 24h AND
--     the last digest is >72h old — content-driven, max ~2/week, never a
--     bare "nothing is happening" email.
--   • Recipients: bidders.marketing_emails_enabled (default TRUE — existing
--     bidders are customers; every digest carries a one-click unsubscribe
--     that flips this to FALSE without touching transactional email).
--   • Delivery rides the notifications_outbox → email-drain pipeline
--     (kind 'marketing_digest'; push drain explicitly skips it — email only).
--   • marketing_digest_sends is the audit log + the 72h rate-limit source.
--
-- No BEGIN/COMMIT (ALTER TYPE ... ADD VALUE, mig-0167 pattern). Idempotent.

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'marketing_digest';

ALTER TABLE public.bidders
  ADD COLUMN IF NOT EXISTS marketing_emails_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS digest_auto_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.marketing_digest_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sent_by TEXT NOT NULL CHECK (sent_by IN ('manual', 'auto')),
  recipient_count INT NOT NULL,
  lot_count INT NOT NULL,
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS with no policies: service-role only (console reads via server code,
-- cron writes via server code) — same stance as platform_settings.
ALTER TABLE public.marketing_digest_sends ENABLE ROW LEVEL SECURITY;
