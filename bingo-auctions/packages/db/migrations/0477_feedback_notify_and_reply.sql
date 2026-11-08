-- 0477 — feedback: notify Braden + Jared, daily digest, emailed replies
--
-- Why (owner 2026-10-30): staff and customers send feedback (app_feedback,
-- 0317/0325/0327), it lands in the console's /feedback, and nobody is told.
-- 41 items sat in 'new' with nobody answering.
--
-- What (no change to existing columns or rows' content):
--   app_feedback.notified_at       when the "new feedback" email went out
--                                  (NULL = not yet). Existing rows are marked
--                                  as already notified, so turning this on
--                                  does not mail 60 old items at once; the
--                                  daily digest lists the ones still 'new'.
--   app_feedback.reply_emailed_at  when the console emailed the reply to a
--                                  customer (audit row in operator_audit_log).
--   feedback_digest_runs           one row per Chicago day the 07:00 digest
--                                  went out, so an hourly cron sends it once.
--                                  Service role only (RLS on, no policies).
--
-- Locks: ADD COLUMN (nullable, no default) on app_feedback — a small table
-- the floor writes rarely — plus a one-time UPDATE of its ~60 rows. Nothing
-- on lots, bids or invoices. Any hour outside 18:00–22:00.
-- Safe to re-run: IF NOT EXISTS everywhere; the backfill only touches rows
-- still NULL that existed before this migration's first run.
-- Rollback: scripts/prod-rig/0477_ROLLBACK_feedback_notify_and_reply.sql

BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.app_feedback
  ADD COLUMN IF NOT EXISTS notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_emailed_at timestamptz;

COMMENT ON COLUMN public.app_feedback.notified_at IS
  '0477: when the new-feedback email to the owners went out; NULL = pending.';
COMMENT ON COLUMN public.app_feedback.reply_emailed_at IS
  '0477: when the console emailed the triage reply to the customer.';

-- Old items are not "new arrivals"; the digest covers the ones still open.
-- Only on the first run: once any row has notified_at set by the cron, a
-- re-run leaves fresh pending rows alone.
UPDATE public.app_feedback
   SET notified_at = created_at
 WHERE notified_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.app_feedback f2 WHERE f2.notified_at IS NOT NULL AND f2.notified_at <> f2.created_at);

CREATE INDEX IF NOT EXISTS app_feedback_pending_notify_idx
  ON public.app_feedback (created_at)
  WHERE notified_at IS NULL;

CREATE TABLE IF NOT EXISTS public.feedback_digest_runs (
  day     date PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now(),
  items   integer NOT NULL DEFAULT 0
);
COMMENT ON TABLE public.feedback_digest_runs IS
  '0477: one row per America/Chicago day the 07:00 feedback digest was sent.';
ALTER TABLE public.feedback_digest_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.feedback_digest_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.feedback_digest_runs TO service_role;

COMMIT;
