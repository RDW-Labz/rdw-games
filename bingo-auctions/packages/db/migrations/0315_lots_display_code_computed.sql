-- 0315 — one resolved box label per lot, computed by the database
--
-- Field report 2026-08-10 (six-item relist test, BinGo): five of six lots showed
-- their printed label on the customer pickup screen; the sixth showed
-- "BIN-007904" while the box in the warehouse said "TEA4951993".
--
-- WHY THE SIXTH DIFFERED. Its lineage root is a go-live import lot, which
-- carries its printed label as its *lot_code* ("TEA4951993") — the sticker lane
-- is empty. The five that worked descend from re-lotted stock whose parent
-- carries "BIN:TEA…" in sticker_code. So resolving the label requires walking
-- the lineage AND accepting a legacy-shaped ancestor lot_code. `lotDisplayCode`
-- (packages/shared/src/lots.ts) does exactly that and is correct.
--
-- The defect is that the walk happens in TypeScript, over whatever lineage the
-- caller happened to embed. Three read paths embed `relisted_from` (two levels
-- deep); roughly two dozen others select only (lot_code, sticker_code) and so
-- resolve to the synthetic BIN-######. The email, SMS and push drains don't
-- even do that — they interpolate raw lot_code. Every one of those can show a
-- customer a code that is not on their box, and the list grows every time
-- someone writes a new select.
--
-- 0314 moved label OWNERSHIP to the right row; it could not fix reading, and by
-- its own "newest alive member" rule it deliberately skipped this tree
-- (BIN-007904 was won-then-refunded, so its unsold twin counted as current and
-- already wore the label — no move, no warning). Ownership and display are
-- different problems; this migration fixes display.
--
-- FIX: resolve the label ONCE, in the database, as a PostgREST computed column
-- so `select=…,display_code` is correct from any surface — including the drains
-- and any select written next year. Resolution order mirrors lotDisplayCode
-- exactly, so the two cannot drift:
--
--   1. this lot's own sticker_code, operator prefix stripped
--   2. else, nearest ancestor first: that ancestor's stripped sticker_code,
--      else its lot_code when it is legacy-label-shaped (^[A-Z]{2,8}[0-9]+$)
--   3. else this lot's lot_code
--
-- COMPUTED, NOT STORED, on purpose. A stored column needs a backfill UPDATE
-- across all ~12.8k lots plus a cascade trigger (an ancestor's sticker moving
-- changes what its descendants resolve to). Both push every lot row through
-- seven unrelated BEFORE UPDATE validation triggers, and a stored value can go
-- stale if any write path slips past the trigger. Computing on read cannot go
-- stale, writes nothing, and reverts by dropping one function. The walk is
-- short-circuited by the common case — a lot wearing its own sticker returns
-- without touching another row.
--
-- Ownership is untouched: sticker_code still decides scan resolution
-- (_find_lot_by_scan, mig 0304). This migration only adds a way to READ.

BEGIN;

-- ---------------------------------------------------------------------------
-- Label extraction — the SQL twins of stickerLabel() / legacyLotCodeLabel().
-- ---------------------------------------------------------------------------

-- "BIN:TEA4951993" -> "TEA4951993". The CHECK on lots.sticker_code guarantees a
-- single leading "{op}:", but a malformed value with no colon falls back to the
-- whole trimmed string rather than vanishing (matching the TS helper).
CREATE OR REPLACE FUNCTION public.lot_sticker_label(p_sticker text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_sticker IS NULL THEN NULL
    WHEN strpos(p_sticker, ':') = 0 THEN NULLIF(btrim(p_sticker), '')
    ELSE NULLIF(btrim(substr(p_sticker, strpos(p_sticker, ':') + 1)), '')
  END
$$;

-- A go-live import lot wears its printed label AS its lot_code ("TEA4951993").
-- Re-lotted stock gets a synthetic "BIN-######" that appears nowhere on the
-- box — the hyphen is what tells them apart. Only the former is inheritable.
CREATE OR REPLACE FUNCTION public.lot_legacy_label(p_lot_code text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN btrim(COALESCE(p_lot_code, '')) ~ '^[A-Z]{2,8}[0-9]+$' THEN btrim(p_lot_code)
  END
$$;

-- ---------------------------------------------------------------------------
-- The resolver, taking raw fields so callers can resolve a row that is not in
-- the table yet (or whose new values are not visible to a self-SELECT).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.lot_resolve_display_code(
  p_lot_id   uuid,
  p_sticker  text,
  p_lot_code text,
  p_parent   uuid
) RETURNS text
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $$
DECLARE
  v_label  text;
  v_cur    uuid := p_parent;
  v_seen   uuid[] := ARRAY[p_lot_id];
  v_parent uuid;
  v_stick  text;
  v_code   text;
  v_hops   int := 0;
BEGIN
  -- Common case: the lot wears its own sticker. No lineage read at all.
  v_label := public.lot_sticker_label(p_sticker);
  IF v_label IS NOT NULL THEN
    RETURN v_label;
  END IF;

  -- Nearest ancestor wins. Bounded twice over: the seen-set stops a cycle
  -- (0312 exists because relist chains have cycled on prod before) and the hop
  -- cap stops a pathological chain from pinning a read.
  WHILE v_cur IS NOT NULL AND NOT (v_cur = ANY (v_seen)) AND v_hops < 32 LOOP
    v_seen := v_seen || v_cur;
    v_hops := v_hops + 1;

    SELECT l.sticker_code, l.lot_code, l.relisted_from_lot_id
      INTO v_stick, v_code, v_parent
      FROM public.lots l
     WHERE l.id = v_cur;
    EXIT WHEN NOT FOUND;

    v_label := COALESCE(public.lot_sticker_label(v_stick), public.lot_legacy_label(v_code));
    IF v_label IS NOT NULL THEN
      RETURN v_label;
    END IF;

    v_cur := v_parent;
  END LOOP;

  RETURN p_lot_code;
END
$$;

-- ---------------------------------------------------------------------------
-- The PostgREST computed column.
--
-- A function whose single argument is the table's composite type is exposed by
-- PostgREST as a virtual column: `/lots?select=id,display_code`, and the same
-- name works inside an embed — `invoice_lots(lots(display_code))`. That is the
-- whole point: no caller has to remember to join `relisted_from` any more.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.display_code(public.lots)
RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT public.lot_resolve_display_code($1.id, $1.sticker_code, $1.lot_code, $1.relisted_from_lot_id)
$$;

COMMENT ON FUNCTION public.display_code(public.lots) IS
  'PostgREST computed column: the human-facing box label for a lot — own '
  'sticker, else nearest ancestor''s sticker/legacy lot_code, else lot_code. '
  'Select this instead of hand-resolving sticker_code/lot_code. Scan '
  'resolution still keys on sticker_code/lot_code.';

-- RLS on `lots` still governs which rows are visible; these only shape a value
-- already derived from a visible row plus its lineage.
GRANT EXECUTE ON FUNCTION public.lot_sticker_label(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lot_legacy_label(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lot_resolve_display_code(uuid, text, text, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.display_code(public.lots) TO anon, authenticated, service_role;

COMMIT;
