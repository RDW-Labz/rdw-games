-- ============================================================================
-- Migration 0179 — default lots.close_at on auction attach (L4 guard)
--
-- ── The gap (L4) ────────────────────────────────────────────────────────────
-- A lot can be inserted (or updated) with auction_id SET but close_at = NULL.
-- The demo seed (scripts/seed-app-reviewer-fixtures.mjs) does exactly this, and
-- nothing in the schema prevents an operator/import path from doing the same.
-- The auction-open path open_due_lots gates on `close_at > now()`, so a lot
-- with NULL close_at is invisible to it: the lot never opens, the auction never
-- progresses to live/closed, and bidders can't bid. Silent and hard to spot.
--
-- ── Why a trigger, NOT a CHECK constraint ───────────────────────────────────
-- A plain  ALTER TABLE lots ADD CONSTRAINT ... CHECK (...)  is validated
-- against EXISTING rows at apply time. Production already has lots with
-- auction_id set and close_at NULL (the demo seed, and possibly others), so a
-- hard CHECK would FAIL the migration on apply. Per the red-team requirement we
-- DEFAULT the value instead of REJECTING the row: a BEFORE INSERT OR UPDATE
-- trigger that, when a lot is attached to an auction but has no close_at, fills
-- it from the parent auction's ends_at (auctions.ends_at is NOT NULL). This:
--   • survives apply against existing NULL rows (no validation pass, no failure),
--   • repairs the bad shape going forward instead of blocking writes, and
--   • is idempotent / harmless when close_at is already set (left untouched).
--
-- It is purely a fail-soft DEFAULT — it never overrides an explicitly provided
-- close_at, and it does nothing for unattached lots (auction_id IS NULL), which
-- legitimately have no close_at until they're assigned to an auction.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION lots_default_close_at_on_attach()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act when the lot is attached to an auction but has no close_at.
  -- Pull the parent auction's ends_at (NOT NULL on auctions) as the default.
  -- If for some reason the auction row can't be found, ends_at resolves to
  -- NULL and we leave close_at as-is (no worse than today).
  IF NEW.auction_id IS NOT NULL AND NEW.close_at IS NULL THEN
    SELECT a.ends_at
      INTO NEW.close_at
      FROM auctions a
     WHERE a.id = NEW.auction_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lots_default_close_at_on_attach ON lots;
CREATE TRIGGER lots_default_close_at_on_attach
  BEFORE INSERT OR UPDATE ON lots
  FOR EACH ROW
  EXECUTE FUNCTION lots_default_close_at_on_attach();

COMMENT ON FUNCTION lots_default_close_at_on_attach() IS
  'L4 guard (mig 0179): when a lot is attached to an auction (auction_id set) '
  'but close_at is NULL, default close_at to the parent auction''s ends_at so '
  'the lot is visible to open_due_lots and the auction can open/close. A '
  'trigger (not a CHECK) so it DEFAULTS the value and survives apply against '
  'existing NULL rows instead of rejecting them. Never overrides an explicit '
  'close_at; no-op for unattached lots.';

COMMIT;
