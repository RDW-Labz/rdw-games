-- 0375 — client_crash_reports.report_id: a resent report is stored once.
--
-- The apps queue a crash report and resend it until the server answers 2xx
-- (bidder telemetry-outbox, staff #373). When the server stored the row but
-- the reply was lost (the app's fetch timed out first), the next flush sent it
-- again and it was stored twice: the #373 staff-canary rehearsal
-- (run 36056141367) produced 2 duplicates out of about 8 reports. Duplicates
-- also trip the health check's crash-spike alerts falsely.
--
-- The app now generates one id per queued report and sends it on every
-- attempt; /api/telemetry/crash inserts with ON CONFLICT (report_id) DO
-- NOTHING. Older app builds send no id: report_id stays NULL, and a UNIQUE
-- index allows any number of NULLs, so they behave exactly as before.
--
-- Size on prod 2026-09-28: 851 rows, 472 kB, ~70 inserts a day, one writer
-- (the crash route). ADD COLUMN without a default is metadata-only; the index
-- builds in milliseconds.
--
-- Rollback: DROP INDEX client_crash_reports_report_id_key;
--           ALTER TABLE client_crash_reports DROP COLUMN report_id;
-- (deploy the previous route first, or it would send report_id to a missing column)

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.client_crash_reports ADD COLUMN IF NOT EXISTS report_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS client_crash_reports_report_id_key
  ON public.client_crash_reports (report_id);

COMMENT ON COLUMN public.client_crash_reports.report_id IS
  '0375: app-generated id, the same on every resend of one queued report; '
  'the crash route ignores a second insert with the same id. NULL from app '
  'builds that predate it.';
