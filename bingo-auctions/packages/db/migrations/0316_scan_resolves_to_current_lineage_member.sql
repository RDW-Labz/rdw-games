-- 0316 — a scanned label resolves to the box's CURRENT record, not whichever
-- old record still wears the sticker
--
-- Owner report 2026-08-10, found while fixing the display side (0315):
--
--   TEA4951993 (root, 'relisted' — legacy import, label is its lot_code)
--     ├── BIN-006802 ('unsold',  wears BIN:TEA4951993)   created 07-30
--     └── BIN-007904 ('won',     sticker NULL)           created 08-07
--
-- Scanning the box's printed label TEA4951993 returned BIN-006802 — the
-- superseded unsold record from the auction that closed on the 4th — while the
-- item the customer actually won is BIN-007904. At the pickup counter that
-- means the scan does not pull up the pickup it is supposed to verify.
--
-- WHY 0304'S FORWARD WALK MISSED IT. 0304 already hops forward off a tombstone,
-- but only when the matched row's status is canceled/relisted/disposed, and
-- only DOWN from that row. Here the winning match (BIN-006802) is 'unsold',
-- which is not a tombstone status, so no hop ran. And even if one had, walking
-- down from BIN-006802 finds nothing: the current record is its SIBLING, not
-- its descendant. Both were relisted off the same root. A box that goes unsold
-- and is relisted leaves exactly this shape, so it is the common case, not an
-- exotic one.
--
-- FIX: stop treating "which row matched the code" as "which row is the item".
-- Once a row matches, resolve to the current member of that row's whole
-- LINEAGE TREE — climb to the root, walk every descendant, and take the newest
-- record that is not a tombstone. A lineage tree is one physical box's history
-- by definition (duplicate_lot deliberately leaves relisted_from_lot_id NULL
-- precisely because a duplicate is a different box), so this cannot cross
-- boxes. When the matched row IS already the current member — the overwhelming
-- majority — the answer is unchanged.
--
-- This subsumes 0304's forward walk: a tombstone match now climbs to the root
-- and descends to the newest live member, which is what that walk was reaching
-- for, and it additionally covers the sibling shape above.
--
-- Read-side only. No lot data moves; sticker OWNERSHIP is untouched, so nothing
-- here can strand a label or trip the one-holder-per-label unique index. If a
-- lineage is cyclic (0312 exists because prod chains have cycled) the tree
-- resolves empty and the directly-matched row is returned unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public._find_lot_by_scan(p_candidates TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_op         UUID := public.current_operator_id();
  v_op_code    TEXT;
  v_cand       TEXT;
  v_clean      TEXT;
  v_uuid       UUID;
  v_lot        lots%ROWTYPE;
  v_lot_id     UUID;
  v_rank       INT;
  v_field      TEXT;
  v_alternates INT;
  v_hopped     TEXT;
  v_current_id UUID;
  v_matched_code TEXT;
BEGIN
  IF v_op IS NULL THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT code INTO v_op_code FROM public.operators WHERE id = v_op;

  FOREACH v_cand IN ARRAY p_candidates LOOP
    v_clean := TRIM(COALESCE(v_cand, ''));
    IF v_clean = '' THEN
      CONTINUE;
    END IF;

    -- Parse once; a non-UUID candidate simply skips the qr_token probe rather
    -- than aborting the statement.
    BEGIN
      v_uuid := v_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_uuid := NULL;
    END;

    -- One pass over every identifier column. `field_rank` encodes which probe
    -- matched; the ORDER BY, not the probe order, decides the winner.
    -- `total` counts every row the code is ambiguous across (window function,
    -- so it is computed before the LIMIT).
    v_lot_id     := NULL;
    v_rank       := NULL;
    v_alternates := 1;

    SELECT c.id, c.field_rank, c.total
      INTO v_lot_id, v_rank, v_alternates
    FROM (
      SELECT
        l2.id,
        CASE
          WHEN v_uuid IS NOT NULL AND l2.qr_token = v_uuid                     THEN 1
          WHEN v_op_code IS NOT NULL
               AND l2.sticker_code = v_op_code || ':' || v_clean               THEN 2
          WHEN l2.sticker_code = v_clean                                       THEN 3
          WHEN upper(l2.lot_code) = upper(v_clean)                             THEN 4
          WHEN upper(l2.legacy_lot_code) = upper(v_clean)                      THEN 5
          WHEN l2.operator_id = v_op AND l2.lpn = v_clean                      THEN 6
          WHEN l2.operator_id = v_op AND l2.fnsku = v_clean                    THEN 7
          WHEN l2.operator_id = v_op AND l2.external_code = v_clean            THEN 8
          WHEN l2.operator_id = v_op AND l2.asin = v_clean                     THEN 9
        END AS field_rank,
        -- Retired rows are history: a relisted/canceled/disposed row is never
        -- the item on the shelf when a live twin answers to the same code.
        (l2.status IN ('canceled', 'relisted', 'disposed')) AS retired,
        l2.created_at,
        COUNT(*) OVER () AS total
      FROM public.lots l2
      WHERE l2.deleted_at IS NULL
        AND (
             (v_uuid IS NOT NULL AND l2.qr_token = v_uuid)
          OR (v_op_code IS NOT NULL AND l2.sticker_code = v_op_code || ':' || v_clean)
          OR l2.sticker_code = v_clean
          OR upper(l2.lot_code) = upper(v_clean)
          OR upper(l2.legacy_lot_code) = upper(v_clean)
          OR (l2.operator_id = v_op AND l2.lpn = v_clean)
          OR (l2.operator_id = v_op AND l2.fnsku = v_clean)
          OR (l2.operator_id = v_op AND l2.external_code = v_clean)
          OR (l2.operator_id = v_op AND l2.asin = v_clean)
        )
    ) c
    ORDER BY
      c.retired ASC,       -- 1. the live incarnation wins outright
      c.field_rank ASC,    -- 2. the sticker on the box beats the lot_code
      c.created_at DESC    -- 3. newest — the relist child, by construction
    LIMIT 1;

    IF v_lot_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_lot FROM public.lots WHERE id = v_lot_id;

    -- `matched_field` describes how the CODE matched, so it is computed from
    -- the directly-matched row and is not disturbed by the hop below.
    v_field := CASE v_rank
      WHEN 1 THEN 'qr_token'
      WHEN 2 THEN 'sticker_code'
      WHEN 3 THEN 'sticker_code'
      WHEN 4 THEN 'lot_code'
      WHEN 5 THEN 'legacy_lot_code'
      WHEN 6 THEN 'lpn'
      WHEN 7 THEN 'fnsku'
      WHEN 8 THEN 'external_code'
      WHEN 9 THEN 'asin'
    END;

    -- Resolve to the CURRENT record of this physical box (0316). Replaces
    -- 0304's descend-only, tombstone-only walk: climb to the lineage root, then
    -- take the newest non-tombstone member of the whole tree. Scoped to the
    -- matched row's operator so a tree can never cross tenants.
    v_matched_code := v_lot.lot_code;
    v_current_id   := NULL;

    WITH RECURSIVE up AS (
      SELECT l.id, l.relisted_from_lot_id
        FROM public.lots l
       WHERE l.id = v_lot.id
      UNION
      SELECT l.id, l.relisted_from_lot_id
        FROM public.lots l
        JOIN up ON l.id = up.relisted_from_lot_id
    ),
    tree AS (
      SELECT u.id FROM up u WHERE u.relisted_from_lot_id IS NULL
      UNION
      SELECT l.id FROM public.lots l JOIN tree t ON l.relisted_from_lot_id = t.id
    )
    SELECT cur.id
      INTO v_current_id
      FROM public.lots cur
      JOIN tree t ON t.id = cur.id
     WHERE cur.deleted_at IS NULL
       AND cur.operator_id = v_lot.operator_id
     ORDER BY
       -- A box someone has BOUGHT and not yet collected outranks everything.
       -- This is the pickup counter's query: if a customer is on their way for
       -- this box, the scan must land on their lot, never on a newer relist of
       -- it. The relist guards should already make that combination
       -- unreachable, so this is belt-and-braces — but the cost of being wrong
       -- here is a customer standing at the counter while the scan shows
       -- somebody else's record.
       (EXISTS (
          SELECT 1 FROM public.invoice_lots il
           WHERE il.lot_id = cur.id
             AND il.refunded_at IS NULL
             AND il.forfeited_at IS NULL
             AND il.picked_up_at IS NULL
        )) DESC,
       (cur.status IN ('canceled', 'relisted', 'disposed')) ASC,
       cur.created_at DESC
     LIMIT 1;

    v_hopped := NULL;
    IF v_current_id IS NOT NULL AND v_current_id <> v_lot.id THEN
      SELECT * INTO v_lot FROM public.lots WHERE id = v_current_id;
      -- Carries the code that was actually scanned onto, so a caller can say
      -- "scanned BIN-006802, showing BIN-007904".
      v_hopped := v_matched_code;
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'lot', to_jsonb(v_lot),
      'matched_field', v_field,
      -- >0 means the scanned code is ambiguous and this row won the ranking.
      'alternates', GREATEST(COALESCE(v_alternates, 1) - 1, 0),
      -- Non-null when the scan was resolved forward to a newer record of the
      -- same physical box; carries the code that was scanned onto.
      'hopped_from', v_hopped
    );
  END LOOP;

  RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
END;
$function$;

COMMIT;
