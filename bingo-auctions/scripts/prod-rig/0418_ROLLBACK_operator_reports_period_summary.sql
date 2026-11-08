-- Rollback for 0418_operator_reports_period_summary.sql — standby only.
-- Drops the /reports totals function. Roll back the operator-web deploy that
-- calls it FIRST (or together): without the function /reports shows an error
-- banner instead of totals. Read-only function, no data to restore.

DROP FUNCTION IF EXISTS public.operator_reports_period_summary(TIMESTAMPTZ, TIMESTAMPTZ);
