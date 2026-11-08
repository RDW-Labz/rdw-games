-- CI scratch database ONLY. Exercise the unchanged historical cleanup against
-- one synthetic eligible lot, then remove every fixture row. Its capture-table
-- DDL remains in the schema. Never run this against an application database.
\set ON_ERROR_STOP on
\if :{?bingo_empty_ci_fixture}
SELECT :'bingo_empty_ci_fixture' = '0366_schema_only' AS fixture_authorized \gset
\else
\set fixture_authorized false
\endif
\if :fixture_authorized
\else
DO $$ BEGIN RAISE EXCEPTION '0366 fixture requires explicit CI scratch marker'; END $$;
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.operators, public.lots IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.operators)
     OR EXISTS (SELECT 1 FROM public.lots)
     OR to_regclass('public._catalog_misfire_20260921') IS NOT NULL THEN
    RAISE EXCEPTION '0366 fixture refuses nonempty or previously prepared database';
  END IF;
END $$;

-- The historical predicate pins this operator UUID. These are synthetic rows,
-- not production data; no auth user, warehouse, sticker or physical item exists.
INSERT INTO public.operators (id, slug, business_name, contact_email, code)
VALUES ('05775af4-adb7-4f0f-943e-94a91e17f60d', 'ci-0366-fixture',
        'CI migration fixture', 'ci-0366@example.invalid', 'CI0366');
INSERT INTO public.lots (id, operator_id, lot_code, title, status, created_at)
VALUES ('03660000-0000-0000-0000-000000000001',
        '05775af4-adb7-4f0f-943e-94a91e17f60d', 'CI0366-000001',
        'Synthetic unprinted CI fixture', 'pending_intake',
        '2026-09-21 12:00:00+00'::timestamptz);

\ir ../../packages/db/migrations/0366_softdelete_catalog_misfire_20260921.sql

DO $$ BEGIN
  IF (SELECT count(*) FROM public._catalog_misfire_20260921) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public._catalog_misfire_20260921 AS capture
       JOIN public.lots AS lot ON lot.id = capture.lot_id
       WHERE lot.id = '03660000-0000-0000-0000-000000000001'
         AND lot.deleted_at IS NOT NULL
         AND lot.status = 'pending_intake'
         AND capture.prev_status = 'pending_intake'
     ) THEN
    RAISE EXCEPTION '0366 failed to capture and soft-delete exactly the synthetic lot';
  END IF;
END $$;

DELETE FROM public._catalog_misfire_20260921
WHERE lot_id = '03660000-0000-0000-0000-000000000001';
DELETE FROM public.lots WHERE id = '03660000-0000-0000-0000-000000000001';
-- Default operator policy and lot status history use ON DELETE CASCADE.
DELETE FROM public.operators WHERE id = '05775af4-adb7-4f0f-943e-94a91e17f60d';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.operators)
     OR EXISTS (SELECT 1 FROM public.lots)
     OR EXISTS (SELECT 1 FROM public._catalog_misfire_20260921) THEN
    RAISE EXCEPTION '0366 fixture cleanup left rows behind';
  END IF;
END $$;
COMMIT;
\echo '0366 original migration exercised; synthetic rows removed; capture schema retained'
