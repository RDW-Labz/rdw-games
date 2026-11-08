-- ============================================================================
-- 0085_ai_billing
--
-- Per-operator AI usage billing infrastructure. Phase 1: tracking,
-- per-operator cap enforcement, alerting, and operator UI data.
-- Phase 2 (later): Stripe metered billing automation.
--
-- Three additions:
--   1. Two new columns on operators:
--        monthly_ai_budget_cents  — hard spend cap per calendar month
--        ai_billing_markup_bps    — platform's markup on AI passthrough
--   2. View  operator_ai_usage_mtd — month-to-date raw AI cost per operator
--   3. RPC   check_operator_ai_budget — budget check + projected cost,
--        called before each AI request to enforce the cap
--   4. Three new notification_kind values for 50/80/100% budget alerts
-- ============================================================================

-- ── 1. Operator-side billing config ──────────────────────────────────────────

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS monthly_ai_budget_cents BIGINT NOT NULL DEFAULT 10000,
    -- $100 default. Operators can request higher via support.
    -- Hard cap: when hit, AI calls are blocked for the rest of the month.
  ADD COLUMN IF NOT EXISTS ai_billing_markup_bps INT NOT NULL DEFAULT 2500;
    -- 2500 basis points = 25% markup. Platform's revenue share on AI
    -- pass-through. Stored as bps so we can adjust without renaming.

-- ── 2. Month-to-date cost view ────────────────────────────────────────────────

CREATE OR REPLACE VIEW operator_ai_usage_mtd AS
SELECT
  operator_id,
  date_trunc('month', now()) AS month,
  COALESCE(SUM(cost_cents), 0) AS raw_cost_cents
FROM ai_calls
WHERE created_at >= date_trunc('month', now())
  AND operator_id IS NOT NULL
GROUP BY operator_id;

GRANT SELECT ON operator_ai_usage_mtd TO authenticated, service_role;

-- ── 3. Budget-check RPC ───────────────────────────────────────────────────────
--
-- Returns one row per call with:
--   allowed              — whether the anticipated call would stay within budget
--   raw_cost_mtd_cents   — actual passthrough spend so far this month
--   billed_cost_mtd_cents — operator's billed amount (raw × markup)
--   budget_cents         — the operator's monthly cap
--   markup_bps           — the markup in basis points
--   pct_used             — billed / budget × 100, capped at 100

CREATE OR REPLACE FUNCTION check_operator_ai_budget(
  p_operator_id UUID,
  p_anticipated_cost_cents BIGINT DEFAULT 0
)
RETURNS TABLE (
  allowed BOOLEAN,
  raw_cost_mtd_cents BIGINT,
  billed_cost_mtd_cents BIGINT,
  budget_cents BIGINT,
  markup_bps INT,
  pct_used NUMERIC(5,2)
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH op AS (
    SELECT monthly_ai_budget_cents, ai_billing_markup_bps
    FROM operators WHERE id = p_operator_id
  ),
  mtd AS (
    SELECT raw_cost_cents FROM operator_ai_usage_mtd WHERE operator_id = p_operator_id
  )
  SELECT
    -- Projected billed cost including this call
    (COALESCE(mtd.raw_cost_cents, 0) + p_anticipated_cost_cents)
      * (1 + op.ai_billing_markup_bps / 10000.0) <= op.monthly_ai_budget_cents,
    COALESCE(mtd.raw_cost_cents, 0),
    ROUND(COALESCE(mtd.raw_cost_cents, 0) * (1 + op.ai_billing_markup_bps / 10000.0)),
    op.monthly_ai_budget_cents,
    op.ai_billing_markup_bps,
    LEAST(100, ROUND(
      COALESCE(mtd.raw_cost_cents, 0)
        * (1 + op.ai_billing_markup_bps / 10000.0)
        / NULLIF(op.monthly_ai_budget_cents, 0) * 100,
      2
    ))
  FROM op LEFT JOIN mtd ON TRUE;
$$;

GRANT EXECUTE ON FUNCTION check_operator_ai_budget(UUID, BIGINT) TO authenticated, service_role;

COMMENT ON FUNCTION check_operator_ai_budget(UUID, BIGINT) IS
  '0085: pre-call budget check. Returns allowed=true if the projected billed cost '
  '(MTD + anticipated × markup) stays within the operator''s monthly cap. '
  'Also returns raw/billed MTD totals and pct_used for the cron alerting loop.';

-- ── 4. notification_kind enum — three new AI-budget values ───────────────────
--
-- Idempotency keys used by the cron alerter:
--   ai_budget_50:<operator_id>:<YYYY-MM>
--   ai_budget_80:<operator_id>:<YYYY-MM>
--   ai_budget_100:<operator_id>:<YYYY-MM>

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'ai_budget_50';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'ai_budget_80';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'ai_budget_100';
