-- ============================================================================
-- Migration 0082: bidder age verification
--
-- Adds birth_date to bidders. Existing rows are grandfathered (NULL allowed).
-- New rows created after 2026-05-16 must supply birth_date and the bidder
-- must be >= 18 years old at the time of INSERT (server-side trigger).
--
-- Defense-in-depth note: pgcrypto encrypt-at-rest is deferred to v2.
-- Column is operator-private via RLS — only the owning bidder + service-role
-- can read it.
-- ============================================================================

ALTER TABLE bidders
  ADD COLUMN IF NOT EXISTS birth_date DATE;

-- ---------------------------------------------------------------------------
-- Partial CHECK: new rows (created_at > grandfathering cutoff) must have
-- birth_date set. Uses a generated column expression via CHECK constraint
-- scoped to post-cutoff inserts.
--
-- PostgreSQL doesn't allow created_at in a CHECK referencing "new rows only"
-- without a trigger, so we implement this as a trigger instead.
-- The column remains nullable at the DDL level; the trigger is the enforcer.
-- ---------------------------------------------------------------------------

-- RLS update: bidder can SELECT their own birth_date; service-role sees all.
-- (The existing bidders RLS policies allow bidder to SELECT own row — the
--  birth_date column inherits that without a separate policy.)

-- ---------------------------------------------------------------------------
-- Trigger: enforce birth_date required + age >= 18 on new bidder INSERTs
-- that post-date the grandfathering cutoff.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_bidder_age()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Grandfathering: only enforce for rows created on or after 2026-05-16.
  -- Rows inserted during this migration or before are exempt.
  IF NEW.created_at IS NOT NULL AND NEW.created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00' THEN
    RETURN NEW;
  END IF;

  -- Require birth_date for new signups.
  IF NEW.birth_date IS NULL THEN
    RAISE EXCEPTION 'birth_date is required for new bidder signups';
  END IF;

  -- Enforce minimum age of 18 years.
  IF age(NEW.birth_date) < INTERVAL '18 years' THEN
    RAISE EXCEPTION 'bidder must be at least 18 years old (birth_date: %)', NEW.birth_date;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_bidder_age ON bidders;

CREATE TRIGGER trg_enforce_bidder_age
  BEFORE INSERT ON bidders
  FOR EACH ROW
  EXECUTE FUNCTION enforce_bidder_age();

-- ---------------------------------------------------------------------------
-- Index: useful for age-based reports / compliance queries
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS bidders_birth_date_idx ON bidders (birth_date);
