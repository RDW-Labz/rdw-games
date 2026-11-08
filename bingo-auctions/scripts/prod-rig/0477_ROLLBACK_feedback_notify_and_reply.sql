-- ROLLBACK for 0477: remove the feedback notify/reply columns and the digest log.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP TABLE IF EXISTS public.feedback_digest_runs;
DROP INDEX IF EXISTS public.app_feedback_pending_notify_idx;
ALTER TABLE public.app_feedback
  DROP COLUMN IF EXISTS reply_emailed_at,
  DROP COLUMN IF EXISTS notified_at;
COMMIT;
