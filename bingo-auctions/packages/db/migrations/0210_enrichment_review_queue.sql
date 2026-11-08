-- ============================================================================
-- 0210 — enrichment_review_queue: a persistent home for low-confidence
-- enrichments a lister should eyeball.
--
-- Today a shaky scan either silently creates a thin lot or relies on the 2s
-- confirm card the operator may blow past. This table captures the
-- low-confidence cases so they land in one queue a lister clears — and the
-- correction writes back to product_lookups (the self-learning loop), so the
-- same item resolves cleanly next time. (asset_inventory "review queue"
-- pattern.)
--
-- Additive + opt-in: nothing enqueues until a code path calls the enqueue
-- helper. Operator-scoped via the standard current_operator_id() RLS helpers.
-- ============================================================================

CREATE TABLE IF NOT EXISTS enrichment_review_queue (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id   UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  -- Nullable: an item can be queued before a lot exists (e.g. a hollow scrape).
  lot_id        UUID REFERENCES lots(id) ON DELETE SET NULL,
  reason        TEXT NOT NULL,                       -- 'low_confidence' | 'no_match' | 'hollow_scrape' | ...
  confidence    INT CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100)),
  input_kind    TEXT,                                -- 'photo' | 'upc' | 'url' | 'keyword'
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- the candidate/record needing review
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'resolved', 'dismissed')),
  resolved_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at   TIMESTAMPTZ,
  resolution    JSONB,                               -- the corrected record the lister confirmed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pool view: a per-operator list of pending items, newest first.
CREATE INDEX IF NOT EXISTS enrichment_review_queue_pool_idx
  ON enrichment_review_queue (operator_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS enrichment_review_queue_lot_idx
  ON enrichment_review_queue (lot_id)
  WHERE lot_id IS NOT NULL;

ALTER TABLE enrichment_review_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS erq_staff_read ON enrichment_review_queue;
DROP POLICY IF EXISTS erq_staff_insert ON enrichment_review_queue;
DROP POLICY IF EXISTS erq_staff_update ON enrichment_review_queue;

-- Any member of the operator can see + clear their operator's queue. (Service
-- role bypasses RLS for the server resolve route that also writes the catalog.)
CREATE POLICY erq_staff_read ON enrichment_review_queue
  FOR SELECT
  USING (operator_id = current_operator_id());

CREATE POLICY erq_staff_insert ON enrichment_review_queue
  FOR INSERT
  WITH CHECK (operator_id = current_operator_id());

CREATE POLICY erq_staff_update ON enrichment_review_queue
  FOR UPDATE
  USING (operator_id = current_operator_id())
  WITH CHECK (operator_id = current_operator_id());
