-- 0428 — new lots carry their load (lots.load_id), so the Loads page can count
--        what a load made.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- lots.load_id exists since 0148, but nothing ever sets it at creation: on prod
-- (2026-10-20) 0 of 40,903 lots have one, so every load shows 0 lots. The staff
-- app already lets a lotter pick a load for the shift (SessionContext
-- defaultLoadId), but no create path sends it. Manifest lotting records the
-- link the other way (import_rows.lot_id, 6,143 lots), and relisting never
-- copied a load at all.
--
-- ── WHAT THIS DOES (additive only — no existing function is rewritten) ─────
--   1. create_draft_lot/24: NEW overload = today's /23 (worker attribution,
--      0321) + p_load_id. Delegates to /23 in the same transaction, then stamps
--      lots.load_id when it is still NULL and the load belongs to the lot's
--      operator and is not archived. An unknown / foreign / archived load is
--      ignored, never raised: lotting is the floor's hot path (same rule as
--      0321's worker id). Existing arities (/22, /23) keep resolving to the
--      untouched functions; /24's extra argument has no default, so no call is
--      ambiguous (42725) — the pattern 0321 documents.
--   2. import_rows trigger: when a manifest row gets its lot (lot_id set), that
--      lot takes the manifest import's load if it has none. Fires inside
--      create_draft_lot's delegate, so the MANIFEST load wins over the shift's
--      pick (the /24 stamp only fills a NULL).
--   3. lots BEFORE INSERT trigger: a relist child (relisted_from_lot_id set,
--      load_id NULL) inherits its parent's load. Covers desk relists, staff
--      relots and auto-relist without touching relist_lot_into_auction.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
--   No backfill of existing lots (separate, dry-run first). No change to
--   loads, RLS, or any existing function body.
--
-- ── LOCKS ────────────────────────────────────────────────────────────────────
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on lots and on import_rows for a
-- moment (blocks writes, not reads). Rule 9: apply 05:00–07:00 CT.
--
-- Rollback: scripts/prod-rig/0428_ROLLBACK_lots_carry_load.sql

BEGIN;

-- ── 1. create_draft_lot/24 ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_draft_lot(
  p_operator_id        uuid,
  p_title              text,
  p_description        text,
  p_category           text,
  p_category_id        uuid,
  p_condition          lot_condition,
  p_msrp_cents         bigint,
  p_starting_bid_cents bigint,
  p_photo_urls         text[],
  p_external_code      text,
  p_source             text,
  p_brand              text,
  p_model              text,
  p_asin               text,
  p_fnsku              text,
  p_lpn                text,
  p_vendor             text,
  p_product_sku        text,
  p_site_sku           text,
  p_manufacture_sku    text,
  p_import_row_id      uuid,
  p_client_token       uuid,
  p_lotted_by_worker   uuid,
  p_load_id            uuid
)
RETURNS TABLE(out_id uuid, out_lot_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_out_id   UUID;
  v_out_code TEXT;
BEGIN
  -- Delegate to the /23 wrapper (0321): lot + worker attribution, same txn.
  SELECT c.out_id, c.out_lot_code
    INTO v_out_id, v_out_code
    FROM public.create_draft_lot(
      p_operator_id, p_title, p_description, p_category, p_category_id,
      p_condition, p_msrp_cents, p_starting_bid_cents, p_photo_urls,
      p_external_code, p_source, p_brand, p_model, p_asin, p_fnsku, p_lpn,
      p_vendor, p_product_sku, p_site_sku, p_manufacture_sku,
      p_import_row_id, p_client_token, p_lotted_by_worker
    ) AS c;

  -- Fill only a NULL: a manifest load (set by the import_rows trigger inside
  -- the delegate) or an earlier write wins. The load must be this lot's
  -- operator's and not archived; otherwise ignored — never blocks a lot.
  IF p_load_id IS NOT NULL AND v_out_id IS NOT NULL THEN
    UPDATE lots l
       SET load_id = p_load_id
     WHERE l.id = v_out_id
       AND l.load_id IS NULL
       AND EXISTS (
         SELECT 1 FROM loads ld
          WHERE ld.id = p_load_id
            AND ld.operator_id = l.operator_id
            AND ld.archived_at IS NULL
       );
  END IF;

  out_id := v_out_id;
  out_lot_code := v_out_code;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[], text,
  text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid, uuid
) IS
  '0428: create_draft_lot/23 (0321) + the shift''s load. Stamps lots.load_id '
  'only when NULL and the load is the lot''s operator''s and not archived; '
  'ignored otherwise, never raises. Manifest load (import_rows trigger) wins.';

REVOKE ALL ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[], text,
  text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[], text,
  text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid, uuid
) TO authenticated, service_role;

-- ── 2. manifest row → its import's load ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.import_rows_lot_takes_manifest_load()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.lot_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.lot_id IS NOT DISTINCT FROM NEW.lot_id THEN
    RETURN NEW;
  END IF;

  UPDATE lots l
     SET load_id = ld.id
    FROM loads ld
   WHERE l.id = NEW.lot_id
     AND l.load_id IS NULL
     AND ld.import_id = NEW.import_id
     AND ld.operator_id = l.operator_id;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.import_rows_lot_takes_manifest_load() IS
  '0428: when a manifest row is linked to a lot, the lot takes that import''s '
  'auto-import load (if it has none).';

DROP TRIGGER IF EXISTS import_rows_lot_takes_manifest_load ON public.import_rows;
CREATE TRIGGER import_rows_lot_takes_manifest_load
  AFTER INSERT OR UPDATE OF lot_id ON public.import_rows
  FOR EACH ROW EXECUTE FUNCTION public.import_rows_lot_takes_manifest_load();

-- ── 3. relist child inherits its parent's load ──────────────────────────────
CREATE OR REPLACE FUNCTION public.lots_inherit_load_on_relist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.load_id IS NULL AND NEW.relisted_from_lot_id IS NOT NULL THEN
    SELECT p.load_id INTO NEW.load_id
      FROM lots p
     WHERE p.id = NEW.relisted_from_lot_id;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.lots_inherit_load_on_relist() IS
  '0428: a relist child (relisted_from_lot_id) inherits its parent''s load '
  'when it has none — desk relist, staff relot and auto-relist alike.';

DROP TRIGGER IF EXISTS lots_inherit_load_on_relist ON public.lots;
CREATE TRIGGER lots_inherit_load_on_relist
  BEFORE INSERT ON public.lots
  FOR EACH ROW EXECUTE FUNCTION public.lots_inherit_load_on_relist();

COMMIT;
