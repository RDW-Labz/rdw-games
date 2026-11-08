-- Rollback for 0428_lots_carry_load.sql — standby only.
-- Drops the /24 overload and both triggers. /22 and /23 are untouched by 0428,
-- so lotting keeps working; app builds that call /24 fall back to /23 on
-- "function not found" (packages/domain-lotting persistence). lots.load_id
-- values already written stay (data); clear them separately if wanted.
BEGIN;
DROP TRIGGER IF EXISTS lots_inherit_load_on_relist ON public.lots;
DROP FUNCTION IF EXISTS public.lots_inherit_load_on_relist();
DROP TRIGGER IF EXISTS import_rows_lot_takes_manifest_load ON public.import_rows;
DROP FUNCTION IF EXISTS public.import_rows_lot_takes_manifest_load();
DROP FUNCTION IF EXISTS public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[], text,
  text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid, uuid
);
COMMIT;
