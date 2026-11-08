-- ============================================================================
-- Saved searches.
--
-- A bidder saves a search (text + optional category + optional operator
-- + optional discount filter), and the auction-engine matches new lots
-- against it on a schedule. When a freshly-listed lot matches, the
-- bidder gets a push notification and the lot ends up surfaced in
-- their app's Saved-Searches view.
--
-- Schema choices:
--   - One row per saved search per bidder, no nesting/sharing.
--   - JSONB for the criteria (q, category_id, operator_id, min_discount_pct).
--     Future criteria additions don't need migrations — the matcher
--     just reads new keys, defaults sensibly when missing.
--   - last_matched_at lets the worker only consider lots created
--     since the last successful run, avoiding re-pushing the same
--     lot when nothing changed.
--
-- Indexes:
--   - (bidder_id, created_at) for the bidder's "my saved searches" list.
--   - (last_matched_at) so the matcher can pick the stalest searches
--     first if it ever needs to throttle.
-- ============================================================================

CREATE TABLE IF NOT EXISTS saved_searches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bidder_id       UUID NOT NULL REFERENCES bidders(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  criteria        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Notification toggle — bidders who want to keep a search in their
  -- list but stop pings can flip this without deleting the search.
  notify          BOOLEAN NOT NULL DEFAULT true,
  last_matched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_searches_bidder_idx
  ON saved_searches (bidder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS saved_searches_matcher_idx
  ON saved_searches (last_matched_at NULLS FIRST);

-- ----------------------------------------------------------------------------
-- RLS — bidders manage their own searches. No staff read.
-- ----------------------------------------------------------------------------

ALTER TABLE saved_searches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS saved_searches_self_all ON saved_searches;
CREATE POLICY saved_searches_self_all ON saved_searches
  FOR ALL USING (bidder_id = auth.uid())
  WITH CHECK (bidder_id = auth.uid());

-- ----------------------------------------------------------------------------
-- Notification kind for saved-search hits. notifications_outbox.kind
-- is the notification_kind enum; we need to extend it before workers
-- can route the new event type.
--
-- ALTER TYPE ... ADD VALUE is non-transactional in older Postgres, so
-- IF NOT EXISTS is the safe form. Postgres 12+ supports this.
-- ----------------------------------------------------------------------------

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'saved_search_hit';
