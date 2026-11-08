-- 0286 — aging-inventory report + duplicate-lot audit RPCs
--
-- Jared patch notes 2026-07-24:
--   (3) Aging-inventory report: flag items that have cycled through N+ auctions
--       (default 3 = Jared's "_02" carryover) so they can be pulled from the
--       normal auction rotation for disposal / donation / liquidation.
--   (4/5) Duplicate / ghost-listing audit: after the BIN-002580 / BIN-002369 /
--       PNK4859980 incident, a staff-runnable check for duplicate inventory
--       tied to the same physical item — replaces one-off SQL scans.
--
-- Both are SECURITY DEFINER + operator-scoped (caller's operator_users row),
-- read-only, and return TABLEs the operator console renders. They mirror the
-- existing report-RPC pattern (operator_auction_performance, mig 0225).
--
-- "Auction cycles" = relist_count + 1. The system does NOT use _01/_02 string
-- suffixes (Jared's mental model from the legacy system); each carryover MINTS a
-- fresh lot_code and bumps relist_count on the child while linking lineage via
-- relisted_from_lot_id. So relist_count 0 = 1st auction, 1 = 2nd (BRN..._01),
-- 2 = 3rd (BRN..._02). The report resolves the lineage ROOT for the original
-- code and reports the current (tip) lot for everything else.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. aging_inventory_report(p_min_cycles) — items past N auction cycles
-- ---------------------------------------------------------------------------
-- Returns ONE row per item at the TIP of its lineage (the current lot — a lot
-- with no active child) whose cycle count has reached the threshold and which
-- is not already disposed. p_min_cycles is the minimum number of auction cycles
-- to flag (default 3): relist_count >= p_min_cycles - 1.
CREATE OR REPLACE FUNCTION public.aging_inventory_report(p_min_cycles INT DEFAULT 3)
RETURNS TABLE (
  lot_id                UUID,
  current_lot_code      TEXT,
  current_sticker_code  TEXT,
  original_lot_code     TEXT,
  original_sticker_code TEXT,
  auction_cycles        INT,
  status                TEXT,
  flagged_for_disposal  BOOLEAN,
  auction_id            UUID,
  auction_title         TEXT,
  bin_code              TEXT,
  warehouse_name        TEXT,
  msrp_cents            INT,
  last_relisted_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
-- OUT columns (status, auction_id, msrp_cents, …) share names with lots
-- columns; prefer the column on any bare reference. All refs below are already
-- qualified, so this is just a safety net against the classic RETURNS TABLE
-- "column reference is ambiguous" runtime error.
#variable_conflict use_column
DECLARE
  v_caller UUID := auth.uid();
  v_op     UUID;
  v_min    INT := GREATEST(COALESCE(p_min_cycles, 3), 1);
BEGIN
  IF v_caller IS NULL THEN RETURN; END IF;
  SELECT operator_id INTO v_op FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_op IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH RECURSIVE
  tips AS (
    -- Current lots at/over the cycle threshold with NO active child (i.e. the
    -- live representation of the item, not a retired parent). 'disposed' is
    -- excluded — it has already left the rotation.
    SELECT l.id
    FROM lots l
    WHERE l.operator_id = v_op
      AND l.deleted_at IS NULL
      AND l.status <> 'disposed'
      AND COALESCE(l.relist_count, 0) >= (v_min - 1)
      AND NOT EXISTS (
        SELECT 1 FROM lots c
        WHERE c.relisted_from_lot_id = l.id
          AND c.canceled_at IS NULL
          AND c.deleted_at IS NULL
      )
  ),
  walk AS (
    -- Walk each tip UP its relisted_from_lot_id chain to find the lineage root.
    SELECT t.id AS tip_id, l.id AS node_id, l.relisted_from_lot_id AS parent_id
    FROM tips t JOIN lots l ON l.id = t.id
    UNION ALL
    SELECT w.tip_id, p.id, p.relisted_from_lot_id
    FROM walk w JOIN lots p ON p.id = w.parent_id
  ),
  roots AS (
    SELECT tip_id, node_id AS root_id
    FROM walk
    WHERE parent_id IS NULL
  )
  SELECT
    tip.id,
    tip.lot_code,
    tip.sticker_code,
    root.lot_code,
    root.sticker_code,
    (COALESCE(tip.relist_count, 0) + 1)::INT,
    tip.status::TEXT,
    tip.flagged_for_disposal,
    tip.auction_id,
    a.title,
    b.code,
    w.name,
    tip.msrp_cents,
    tip.last_relisted_at
  FROM tips t
  JOIN lots tip           ON tip.id = t.id
  LEFT JOIN roots r       ON r.tip_id = t.id
  LEFT JOIN lots root     ON root.id = r.root_id
  LEFT JOIN auctions a    ON a.id = tip.auction_id
  LEFT JOIN bins b        ON b.id = tip.intake_bin_id
  LEFT JOIN warehouses w  ON w.id = tip.warehouse_id
  ORDER BY COALESCE(tip.relist_count, 0) DESC, tip.last_relisted_at DESC NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.aging_inventory_report(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aging_inventory_report(INT) TO authenticated;

COMMENT ON FUNCTION public.aging_inventory_report(INT) IS
  '0286: items whose current (tip) lot has cycled through >= p_min_cycles '
  'auctions (default 3; relist_count >= p_min_cycles-1), for aging-inventory '
  'triage. Operator-scoped, excludes disposed/deleted. Returns original '
  '(lineage-root) + current lot codes, cycle count, location, auction, status.';

-- ---------------------------------------------------------------------------
-- 2. duplicate_lot_audit() — find duplicate / ghost inventory
-- ---------------------------------------------------------------------------
-- Four independent checks, one row per duplicate cluster:
--   multi_active_child : a source lot with >1 active (non-canceled/-deleted)
--                        relist child — the exact thing 0275 now prevents.
--   dup_sticker        : same sticker_code on >1 non-deleted lot.
--   dup_qr             : same qr_token on >1 non-deleted lot (should be
--                        impossible — a unique index — so any hit is a bug).
--   same_root_active   : one lineage root with >1 ACTIVE (scheduled/live)
--                        listing — the "same item in one auction twice" risk.
CREATE OR REPLACE FUNCTION public.duplicate_lot_audit()
RETURNS TABLE (
  kind      TEXT,
  key_value TEXT,
  n         INT,
  lot_codes TEXT[],
  lot_ids   UUID[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
-- Prefer columns over the OUT params (kind/key_value/n/…) on bare references.
#variable_conflict use_column
DECLARE
  v_caller UUID := auth.uid();
  v_op     UUID;
BEGIN
  IF v_caller IS NULL THEN RETURN; END IF;
  SELECT operator_id INTO v_op FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_op IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH RECURSIVE
  active_walk AS (
    -- Every active (scheduled/live) lot, walked up to its lineage root.
    SELECT l.id AS active_id, l.id AS cur, l.relisted_from_lot_id AS parent_id
    FROM lots l
    WHERE l.operator_id = v_op
      AND l.deleted_at IS NULL
      AND l.status IN ('scheduled', 'live')
    UNION ALL
    SELECT aw.active_id, p.id, p.relisted_from_lot_id
    FROM active_walk aw JOIN lots p ON p.id = aw.parent_id
  ),
  active_roots AS (
    SELECT active_id, cur AS root_id FROM active_walk WHERE parent_id IS NULL
  )
  -- A) source with >1 active child
  SELECT
    'multi_active_child'::TEXT,
    s.lot_code,
    COUNT(*)::INT,
    array_agg(c.lot_code || ' [' || c.status::TEXT || ']' ORDER BY c.created_at),
    array_agg(c.id ORDER BY c.created_at)
  FROM lots c
  JOIN lots s ON s.id = c.relisted_from_lot_id
  WHERE c.operator_id = v_op
    AND c.canceled_at IS NULL
    AND c.deleted_at IS NULL
  GROUP BY s.id, s.lot_code
  HAVING COUNT(*) > 1

  UNION ALL
  -- B) duplicate sticker_code
  SELECT
    'dup_sticker'::TEXT,
    l.sticker_code,
    COUNT(*)::INT,
    array_agg(l.lot_code || ' [' || l.status::TEXT || ']' ORDER BY l.created_at),
    array_agg(l.id ORDER BY l.created_at)
  FROM lots l
  WHERE l.operator_id = v_op
    AND l.deleted_at IS NULL
    AND l.sticker_code IS NOT NULL
  GROUP BY l.sticker_code
  HAVING COUNT(*) > 1

  UNION ALL
  -- C) duplicate qr_token
  SELECT
    'dup_qr'::TEXT,
    l.qr_token::TEXT,
    COUNT(*)::INT,
    array_agg(l.lot_code || ' [' || l.status::TEXT || ']' ORDER BY l.created_at),
    array_agg(l.id ORDER BY l.created_at)
  FROM lots l
  WHERE l.operator_id = v_op
    AND l.deleted_at IS NULL
    AND l.qr_token IS NOT NULL
  GROUP BY l.qr_token
  HAVING COUNT(*) > 1

  UNION ALL
  -- D) same lineage root with >1 active listing
  SELECT
    'same_root_active'::TEXT,
    root.lot_code,
    COUNT(*)::INT,
    array_agg(act.lot_code || ' [' || act.status::TEXT || ']' ORDER BY act.created_at),
    array_agg(act.id ORDER BY act.created_at)
  FROM active_roots ar
  JOIN lots act  ON act.id = ar.active_id
  JOIN lots root ON root.id = ar.root_id
  GROUP BY root.id, root.lot_code
  HAVING COUNT(*) > 1;
END;
$$;

REVOKE ALL ON FUNCTION public.duplicate_lot_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.duplicate_lot_audit() TO authenticated;

COMMENT ON FUNCTION public.duplicate_lot_audit() IS
  '0286: operator-scoped duplicate/ghost inventory audit. Returns clusters for '
  'sources with >1 active child, duplicate sticker_code, duplicate qr_token, '
  'and one lineage root with >1 active (scheduled/live) listing. Read-only.';

COMMIT;
