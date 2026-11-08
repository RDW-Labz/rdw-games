-- migration 0134 — stripe_requirements_due column on operators
--
-- STRIPE-P1-3 (2026-05-24 audit): when a Connect account.updated event
-- carries requirements.currently_due, we persist the array so the
-- operator console can surface a warning banner on the /payouts page.
-- Without this, operators have no in-app signal that "Stripe needs your
-- EIN by Friday" and payouts silently pause.
--
-- Column: stripe_requirements_due jsonb  (nullable)
--   - NULL   → no pending requirements (normal operating state)
--   - []     → empty array (requirements cleared; webhook sets NULL instead)
--   - [...]  → array of requirement strings from Stripe, e.g.
--              ["individual.id_number", "tos_acceptance.date"]
--
-- Index: GIN index on the column so we can efficiently query for all
-- operators with non-null requirements (admin tooling / health checks).
-- GIN on jsonb is cheap when the column is sparse (mostly NULL rows).
--
-- Idempotent: every statement uses IF NOT EXISTS / IF EXISTS guards.
-- Safe to re-run against a DB that already has the column.

BEGIN;

ALTER TABLE public.operators
  ADD COLUMN IF NOT EXISTS stripe_requirements_due jsonb;

CREATE INDEX IF NOT EXISTS operators_stripe_requirements_due_gin_idx
  ON public.operators
  USING gin (stripe_requirements_due)
  WHERE stripe_requirements_due IS NOT NULL;

COMMENT ON COLUMN public.operators.stripe_requirements_due IS
  'Snapshot of account.requirements.currently_due from the most recent '
  'account.updated webhook. NULL = no pending requirements. Set by the '
  'webhook handler; rendered as a warning banner on /payouts. '
  'See migration 0134 and STRIPE-P1-3 in the 2026-05-24 audit.';

COMMIT;
