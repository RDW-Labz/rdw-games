-- 0309 — SUPERSEDED BY 0310. Intentionally a no-op.
--
-- This migration was merged (PR #227) but never applied to any database. Its
-- diagnosis was right — a plain UNIQUE btree treats NULLs as distinct, so the
-- importer's `on_conflict=operator_id,tracking_number` never fires for
-- untracked boxes and the daily import-d2l-folder run re-inserts every one of
-- them — but its cleanup keyed on the wrong thing.
--
-- It deduped per (operator_id, order_id, product_sku), keeping K rows where
-- K = the largest number of copies seen in a single day, i.e. it used "how
-- many rows arrived today" as a proxy for "how many physical boxes exist".
--
-- That proxy fails on the legacy PascalCase manifests, which fan one unit out
-- into one row per UPC/photo variant. Order 3266081475 / sku VFHD6543 holds
-- 521 untracked rows: 500 same-day legacy clones of a single unit
-- (ReturnedQuantity = "1") plus 21 daily re-imports of one modern unit. This
-- migration computes K = 500 for that group and keeps the 500 EARLIEST rows —
-- the legacy clones — deleting every modern row and losing the unit.
--
-- Simulated against prod, running this file would keep 1,896 rows: 1,207
-- legacy phantoms and only 689 of the 812 real units. 123 real units would be
-- destroyed.
--
-- Body removed rather than left runnable: PR #227's deploy note tells an
-- operator to run this file via `Apply DB Migration` → mode=rerun, and doing
-- so would destroy real inventory. The correct, unit-identity-keyed cleanup is
-- 0310_import_rows_unit_identity_dedupe.sql — run that instead. 0310 creates
-- import_rows.source_key and import_rows_source_key_uniq itself and is safe to
-- run whether or not this file was ever executed.

do $$
begin
  raise notice
    '0309 is a no-op: superseded by 0310_import_rows_unit_identity_dedupe.sql. '
    'Run 0310 to dedupe untracked import_rows.';
end $$;
