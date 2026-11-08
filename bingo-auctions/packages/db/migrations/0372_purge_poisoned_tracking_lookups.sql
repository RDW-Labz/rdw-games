-- 0372 — remove 16 product_lookups rows Sonar invented for FedEx tracking numbers.
--
-- ── WHAT HAPPENED ────────────────────────────────────────────────────────────
-- A FedEx 12-digit tracking number is UPC-A length, and lookupByCode's UPC test
-- was length-only, so a tracking-number scan that missed the manifest went to
-- Sonar as if it were a UPC, and the invented product was cached here, keyed by
-- the tracking number. On 2026-09-24 prod held 16 such rows (every one keyed by
-- a tracking number on a BinGo manifest row), 13 with invented products
-- ("Doritos" for a Roman shade, "AirPods Pro 3" for a standing desk) and 3 empty.
-- #381 stops the lookup route serving or creating them; this removes the rows so
-- no other catalog reader (keyword/trigram search, enrichment) can surface them.
--
-- ── WHAT THIS DOES NOT TOUCH ─────────────────────────────────────────────────
-- No lots. product_lookups has no foreign keys; a lot copies a candidate's data
-- and keeps no reference to the row. Lots already created from these rows are a
-- separate, physical question (docs/audits/2026-09-24-poisoned-tracking-lookups.md).
--
-- ── REVERSIBLE ───────────────────────────────────────────────────────────────
-- Each row is first copied whole (to_jsonb) into
-- public._poisoned_tracking_lookups_20260924; the reversal at the bottom restores
-- exactly those rows. An off-database copy is in
-- docs/audits/2026-09-24-poisoned-tracking-lookups.json.
--
-- Fixed list of 16 keys, each re-checked against the manifest at run time. The
-- capture must be exactly 16 or the migration aborts. Idempotent: a rerun
-- captures nothing new and deletes nothing.
--
-- A database with none of the 16 keys in product_lookups (CI's fresh replay, a
-- local reset) skips with a NOTICE instead of aborting — there is nothing to
-- purge. Prod applied this 2026-09-24 with all 16 present; any other partial
-- count still aborts.

CREATE TABLE IF NOT EXISTS public._poisoned_tracking_lookups_20260924 (
  upc          text PRIMARY KEY,
  row_data     jsonb       NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TEMP TABLE _0372_keys (upc text PRIMARY KEY);
INSERT INTO _0372_keys (upc) VALUES
  ('486571079143'),
  ('486572265300'),
  ('529620018069'),
  ('529620025196'),
  ('533500043962'),
  ('533500212936'),
  ('533501372036'),
  ('533504094970'),
  ('538157106950'),
  ('538157394961'),
  ('538158200880'),
  ('538160936733'),
  ('538160989509'),
  ('798021078931'),
  ('798029540060'),
  ('798051984500');

INSERT INTO public._poisoned_tracking_lookups_20260924 (upc, row_data)
SELECT p.upc, to_jsonb(p)
FROM public.product_lookups p
WHERE p.upc IN (SELECT upc FROM _0372_keys)
  AND p.upc ~ '^[0-9]{12}$'
  AND EXISTS (SELECT 1 FROM public.import_rows r WHERE r.tracking_number = p.upc)
ON CONFLICT (upc) DO NOTHING;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public._poisoned_tracking_lookups_20260924;
  IF n = 0 AND NOT EXISTS (
    SELECT 1 FROM public.product_lookups p JOIN _0372_keys k USING (upc)
  ) THEN
    RAISE NOTICE '0372: none of the 16 keys are in product_lookups — nothing to purge, skipping';
  ELSIF n <> 16 THEN
    RAISE EXCEPTION '0372: captured % rows, expected exactly 16 — aborting', n;
  END IF;
END $$;

DELETE FROM public.product_lookups
WHERE upc IN (SELECT upc FROM public._poisoned_tracking_lookups_20260924);

DO $$
DECLARE left_over int;
BEGIN
  SELECT count(*) INTO left_over FROM public.product_lookups
  WHERE upc IN (SELECT upc FROM public._poisoned_tracking_lookups_20260924);
  IF left_over <> 0 THEN
    RAISE EXCEPTION '0372: % captured rows still in product_lookups — aborting', left_over;
  END IF;
END $$;

-- ── REVERSAL (run by hand only if needed) ────────────────────────────────────
-- INSERT INTO public.product_lookups
-- SELECT (jsonb_populate_record(NULL::public.product_lookups, c.row_data)).*
-- FROM public._poisoned_tracking_lookups_20260924 c
-- ON CONFLICT (upc) DO NOTHING;
