-- Rollback for 0424_app_versions.sql — standby only.
-- Drops the two tables and the ping RPC. Nothing else references them (part a
-- ships no app or console code), so this loses only the ping history and the
-- app_versions rows. No locks on lots / bids / invoices.

BEGIN;

DROP FUNCTION IF EXISTS public.record_app_version_ping(text, text, text, text, text, text, text);
DROP TABLE IF EXISTS public.app_version_pings;
DROP TABLE IF EXISTS public.app_versions;

COMMIT;
