-- pg_cron schedules for the SQL functions defined in 0072.
--
-- The idiom for idempotent schedule re-applies is unschedule-then-schedule.
-- cron.unschedule(jobid) returns boolean and is harmless if no matching
-- job exists (the FROM clause filters first).
--
-- Cadence rationale:
--   finalize-due-lots          5s   close-at precision -- bidders watch the clock
--   drain-build-invoice-jobs   30s  matches the prior BullMQ debounce window
--   mark-settlements-releasable 60s  matches the prior settlements worker tick
--   cron-history-cleanup        hourly  cron.job_run_details grows ~17k rows/day at 5s

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN (
  'finalize-due-lots',
  'drain-build-invoice-jobs',
  'mark-settlements-releasable',
  'cron-history-cleanup'
);

SELECT cron.schedule(
  'finalize-due-lots',
  '5 seconds',
  $$SELECT public.finalize_due_lots()$$
);

SELECT cron.schedule(
  'drain-build-invoice-jobs',
  '30 seconds',
  $$SELECT public.drain_build_invoice_jobs()$$
);

SELECT cron.schedule(
  'mark-settlements-releasable',
  '* * * * *',
  $$SELECT public.mark_settlements_releasable()$$
);

-- Keep cron.job_run_details bounded. At a 5-second cadence on a single job
-- we accumulate ~17280 rows/day. Cap retention at 7 days to keep the table
-- a manageable size.
SELECT cron.schedule(
  'cron-history-cleanup',
  '0 * * * *',
  $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'$$
);
