-- 0223 — signup_failures: operator-visible record of failed signup attempts
--
-- 2026-07-04: a customer screenshot showed "email rate limit exceeded" on the
-- web signup form during the Facebook launch push (38 signups in 2 hours).
-- Failed signups leave NO trace anywhere — Supabase refuses the request
-- before creating an auth.users row, so the operator can't see how many
-- customers bounced or who they were. Owner: "I want to be able to see these
-- reports also."
--
-- Client signup forms (web + bidder app) now POST failures to
-- /api/telemetry/signup-failure, which inserts here via service role. The
-- console Bidders page lists recent rows so the operator can follow up
-- (the attempted email is captured exactly so they can reach the customer).
--
-- RLS: operator staff read; no INSERT/UPDATE/DELETE policies — writes go
-- through service role only, so an anonymous client can't spoof or scrape.
--
-- Idempotent: IF NOT EXISTS everywhere; policy recreated via DROP+CREATE.

BEGIN;

CREATE TABLE IF NOT EXISTS public.signup_failures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  email       text,
  message     text NOT NULL,
  source      text NOT NULL DEFAULT 'web',   -- 'web' | 'bidder-app'
  user_agent  text
);

CREATE INDEX IF NOT EXISTS signup_failures_created_at_idx
  ON public.signup_failures (created_at DESC);

ALTER TABLE public.signup_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS signup_failures_operator_read ON public.signup_failures;
CREATE POLICY signup_failures_operator_read
  ON public.signup_failures
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.operator_users ou WHERE ou.user_id = auth.uid()
    )
  );

GRANT SELECT ON public.signup_failures TO authenticated;

COMMIT;
