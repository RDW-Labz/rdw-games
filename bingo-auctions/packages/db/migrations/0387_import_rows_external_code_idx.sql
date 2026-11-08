-- 0387 — import_rows: index external_code for the 'auto' manifest probe.
--
-- After 0386 the tracking probe is indexed, but the default 'auto' scan path
-- (find_import_row_by_scan(text[]), what the staff app sends unless a field
-- chip is pinned) also probes lpn, fnsku, asin, upc, external_code, pallet_id
-- and the three SKU columns on the raw candidate. Every one of those has an
-- index except external_code, so a miss or a long composite still read the
-- whole heap once per candidate: 2.2 s per probe on prod 2026-10-05 14:58 CT
-- (34-digit FedEx scan in 'auto': 2.4 s; miss: 2.2 s; 'tracking' kind: <30 ms).
-- Three candidates per label scan puts 'auto' back near the 8 s timeout.
--
-- Same shape as the other identity indexes (0186): partial on non-null.
-- Rollback: DROP INDEX IF EXISTS public.import_rows_external_code_idx;

BEGIN;

CREATE INDEX IF NOT EXISTS import_rows_external_code_idx
  ON public.import_rows (operator_id, external_code)
  WHERE external_code IS NOT NULL;

COMMIT;
