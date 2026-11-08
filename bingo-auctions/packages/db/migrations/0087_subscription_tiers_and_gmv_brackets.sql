-- ============================================================================
-- 0087_subscription_tiers_and_gmv_brackets
--
-- Implements ClovrBid's tiered pricing model:
--
--   Subscription tiers (2):
--     starter  $99/mo
--     pro      $299/mo
--
--   GMV application-fee brackets (per-operator, per-calendar-month):
--     $0       – $25,000     2.5%
--     $25,001  – $100,000    2.0%
--     $100,001+              1.5%
--
--   Founder pricing (first 10 operators, locked 12 months from creation):
--     $0       – $25,000     2.0%
--     $25,001  – $100,000    1.5%
--     $100,001+              1.0%
--
-- Fee base = winning_bid + buyer's_premium  (i.e. invoice.total_cents
-- minus invoice.tax_cents). Sales tax is excluded — it flows through
-- to the operator / state revenue authority and is NOT platform revenue.
--
-- The compute_application_fee_cents() RPC handles bracket straddling
-- correctly: if an operator is at $24k MTD and a $5k sale pushes them
-- across the $25k boundary, the first $1k is billed at 2.5% and the
-- remaining $4k at 2.0%.
-- ============================================================================

-- ── 1. Add tier columns to operators ────────────────────────────────────────

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS subscription_tier TEXT NOT NULL DEFAULT 'starter'
    CHECK (subscription_tier IN ('starter', 'pro')),
  ADD COLUMN IF NOT EXISTS founder_pricing BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS founder_locked_until DATE;

COMMENT ON COLUMN operators.subscription_tier IS
  'ClovrBid subscription plan: starter ($99/mo) or pro ($299/mo).';

COMMENT ON COLUMN operators.founder_pricing IS
  'TRUE for the first 10 operators. Reduces each GMV bracket rate by 0.5pp '
  '(2.0%/1.5%/1.0% instead of 2.5%/2.0%/1.5%). Locked for 12 months from '
  'operator creation, after which standard rates apply automatically.';

COMMENT ON COLUMN operators.founder_locked_until IS
  'Founder discount applies through this date (inclusive). Set to '
  '(created_at::date + 12 months) at operator creation. After this date '
  'compute_application_fee_cents() falls back to standard bracket rates '
  'even when founder_pricing = TRUE.';

-- ── 2. Backfill: all existing operators receive founder pricing ──────────────

UPDATE operators
SET founder_pricing      = TRUE,
    founder_locked_until = (created_at::date + INTERVAL '12 months')::date
WHERE founder_pricing = FALSE;

-- ── 3. RPC: compute application-fee cents (handles bracket straddling) ───────
--
-- Arguments:
--   p_operator_id        — the operator whose MTD GMV is accumulated
--   p_sale_amount_cents  — (winning bid + buyer's premium), EXCLUDING sales
--                          tax. This is the fee base. Callers must subtract
--                          invoice.tax_cents from invoice.total_cents before
--                          passing this value.
--
-- Returns the platform application fee in cents for THIS transaction.
--
-- Straddling example (standard rates):
--   operator MTD = $24,000  →  running = 2_400_000 cents
--   sale amount  = $5,000   →  p_sale_amount_cents = 500_000 cents
--   b1_top = 2_500_000 cents ($25k boundary)
--
--   amt_in_b1 = LEAST(2_400_000 + 500_000, 2_500_000)
--             - LEAST(2_400_000, 2_500_000)
--             = 2_500_000 - 2_400_000 = 100_000  ($1k @ 2.5%)
--
--   amt_in_b2 = LEAST(2_900_000, 10_000_000)
--             - GREATEST(2_400_000, 2_500_000)
--             = 2_900_000 - 2_500_000 = 400_000  ($4k @ 2.0%)
--
--   fee = ROUND(100_000 * 250 / 10000.0) + ROUND(400_000 * 200 / 10000.0)
--       = 2_500 + 8_000 = 10_500 cents  ($105.00)

CREATE OR REPLACE FUNCTION compute_application_fee_cents(
  p_operator_id       UUID,
  p_sale_amount_cents BIGINT   -- (winning bid + buyer's premium), pre-tax
)
RETURNS BIGINT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_mtd_cents      BIGINT;
  v_is_founder     BOOLEAN;
  v_founder_until  DATE;

  -- Bracket boundaries in cents
  v_b1_top  BIGINT := 2500000;    -- $25,000
  v_b2_top  BIGINT := 10000000;   -- $100,000

  -- Standard rates in basis points (100 bps = 1%)
  v_b1_bps  INT := 250;   -- 2.5%
  v_b2_bps  INT := 200;   -- 2.0%
  v_b3_bps  INT := 150;   -- 1.5%

  v_amt_in_b1  BIGINT;
  v_amt_in_b2  BIGINT;
  v_amt_in_b3  BIGINT;
  v_running    BIGINT;
  v_fee        BIGINT := 0;
BEGIN
  -- Load operator tier flags
  SELECT founder_pricing, founder_locked_until
    INTO v_is_founder, v_founder_until
  FROM operators
  WHERE id = p_operator_id;

  -- Founder discount expires the day AFTER founder_locked_until
  IF v_is_founder AND (v_founder_until IS NULL OR v_founder_until < CURRENT_DATE) THEN
    v_is_founder := FALSE;
  END IF;

  -- Apply founder rate reduction: each bracket -0.5pp (50 bps)
  IF v_is_founder THEN
    v_b1_bps := 200;   -- 2.0%
    v_b2_bps := 150;   -- 1.5%
    v_b3_bps := 100;   -- 1.0%
  END IF;

  -- Sum MTD GMV for this operator: paid invoices in the current calendar month.
  -- Fee base = total_cents - tax_cents (sales tax excluded; not platform revenue).
  SELECT COALESCE(SUM(total_cents - tax_cents), 0)
    INTO v_mtd_cents
  FROM invoices
  WHERE operator_id = p_operator_id
    AND status      = 'paid'
    AND paid_at    >= date_trunc('month', now())
    AND paid_at     < date_trunc('month', now()) + INTERVAL '1 month';

  v_running := v_mtd_cents;

  -- Portion of this sale that falls in bracket 1 (0 – $25k)
  v_amt_in_b1 := GREATEST(0,
    LEAST(v_running + p_sale_amount_cents, v_b1_top) - LEAST(v_running, v_b1_top)
  );

  -- Portion in bracket 2 ($25k – $100k)
  v_amt_in_b2 := GREATEST(0,
    LEAST(v_running + p_sale_amount_cents, v_b2_top)
    - GREATEST(v_running, v_b1_top)
  );

  -- Portion above $100k (bracket 3)
  v_amt_in_b3 := GREATEST(0,
    (v_running + p_sale_amount_cents) - GREATEST(v_running, v_b2_top)
  );

  v_fee := ROUND(v_amt_in_b1 * v_b1_bps / 10000.0)
         + ROUND(v_amt_in_b2 * v_b2_bps / 10000.0)
         + ROUND(v_amt_in_b3 * v_b3_bps / 10000.0);

  RETURN v_fee;
END;
$$;

GRANT EXECUTE ON FUNCTION compute_application_fee_cents(UUID, BIGINT)
  TO authenticated, service_role;

COMMENT ON FUNCTION compute_application_fee_cents(UUID, BIGINT) IS
  'Returns the ClovrBid application fee in cents for a single sale, accounting '
  'for where the operator sits in their monthly GMV brackets. Handles bracket '
  'straddling: a sale that crosses a bracket boundary is split and each portion '
  'billed at the applicable rate. Automatically applies founder discount (–0.5pp '
  'per bracket) while founder_locked_until >= CURRENT_DATE.';

-- ── 4. MTD billing summary view ──────────────────────────────────────────────
--
-- Used by the operator billing page to display current-month GMV progress,
-- effective rate tier, and projected fee.

CREATE OR REPLACE VIEW operator_billing_mtd AS
SELECT
  o.id                     AS operator_id,
  o.business_name,
  o.subscription_tier,
  -- founder_active is TRUE only while the lock window is still open
  (
    o.founder_pricing = TRUE
    AND COALESCE(o.founder_locked_until, '1970-01-01'::date) >= CURRENT_DATE
  )                        AS founder_active,
  o.founder_locked_until,
  -- MTD GMV = sum of (total - tax) for paid invoices this calendar month
  COALESCE(SUM((i.total_cents - i.tax_cents)) FILTER (
    WHERE i.status  = 'paid'
      AND i.paid_at >= date_trunc('month', now())
  ), 0)                    AS gmv_mtd_cents,
  -- MTD platform fees actually collected
  COALESCE(SUM(i.application_fee_cents) FILTER (
    WHERE i.status  = 'paid'
      AND i.paid_at >= date_trunc('month', now())
  ), 0)                    AS app_fee_collected_mtd_cents
FROM operators o
LEFT JOIN invoices i ON i.operator_id = o.id
GROUP BY o.id;

GRANT SELECT ON operator_billing_mtd TO authenticated, service_role;

COMMENT ON VIEW operator_billing_mtd IS
  'Per-operator month-to-date GMV and platform fee summary. '
  'GMV is (total_cents - tax_cents) to exclude sales tax from the fee base. '
  'Used by the operator billing page and admin dashboards.';
