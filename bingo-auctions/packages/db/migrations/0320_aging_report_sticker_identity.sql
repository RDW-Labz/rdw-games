-- 0320 — Ageing Inventory Report keys on the PHYSICAL STICKER, not BIN numbers
--
-- Owner, 2026-08-13: "I do not want BIN numbers used for Relot or ageing
-- tracking. The physical TEA/PNK/BRN/GRA sticker is the item's identity. The
-- original plan was to add _01, _02, etc. to that physical lot code so we could
-- track how many auction cycles the same item has gone through... the Ageing
-- Inventory Report must follow the original physical sticker through each relot
-- and count every cycle. Customers and staff should continue seeing the
-- physical sticker code — not BIN numbers."
--
-- 0286 returned current_lot_code / original_lot_code (BIN-######) as the lead
-- identity and the sticker only as a secondary field, so the report read as a
-- list of synthetic codes. This fixes that: the sticker leads, and each row
-- carries the _NN cycle suffix that was originally asked for.
--
-- ── The _NN suffix is DERIVED, not written to sticker_code ─────────────────
-- The owner asked for "_01, _02 appended to the physical lot code" and left the
-- method open. Appending to the STORED sticker_code would break the warehouse,
-- for three reasons:
--
--   1. sticker_code is the SCAN KEY. _find_lot_by_scan (0304) resolves a
--      scanned label through it. The label physically printed on the box says
--      "BRN4374029" and nothing else — it is printed once at intake and never
--      reprinted. Storing "BRN4374029_03" would mean the code on the box no
--      longer matches the code in the column, i.e. the box stops scanning.
--   2. It would have to be rewritten on every relot, so the one immutable
--      identifier the item has — the thing physically stuck to it — would
--      become a moving target, and every historical reference to it stale.
--   3. sticker_code carries a CHECK on its "{op}:" shape plus uniqueness and
--      the 0283 / 0308 claim guards. A suffix collides with all of it.
--
-- The cycle count is ALREADY tracked exactly, in lots.relist_count. So the
-- suffix costs nothing to compute and cannot drift from the truth:
--
--     BRN4374029  +  relist_count 2  ->  "BRN4374029_03"   (3rd auction)
--
-- Same string the owner wanted to read, with the scan key left alone. If a
-- printed _NN is ever genuinely wanted on a re-sticker, that is a labelling
-- decision and this column is what it should print.
--
-- ── Following the sticker through the lineage ──────────────────────────────
-- "Must follow the original physical sticker through each relot" is exactly
-- what display_code (0315) already does: own sticker → nearest ancestor's
-- sticker → ancestor's legacy-shaped lot_code → own lot_code. Verified on prod:
-- for the deepest chains, tip and lineage root both resolve to the same label
-- (BIN-005665 and its parent BIN-003112 both -> "BRN4374029"), which is the
-- point — one physical box, one label, however many BIN rows it has worn.
--
-- So this migration reuses display_code rather than re-deriving the walk. The
-- two cannot drift, and the report agrees with the pickup screen and the drains
-- by construction.
--
-- BIN codes are NOT dropped from the payload — current_lot_code /
-- original_lot_code stay, because support still needs to join a report row to a
-- specific database row when something looks wrong. They stop being the lead
-- identity; the UI in this commit demotes them to a muted secondary line.
--
-- ── Also carries 0318 forward ──────────────────────────────────────────────
-- msrp_cents stays BIGINT (0318). Declaring it INT against a BIGINT column made
-- every call raise 42804 — see that migration. Since this one rewrites the
-- signature anyway, it is self-contained: applying 0320 fixes the type whether
-- or not 0318 ran first, and applying them in either order converges.

BEGIN;

DROP FUNCTION IF EXISTS public.aging_inventory_report(INT);

CREATE FUNCTION public.aging_inventory_report(p_min_cycles INT DEFAULT 3)
RETURNS TABLE (
  lot_id                UUID,
  -- Lead identity: the label physically on the box, with the cycle suffix.
  cycle_code            TEXT,   -- "BRN4374029_03"
  current_display_code  TEXT,   -- "BRN4374029" — sticker on the box today
  original_display_code TEXT,   -- sticker resolved at the lineage root
  auction_cycles        INT,
  -- Secondary: synthetic DB codes, kept for support joins only.
  current_lot_code      TEXT,
  current_sticker_code  TEXT,
  original_lot_code     TEXT,
  original_sticker_code TEXT,
  status                TEXT,
  flagged_for_disposal  BOOLEAN,
  auction_id            UUID,
  auction_title         TEXT,
  bin_code              TEXT,
  warehouse_name        TEXT,
  msrp_cents            BIGINT,
  last_relisted_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    -- "BRN4374029_03". lpad to 2 so _01.._09 sort next to _10 in a text sort,
    -- which is how the owner writes them; >99 cycles simply gets more digits.
    public.display_code(tip)
      || '_' || lpad((COALESCE(tip.relist_count, 0) + 1)::TEXT, 2, '0'),
    public.display_code(tip),
    -- LEFT JOIN: a tip with no resolvable root yields an all-NULL row, and
    -- display_code() on that would walk from a NULL id. Guard on root.id.
    CASE WHEN root.id IS NOT NULL THEN public.display_code(root) END,
    (COALESCE(tip.relist_count, 0) + 1)::INT,
    tip.lot_code,
    tip.sticker_code,
    root.lot_code,
    root.sticker_code,
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
  '0286, retyped by 0318, re-keyed by 0320: items whose current (tip) lot has '
  'cycled through >= p_min_cycles auctions. Leads with the PHYSICAL sticker '
  '(display_code, 0315) plus a derived _NN cycle suffix — "BRN4374029_03" — '
  'because the sticker is the item identity and BIN codes are synthetic. The '
  'suffix is computed from relist_count and never written to sticker_code, '
  'which stays the scan key. BIN codes remain in the payload for support joins.';

COMMIT;
