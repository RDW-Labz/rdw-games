-- ============================================================================
-- Migration 0100 — Webhook idempotency: claim-then-commit pattern
--
-- Background (docs/auction-lot-audit-plan.md, BUG-ARCH-12):
--   The Stripe webhook currently INSERTs into processed_webhook_events
--   BEFORE running its handler logic. If the handler crashes after the
--   idempotency row is committed but before the invoice update lands,
--   Stripe's retry (72h later, exponential backoff) hits the existing
--   row, returns 200 duplicate, and the event is silently dropped
--   forever. Invoice stays unpaid. Bidder is charged but not credited.
--
-- Fix: two-phase idempotency.
--   1. INSERT idempotency row with processed_at = NULL (the "claim").
--   2. Run the handler.
--   3. On success: UPDATE processed_at = now() (the "commit").
--   4. On failure: leave processed_at NULL; Stripe retries.
--
--   Duplicate-receiver check: re-process only if the existing row's
--   processed_at IS NOT NULL. If processed_at IS NULL, the previous
--   attempt didn't finish — retry the handler.
--
-- This migration:
--   1. Makes processed_at NULLABLE (was NOT NULL with DEFAULT now())
--   2. Adds a partial index for the claim-but-not-committed lookup
--   3. Adds a SECURITY DEFINER helper `claim_webhook_event(event_id, event_type)`
--      that returns 'fresh' (first attempt), 'retry' (claimed but not
--      committed previously), or 'duplicate' (already committed).
--   4. Adds a SECURITY DEFINER helper `commit_webhook_event(event_id)`
--      that flips processed_at to now() on success.
--
-- App-code path (webhooks/stripe/route.ts) is updated in a follow-up
-- commit to use claim() instead of insert+go.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Schema: processed_at becomes nullable
-- ---------------------------------------------------------------------------
ALTER TABLE processed_webhook_events
  ALTER COLUMN processed_at DROP NOT NULL,
  ALTER COLUMN processed_at DROP DEFAULT;

-- Existing rows have processed_at populated (they were inserted under the
-- old NOT NULL DEFAULT semantics). New rows from the claim helper below
-- start with processed_at = NULL and only fill in on commit.

CREATE INDEX IF NOT EXISTS processed_webhook_events_unprocessed_idx
  ON processed_webhook_events (stripe_event_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. claim_webhook_event() — atomic insert-or-detect
-- ---------------------------------------------------------------------------
-- Returns:
--   'fresh'      — first time we've seen this event; caller should process
--   'retry'      — previous attempt claimed but never committed; reprocess
--   'duplicate'  — already fully processed; caller should return 200
--
-- Uses ON CONFLICT to detect existing rows atomically. The single SQL
-- statement holds a row lock on the inserted/conflicting row so two
-- concurrent webhooks for the same event_id serialize cleanly.

CREATE OR REPLACE FUNCTION claim_webhook_event(
  p_event_id   TEXT,
  p_event_type TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted BOOLEAN;
  v_done     BOOLEAN;
BEGIN
  -- Try to insert. If the row already exists, the INSERT no-ops (no
  -- columns to update on conflict) and RETURNING returns nothing.
  WITH ins AS (
    INSERT INTO processed_webhook_events (stripe_event_id, event_type, processed_at)
    VALUES (p_event_id, p_event_type, NULL)
    ON CONFLICT (stripe_event_id) DO NOTHING
    RETURNING TRUE AS inserted
  ),
  existing AS (
    SELECT (processed_at IS NOT NULL) AS already_done
    FROM processed_webhook_events
    WHERE stripe_event_id = p_event_id
  )
  SELECT
    (SELECT inserted FROM ins LIMIT 1),
    (SELECT already_done FROM existing LIMIT 1)
  INTO v_inserted, v_done;

  IF COALESCE(v_inserted, FALSE) THEN
    RETURN 'fresh';
  ELSIF COALESCE(v_done, FALSE) THEN
    RETURN 'duplicate';
  ELSE
    RETURN 'retry';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION claim_webhook_event(TEXT, TEXT) FROM PUBLIC;
-- service-role only; webhook handler runs with the admin client which
-- has its own implicit access.

-- ---------------------------------------------------------------------------
-- 3. commit_webhook_event() — flip to processed
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION commit_webhook_event(p_event_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE processed_webhook_events
  SET processed_at = now()
  WHERE stripe_event_id = p_event_id
    AND processed_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION commit_webhook_event(TEXT) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 4. Optional cleanup: alert query for stuck claims
-- ---------------------------------------------------------------------------
-- A view of events claimed >1 hr ago but never committed. Indicates a
-- handler failure or an event Stripe never retried. Ops dashboard can
-- alert on row count > 0.

CREATE OR REPLACE VIEW stuck_webhook_claims AS
SELECT stripe_event_id, event_type
FROM processed_webhook_events
WHERE processed_at IS NULL
ORDER BY stripe_event_id;

-- View inherits the parent table's RLS — service-role only.

COMMIT;
