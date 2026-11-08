-- Production traffic by hour of day, Central time, split weekday vs weekend.
--
-- Exists because WORKING_AGREEMENT §7b and CLAUDE.md Rule 9 name a deploy
-- window, and that window should be answerable from data rather than from
-- intuition about warehouse hours. The rule it replaced said "after the
-- warehouse closes at 6:00 PM Central" — which turned out to be the single
-- busiest customer hour of the day: every auction close and 96% of payments
-- fall between 18:00 and 21:59 Central.
--
-- Run it read-only, no credentials needed locally:
--
--   gh workflow run apply-migration.yml -f mode=query \
--     -f sql="$(sed -n '/^WITH/,$p' scripts/traffic-by-hour.sql)"
--   gh run list --workflow=apply-migration.yml --limit 1
--   gh run view <id> --log
--
-- The sed is not decoration. mode=query guards on /^\s*(select|with)/i, so a
-- leading comment block is rejected outright — `cat` this file straight in and
-- the run fails with "mode=query only accepts SELECT/WITH statements".
--
-- Output: one row per (hour_ct, daytype), with `ndays` so the counts can be
-- turned into per-day averages — the 14-day window holds ~10 weekdays and
-- ~4 weekend days, so raw totals are not comparable between the two.
--
-- Columns:
--   bids        human bids only (is_auto = false). Proxy raises are excluded
--               because they are triggered by somebody else's action, and the
--               question here is when PEOPLE are on the site.
--   closes      lots whose close_at has actually passed. The worst moment for
--               a deploy: a close is irreversible and cannot be retried.
--   inv_created / inv_paid
--               checkout. Both track the closes, an hour behind.
--   staff       floor work — lots created (lotting) + human location events
--               (put-away, actor_id NOT NULL excludes cron writes) + completed
--               pickups (the counter). NOT operator_audit_log, which is mostly
--               service_role and RPC writes and says little about the floor.
--
-- Re-derive before trusting numbers more than a few months old: the auction
-- schedule sets the customer peak, and the schedule can change.

WITH hours AS (SELECT generate_series(0,23) AS hr),
span AS (SELECT generate_series((now() AT TIME ZONE 'America/Chicago')::date - 13, (now() AT TIME ZONE 'America/Chicago')::date, interval '1 day')::date AS d),
daycount AS (SELECT CASE WHEN EXTRACT(ISODOW FROM d) >= 6 THEN 'weekend' ELSE 'weekday' END AS daytype, COUNT(*)::int AS ndays FROM span GROUP BY 1),
ev AS (
 SELECT 'bid' AS metric, EXTRACT(HOUR FROM (placed_at AT TIME ZONE 'America/Chicago'))::int AS hr, CASE WHEN EXTRACT(ISODOW FROM (placed_at AT TIME ZONE 'America/Chicago'))>=6 THEN 'weekend' ELSE 'weekday' END AS daytype FROM public.bids WHERE placed_at >= now() - interval '14 days' AND is_auto=false
 UNION ALL SELECT 'close', EXTRACT(HOUR FROM (close_at AT TIME ZONE 'America/Chicago'))::int, CASE WHEN EXTRACT(ISODOW FROM (close_at AT TIME ZONE 'America/Chicago'))>=6 THEN 'weekend' ELSE 'weekday' END FROM public.lots WHERE close_at >= now() - interval '14 days' AND close_at < now()
 UNION ALL SELECT 'paid', EXTRACT(HOUR FROM (paid_at AT TIME ZONE 'America/Chicago'))::int, CASE WHEN EXTRACT(ISODOW FROM (paid_at AT TIME ZONE 'America/Chicago'))>=6 THEN 'weekend' ELSE 'weekday' END FROM public.invoices WHERE paid_at >= now() - interval '14 days'
 UNION ALL SELECT 'created', EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/Chicago'))::int, CASE WHEN EXTRACT(ISODOW FROM (created_at AT TIME ZONE 'America/Chicago'))>=6 THEN 'weekend' ELSE 'weekday' END FROM public.invoices WHERE created_at >= now() - interval '14 days'
 UNION ALL SELECT 'staff', EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/Chicago'))::int, CASE WHEN EXTRACT(ISODOW FROM (created_at AT TIME ZONE 'America/Chicago'))>=6 THEN 'weekend' ELSE 'weekday' END FROM public.lots WHERE created_at >= now() - interval '14 days'
 UNION ALL SELECT 'staff', EXTRACT(HOUR FROM (occurred_at AT TIME ZONE 'America/Chicago'))::int, CASE WHEN EXTRACT(ISODOW FROM (occurred_at AT TIME ZONE 'America/Chicago'))>=6 THEN 'weekend' ELSE 'weekday' END FROM public.lot_location_events WHERE occurred_at >= now() - interval '14 days' AND actor_id IS NOT NULL
 UNION ALL SELECT 'staff', EXTRACT(HOUR FROM (completed_at AT TIME ZONE 'America/Chicago'))::int, CASE WHEN EXTRACT(ISODOW FROM (completed_at AT TIME ZONE 'America/Chicago'))>=6 THEN 'weekend' ELSE 'weekday' END FROM public.pickups WHERE completed_at >= now() - interval '14 days'
),
agg AS (SELECT hr, daytype, metric, COUNT(*)::int AS n FROM ev GROUP BY 1,2,3)
SELECT h.hr AS hour_ct, dc.daytype, dc.ndays,
 COALESCE(MAX(CASE WHEN a.metric='bid' THEN a.n END),0) AS bids,
 COALESCE(MAX(CASE WHEN a.metric='close' THEN a.n END),0) AS closes,
 COALESCE(MAX(CASE WHEN a.metric='created' THEN a.n END),0) AS inv_created,
 COALESCE(MAX(CASE WHEN a.metric='paid' THEN a.n END),0) AS inv_paid,
 COALESCE(MAX(CASE WHEN a.metric='staff' THEN a.n END),0) AS staff
FROM hours h
CROSS JOIN daycount dc
LEFT JOIN agg a ON a.hr=h.hr AND a.daytype=dc.daytype
GROUP BY h.hr, dc.daytype, dc.ndays
ORDER BY dc.daytype, h.hr

