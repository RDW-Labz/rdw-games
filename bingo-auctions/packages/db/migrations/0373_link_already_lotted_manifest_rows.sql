-- 0373 — mark manifest rows lotted when their box is already a lot, so a
--        rescan can't mint a second lot.
--
-- ── WHAT HAPPENED ────────────────────────────────────────────────────────────
-- 89 pending import_rows carry a tracking number that is already a live lot's
-- external_code (exact, or the right 12 of a longer code). Those boxes were
-- lotted through the catalog path, which stored the scanned FedEx tracking as
-- external_code (stopped server-side by #381 on 2026-09-24; the newest such
-- lot is from 2026-09-11, so the set is not growing). Their manifest rows were
-- never flipped. Quick Lot probes pending rows first, so a rescan of any of
-- these boxes seeds a card from the manifest and saves a NEW lot. The new lot
-- takes the manifest's UPC, not the tracking number, so the
-- duplicate_external_code check never fires.
-- Found in docs/plans/PLAN-manifest-pending-trim-2026-09-24.md §2.3 / §6.1;
-- re-measured on prod 2026-09-28: still 89.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────
-- For each such row, the box's current lot is a matching live lot that is not
-- canceled and has no matching relist child (the tip of a relist chain).
--   • exactly 1 current lot (55 rows): status 'lotted', lot_id = that lot,
--     lotted_at = now(), as create_draft_lot flips a row.
--   • 10 more rows have exactly 1 current lot but are LEFT pending on review
--     (2026-09-28): 4 whose lot staff titled "Do not list" / "DELETE THIS!!",
--     and 6 whose lot names a clearly different real product than the manifest
--     row. Excluded by lot code below. Someone checks those boxes by hand.
--   • 2+ current lots (4 rows): the box already has duplicate lots. status
--     'lotted' with lot_id left NULL, so no further lot can be minted from the
--     manifest. Which lot is real is a warehouse decision, not this migration's.
--   • only canceled lots (20 rows): LEFT pending. Re-lotting a box whose lot
--     was canceled is legitimate, and the manifest pre-fill helps it.
--
-- ── WHAT THIS DOES NOT TOUCH ─────────────────────────────────────────────────
-- No lots. Only these import_rows columns: status, lot_id, lotted_at. Nothing
-- reads a lotted row back into lotting. Put-away, shelf and pickup don't read
-- import_rows.
--
-- ── REVERSIBLE ───────────────────────────────────────────────────────────────
-- Each changed row is first copied whole (to_jsonb) into
-- public._manifest_rows_already_lotted_20260928; the reversal at the bottom
-- puts status/lot_id/lotted_at back exactly.
--
-- Evidence for the 55 (prod, 2026-09-28): 43 name the same product; 11 carry
-- a title invented by the poisoned catalog lookup (the same fake title on 6-7
-- different boxes, or proven in 0372's list, or the barcode itself), where the
-- tracking number is the only real evidence; 1 is a disposed placeholder.
--
-- CONCURRENCY: create_draft_lot locks the import_row FOR UPDATE and, if lot_id
-- is already set, returns that lot instead of minting. A scan saved after this
-- commits therefore reuses the linked lot. A save that commits first flips the
-- row itself; this UPDATE then skips it and the post-check aborts the whole
-- migration. lock_timeout bounds the wait on a row a save is holding.
--
-- The capture must be exactly 55 linked + 4 unlinked or the migration aborts
-- (re-measure first: something moved). A database with none of these rows
-- (CI's fresh replay, a local reset) skips with a NOTICE. Idempotent: a rerun
-- finds no pending rows to capture and changes nothing.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS public._manifest_rows_already_lotted_20260928 (
  import_row_id  uuid PRIMARY KEY,
  target_lot_id  uuid,
  kind           text        NOT NULL CHECK (kind IN ('linked', 'ambiguous')),
  row_data       jsonb       NOT NULL,
  captured_at    timestamptz NOT NULL DEFAULT now()
);

DROP TABLE IF EXISTS pg_temp._0373_class;
CREATE TEMP TABLE _0373_class AS
WITH k AS (
  SELECT l.id AS lot_id, l.operator_id, l.external_code AS code
  FROM public.lots l
  WHERE l.deleted_at IS NULL AND l.external_code ~ '^[0-9]{12,}$'
  UNION
  SELECT l.id, l.operator_id, right(l.external_code, 12)
  FROM public.lots l
  WHERE l.deleted_at IS NULL AND l.external_code ~ '^[0-9]{13,}$'
), m AS (
  SELECT ir.id AS row_id, k.lot_id
  FROM k
  JOIN public.import_rows ir
    ON ir.operator_id = k.operator_id AND ir.tracking_number = k.code
  WHERE ir.status = 'pending'
), cur AS (
  SELECT m.row_id, m.lot_id
  FROM m JOIN public.lots l ON l.id = m.lot_id
  WHERE l.status::text <> 'canceled'
    AND NOT EXISTS (
      SELECT 1 FROM m m2 JOIN public.lots c ON c.id = m2.lot_id
      WHERE m2.row_id = m.row_id AND c.relisted_from_lot_id = m.lot_id
    )
)
SELECT r.row_id,
       count(c.lot_id) AS n_cur,
       (array_agg(c.lot_id) FILTER (WHERE c.lot_id IS NOT NULL))[1] AS one_lot
FROM (SELECT DISTINCT row_id FROM m) r
LEFT JOIN cur c USING (row_id)
GROUP BY r.row_id;

-- Borderline on review: leave these pending (their box keeps its manifest
-- pre-fill). Staff-flagged junk lots, then lots naming a different product.
DELETE FROM _0373_class c
USING public.lots l
WHERE l.id = c.one_lot AND c.n_cur = 1
  AND l.lot_code IN (
    'BIN-007965', 'BIN-005026', 'BIN-005973', 'BIN-010277',
    'BIN-010670', 'BIN-013303', 'BIN-010633', 'BIN-007911', 'BIN-015928', 'BIN-011434'
  );

INSERT INTO public._manifest_rows_already_lotted_20260928 (import_row_id, target_lot_id, kind, row_data)
SELECT ir.id,
       CASE WHEN c.n_cur = 1 THEN c.one_lot END,
       CASE WHEN c.n_cur = 1 THEN 'linked' ELSE 'ambiguous' END,
       to_jsonb(ir)
FROM _0373_class c
JOIN public.import_rows ir ON ir.id = c.row_id
WHERE c.n_cur >= 1
ON CONFLICT (import_row_id) DO NOTHING;

DO $$
DECLARE n_linked int; n_ambig int; n_total int;
BEGIN
  SELECT count(*) FILTER (WHERE kind = 'linked'), count(*) FILTER (WHERE kind = 'ambiguous'), count(*)
    INTO n_linked, n_ambig, n_total
  FROM public._manifest_rows_already_lotted_20260928;
  IF n_total = 0 AND NOT EXISTS (SELECT 1 FROM _0373_class) THEN
    RAISE NOTICE '0373: no pending manifest row matches a lot — nothing to link, skipping';
  ELSIF n_linked <> 55 OR n_ambig <> 4 THEN
    RAISE EXCEPTION '0373: captured % linked + % ambiguous, expected 55 + 4 — aborting', n_linked, n_ambig;
  END IF;
END $$;

UPDATE public.import_rows ir
SET status    = 'lotted',
    lot_id    = c.target_lot_id,
    lotted_at = now()
FROM public._manifest_rows_already_lotted_20260928 c
WHERE ir.id = c.import_row_id
  AND ir.status = 'pending';

DO $$
DECLARE left_over int;
BEGIN
  SELECT count(*) INTO left_over
  FROM public._manifest_rows_already_lotted_20260928 c
  JOIN public.import_rows ir ON ir.id = c.import_row_id
  WHERE ir.status <> 'lotted' OR ir.lot_id IS DISTINCT FROM c.target_lot_id;
  IF left_over <> 0 THEN
    RAISE EXCEPTION '0373: % captured rows did not flip — aborting', left_over;
  END IF;
END $$;

DROP TABLE IF EXISTS pg_temp._0373_class;

-- ── REVERSAL (run by hand only if needed) ────────────────────────────────────
-- Restores every captured row exactly, updated_at included. The touch trigger
-- would stamp now(), so it is off for this transaction only; DISABLE TRIGGER
-- takes a brief lock on import_rows, so run it outside lotting hours.
-- BEGIN;
-- ALTER TABLE public.import_rows DISABLE TRIGGER import_rows_touch_updated_at;
-- UPDATE public.import_rows ir
-- SET status     = c.row_data->>'status',
--     lot_id     = (c.row_data->>'lot_id')::uuid,
--     lotted_at  = (c.row_data->>'lotted_at')::timestamptz,
--     updated_at = (c.row_data->>'updated_at')::timestamptz
-- FROM public._manifest_rows_already_lotted_20260928 c
-- WHERE ir.id = c.import_row_id;
-- ALTER TABLE public.import_rows ENABLE TRIGGER import_rows_touch_updated_at;
-- COMMIT;
