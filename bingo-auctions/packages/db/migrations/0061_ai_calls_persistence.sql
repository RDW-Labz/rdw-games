-- ============================================================================
-- 0061_ai_calls_persistence
--
-- Persist every AI / LLM call so we can answer "how much did this
-- operator burn on AI last week?" without scrolling OpenRouter's
-- dashboard. Until this migration, cost tracking lived only in an
-- in-memory ring buffer in the mobile app (CostHud) — data died with
-- the JS context, no per-operator aggregation possible, no way to
-- alert on cost anomalies.
--
-- Architecture:
--   • Single table `ai_calls` written by every /api/lottr/* route
--     (scan-photo, identify-photo, shelf-scan, lookup-code) via the
--     server-side admin client. Operator-scoped via operator_id.
--   • Cheap: ~50-200 bytes per row; an operator scanning 1000 lots/
--     day writes ~1-3MB/day at most.
--   • Optional `cached` flag tracks UPC cache hits where no AI call
--     fired — useful for cost-per-bin / cost-per-truck math.
--   • The `task` value mirrors LlmTask in domain-lotting/src/ai/llm.ts.
--   • `cost_cents` not USD floats — keeps aggregation arithmetic safe.
--
-- Reporting paths this unblocks:
--   • "AI cost this month per operator" — dashboard tile
--   • "Cost per lotted item per source" — per-truck profitability
--   • Sentry alert on >$5/hour burn rate
--   • Hybrid pricing model (subscription + % GMV + AI passthrough)
--     can now actually invoice for real AI usage
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_calls (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id     UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Mirrors LlmTask enum in packages/domain-lotting/src/ai/llm.ts.
  -- Free-form so we don't need a migration every time a new task is
  -- added. Operator-facing aggregations group by this string.
  task            TEXT NOT NULL,

  -- Model that actually fired (after any escalation). Free-form text
  -- because OpenRouter model names evolve and we don't want a
  -- migration for each new tier.
  model           TEXT,

  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,

  -- Cost in cents (BIGINT for safety). One Sonnet call rarely exceeds
  -- a couple dollars; BIGINT capacity is overkill but matches the
  -- platform's other money columns (msrp_cents, current_bid_cents).
  cost_cents     BIGINT NOT NULL DEFAULT 0
    CHECK (cost_cents >= 0),

  latency_ms     INTEGER NOT NULL DEFAULT 0
    CHECK (latency_ms >= 0),

  -- Did this call actually hit the AI, or was it a cache hit? Lets us
  -- report effective cache-hit rate per operator.
  cached         BOOLEAN NOT NULL DEFAULT false,

  -- For multi-tier tasks (photo_identify escalates through Gemini →
  -- Haiku → Sonnet) this records which tier finally returned. 0 =
  -- default, 1+ = escalations.
  escalation_tier INTEGER NOT NULL DEFAULT 0,

  -- Optional: link back to the lot this call helped create. NULL for
  -- diagnostic / preview calls that didn't end up creating a lot.
  -- ON DELETE SET NULL so deleting a lot doesn't lose the cost record.
  lot_id         UUID REFERENCES lots(id) ON DELETE SET NULL,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ai_calls IS
  '0061: per-call AI/LLM cost log. One row per OpenRouter request. Aggregations per operator/user/task drive cost reporting + alerting.';

-- ----------------------------------------------------------------------------
-- Indexes — tuned for the dashboards we want to build.
-- ----------------------------------------------------------------------------

-- "AI cost for this operator over time" — the canonical dashboard query.
CREATE INDEX IF NOT EXISTS ai_calls_operator_created_idx
  ON ai_calls (operator_id, created_at DESC);

-- "Who's burning the most AI" — for staff-level breakdowns when an
-- operator wants to see which lotter is causing cost spikes.
CREATE INDEX IF NOT EXISTS ai_calls_user_created_idx
  ON ai_calls (user_id, created_at DESC);

-- "What's the cache hit rate by task" — for tuning the catalog cache.
CREATE INDEX IF NOT EXISTS ai_calls_task_created_idx
  ON ai_calls (task, created_at DESC);

-- ----------------------------------------------------------------------------
-- RLS — staff read their operator's rows; service role writes via the
-- /api/lottr/* routes. No INSERT/UPDATE/DELETE from the bidder app
-- (bidders aren't a concept for ai_calls).
-- ----------------------------------------------------------------------------

ALTER TABLE ai_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_calls_staff_read ON ai_calls;
CREATE POLICY ai_calls_staff_read ON ai_calls
  FOR SELECT
  USING (operator_id = current_operator_id());

-- No staff-level INSERT/UPDATE/DELETE policies. The /api/lottr/* routes
-- write via the service-role admin client (bypasses RLS), which is
-- already the only path that has the `model + tokens + cost` data
-- (it's emitted from the LlmTelemetrySink that the server installs
-- per request — the mobile bundle doesn't have those fields).
