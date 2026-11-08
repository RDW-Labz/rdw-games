-- 0318 — aging_inventory_report: msrp_cents must be BIGINT, not INT
--
-- Reported 2026-08-13: /reports/aging fails to load with
--   "structure of query does not match function result type"
--
-- The report page's error copy blames an unapplied migration 0286. That is
-- WRONG and this migration also fixes the copy (see the page change in this
-- commit). 0286 IS applied on BinGo prod — verified against the live catalog:
--
--   aging_inventory_report(p_min_cycles integer)
--     RETURNS TABLE(..., msrp_cents integer, last_relisted_at timestamptz)
--
-- The failure is a type mismatch INSIDE the function, not a missing function.
-- 0286 declared the OUT column
--
--     msrp_cents INT
--
-- but selects `tip.msrp_cents` straight out of `lots`, and lots.msrp_cents is
-- BIGINT (int8) in prod. PL/pgSQL's RETURN QUERY requires each returned column
-- to match the declared OUT type EXACTLY — it will not silently widen int4 to
-- int8 — so the function raises
--
--   42804: structure of query does not match function result type
--   DETAIL: Returned type bigint does not match expected type integer in column 13
--
-- Column 13 is msrp_cents. Reproduced locally on postgres 16 against a fixture
-- using prod's column types; the DETAIL above is copied from that run.
--
-- This fires on EVERY call, not just ones with rows: Postgres validates the
-- result row descriptor when the query is set up, so the threshold that
-- returns nothing (verified: p_min_cycles=9 against a fixture with no
-- qualifying lots) fails identically to the default. The report has therefore
-- never rendered since 0286 shipped — there is no "it used to work" window and
-- no data-dependent trigger to look for. (For scale: prod has 384 lots at the
-- default 3-cycle threshold and 2116 at 2.)
--
-- FIX: declare the column BIGINT so it matches the source column. Widening is
-- the lossless direction. The alternative — casting `tip.msrp_cents::INT` in
-- the body — would keep the narrow OUT type but introduce an overflow error
-- on any MSRP above ~$21.4M, trading a guaranteed bug for a rare one.
--
-- The operator console reads this column as `number | null`, which is correct
-- either way: PostgREST renders int8 as a JSON number, and cent values stay
-- far below 2^53.
--
-- ── Why DROP + CREATE rather than CREATE OR REPLACE ────────────────────────
-- CREATE OR REPLACE FUNCTION cannot change a function's return type — Postgres
-- rejects it with "cannot change return type of existing function". Changing a
-- RETURNS TABLE column type IS a return-type change (the OUT columns form the
-- composite result type), so the function must be dropped first.
--
-- DROP is safe here: the function is read-only, called only by the operator
-- console's aging report, and nothing holds a dependency on it (no view, no
-- generated column, no other function calls it). The GRANT is re-issued below
-- because DROP takes the ACL with it.
--
-- Everything else — the body, the lineage walk, the operator scoping, the
-- SECURITY DEFINER posture, the argument signature — is byte-for-byte 0286.
-- Only the msrp_cents OUT type changes.

BEGIN;

DROP FUNCTION IF EXISTS public.aging_inventory_report(INT);

CREATE FUNCTION public.aging_inventory_report(p_min_cycles INT DEFAULT 3)
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
  msrp_cents            BIGINT,   -- 0318: was INT; lots.msrp_cents is BIGINT
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
  '0286, retyped by 0318: items whose current (tip) lot has cycled through >= '
  'p_min_cycles auctions (default 3; relist_count >= p_min_cycles-1), for '
  'aging-inventory triage. Operator-scoped, excludes disposed/deleted. Returns '
  'original (lineage-root) + current lot codes, cycle count, location, auction, '
  'status. msrp_cents is BIGINT to match lots.msrp_cents — declaring it INT '
  'made every non-empty result raise 42804.';

COMMIT;
