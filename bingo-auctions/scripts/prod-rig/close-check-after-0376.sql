SELECT now() AS checked_at,
 (SELECT count(*) FROM lots WHERE status = 'live' AND close_at < now() - interval '2 minutes') AS stuck_live,
 (SELECT count(*) FROM lots WHERE closed_at > '2026-09-29 15:05:00+00' AND status = 'won') AS won_since_0376,
 (SELECT count(*) FROM lots WHERE closed_at > '2026-09-29 15:05:00+00' AND status = 'unsold') AS unsold_since_0376,
 (SELECT count(*) FROM lots WHERE closed_at > '2026-09-29 15:05:00+00' AND status = 'won' AND winner_bidder_id IS NULL) AS won_without_winner,
 (SELECT count(*) FROM notifications_outbox WHERE kind = 'won' AND created_at > '2026-09-29 15:05:00+00') AS won_notices,
 (SELECT count(*) FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid WHERE j.jobname IN ('finalize-due-lots','drain-build-invoice-jobs') AND d.start_time > '2026-09-29 15:05:00+00' AND d.status <> 'succeeded') AS job_failures,
 (SELECT count(*) FROM invoices WHERE created_at > '2026-09-29 15:05:00+00') AS invoices_built
