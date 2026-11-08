-- 0310 — Dedupe untracked import_rows on UNIT IDENTITY, superseding 0309's
--        count-based heuristic.
--
-- WHY THIS EXISTS
-- ───────────────
-- 0309 diagnosed the right bug (a plain UNIQUE btree treats NULLs as distinct,
-- so `on_conflict=operator_id,tracking_number` never fires for untracked boxes
-- and the daily import-d2l-folder run re-inserts every one of them) but keyed
-- the cleanup on the wrong thing: per (operator_id, order_id, product_sku) it
-- kept K rows, where K = the largest number of copies ever seen in a single
-- day. That treats "how many rows arrived today" as a proxy for "how many
-- physical boxes exist". It isn't one.
--
-- 0309 was merged (PR #227) but never applied — no import_rows.source_key
-- column exists on prod. This migration replaces it wholesale rather than
-- correcting it afterwards, because applying 0309 first would actively destroy
-- data (see THE 500-ROW GROUP below). It is written to be safe and idempotent
-- whether or not 0309 ever ran: it recomputes source_key for every untracked
-- row and rebuilds the unique index from scratch.
--
-- WHY source_key IS UNTRACKED-ONLY
-- ────────────────────────────────
-- The first cut of this file also set source_key = tracking_number on all
-- 233,800 tracked rows, for symmetry. That is 93% of the table, and
-- import_rows carries 18 indexes across 405 MB — two of them trigram GIN
-- (title, brand). The rewrite ran over two minutes and the apply died on a
-- Cloudflare 524 (the Management API that `Apply DB Migration` posts through
-- caps a request around 100s). Prod rolled the whole transaction back, so
-- nothing partial landed — run 30848753689, 2026-08-03.
--
-- The fix is not a bigger timeout; it is noticing the work was pointless.
-- Tracked rows were NEVER broken: import_rows_tracking_uniq already enforces
-- one row per (operator_id, tracking_number), and that index stays. Giving
-- them a second, redundant key bought nothing and cost a full-table rewrite.
-- So source_key is now the untracked population's key ONLY — 923 rows instead
-- of 252,097 — and the importer keeps posting tracked rows against
-- on_conflict=operator_id,tracking_number, which has always worked for them.
--
-- THE REAL KEY
-- ────────────
-- Two different producers write untracked rows, and they fail differently:
--
--   snake_case export (lotting_export.json) → raw_data.unit_id present.
--     One entry per physical unit, already unique per run. Re-imported daily:
--     17,046 rows carrying only 812 distinct unit_ids.
--
--   PascalCase export (Harrison_ir_*.json)  → no unit_id; raw_data.ItemNumber
--     + raw_data.ReturnedQuantity. Fans out one unit into one entry per UPC /
--     catalog-photo variant: 1,251 rows for 226 units. The extreme case is one
--     unit that appears 500 times, identical on every business field, varying
--     only in ImageURL.
--
-- So the unit key is unit_id when present, else ItemNumber, and the unit COUNT
-- for a fanned-out ItemNumber is ReturnedQuantity — not the row count.
--
-- WHY 0309's HEURISTIC WOULD HAVE MADE THINGS WORSE
-- ─────────────────────────────────────────────────
-- THE 500-ROW GROUP: order 3266081475 / sku VFHD6543 holds 521 untracked rows
-- — 500 legacy fan-out rows for ONE unit (ReturnedQuantity = "1"), plus 21
-- daily re-imports of ONE modern unit. All 500 legacy rows share a single
-- created_at date, so 0309 computes K = 500 for that group and keeps the 500
-- EARLIEST rows. The legacy fan-out predates the modern export, so 0309 keeps
-- 500 phantom copies and deletes every modern row — losing the unit outright.
--
-- Simulated against prod (0309's own algorithm, read-only), it would keep
-- 1,896 rows:
--     1,207 legacy phantom rows
--       689 of the 812 real units
--   ⇒   123 REAL UNITS DESTROYED, and 16,357 modern rows deleted
-- i.e. the operator's manifest pool would end up majority-phantom while 123
-- genuine boxes silently vanished from it.
--
-- MEASURED ON PROD AT AUTHORING TIME (2026-08-03)
-- ───────────────────────────────────────────────
--   tracking_number NOT NULL : 233,800 rows / 233,800 distinct  ← never broken
--   tracking_number IS  NULL :  18,297 rows
--     ├─ modern (unit_id)    :  17,046 rows →   812 units  (daily re-import)
--     └─ legacy (ItemNumber) :   1,251 rows →   226 units  (UPC fan-out)
--   all 18,297 are status='pending' with lot_id IS NULL (guards below verified)
--
--   after this migration    :     923 rows kept / 17,374 deleted
--     ├─ modern             :     812 (one per unit_id)
--     └─ legacy-only        :     111 (115 of the 226 legacy units are also
--                                  present in the modern export, which is
--                                  authoritative; those legacy rows go)
--
-- NOTE ON THE 111: summing ReturnedQuantity over the legacy-only units gives
-- 138, but only 111 rows exist to keep — 11 units were under-imported at the
-- source (ReturnedQuantity 2+, one row landed). This migration keeps
-- least(quantity, rows_present). Deduping must not invent inventory; the
-- under-import is a separate defect in the producer and is left visible.

begin;

-- ── 0. Classify every untracked row once ────────────────────────────────────
-- Materialized so each step below sees the same classification even as rows
-- are deleted out from under it.
create temporary table _untracked on commit drop as
select
  r.id,
  r.operator_id,
  r.created_at,
  nullif(r.raw_data->>'unit_id', '') as unit_id,
  -- Unit key for rows with no unit_id. ItemNumber is present on 100% of the
  -- legacy population on prod; the order/sku fallback exists so a future row
  -- with neither still gets a distinct, derivable key instead of colliding.
  coalesce(
    nullif(r.raw_data->>'item_number', ''),
    nullif(r.raw_data->>'ItemNumber', ''),
    'o:' || coalesce(r.order_id, '') || ':' || coalesce(r.product_sku, '')
  ) as item_no,
  -- ReturnedQuantity is the true unit count behind a fanned-out ItemNumber.
  -- Regex-guarded: a non-numeric value must not abort the migration.
  case
    when r.raw_data->>'ReturnedQuantity' ~ '^[0-9]+$'
      then greatest((r.raw_data->>'ReturnedQuantity')::int, 1)
    when r.raw_data->>'returned_quantity' ~ '^[0-9]+$'
      then greatest((r.raw_data->>'returned_quantity')::int, 1)
    else 1
  end as qty
from import_rows r
where r.tracking_number is null;

create index on _untracked (operator_id, unit_id);
create index on _untracked (operator_id, item_no);

-- Hard guards, asserted rather than assumed. lots.import_row_id is
-- ON DELETE SET NULL, so deleting a worked row would silently sever a real lot
-- from its manifest provenance instead of failing loudly.
do $$
declare bad int;
begin
  select count(*) into bad
  from import_rows r
  join _untracked u on u.id = r.id
  where r.status is distinct from 'pending' or r.lot_id is not null;

  if bad > 0 then
    raise exception
      '0310: % untracked import_rows are lotted or non-pending; refusing to '
      'delete operator-worked rows. Investigate before re-running.', bad;
  end if;
end $$;

-- ── 1. Legacy rows whose unit is also in the modern export ──────────────────
-- The modern export carries real per-unit identity (and the correct
-- multiplicity — 782 item_numbers across 812 unit_ids, so it does represent
-- multi-unit lines). Where both exist for the same item, legacy is a strictly
-- worse duplicate of the same physical unit.
delete from import_rows d
using _untracked u
where d.id = u.id
  and u.unit_id is null
  and exists (
    select 1 from _untracked m
    where m.operator_id = u.operator_id
      and m.unit_id is not null
      and m.item_no = u.item_no
  )
  and d.tracking_number is null
  and d.status = 'pending'
  and d.lot_id is null;

-- ── 2. Collapse the legacy UPC fan-out ──────────────────────────────────────
-- Per remaining (operator_id, item_no), keep least(ReturnedQuantity, rows) —
-- earliest first. Genuine multi-unit legacy lines keep their units; the
-- photo-variant clones go.
with ranked as (
  select u.id,
         u.qty,
         count(*) over (partition by u.operator_id, u.item_no) as avail,
         row_number() over (
           partition by u.operator_id, u.item_no
           order by u.created_at, u.id
         ) as rn
  from _untracked u
  where u.unit_id is null
    and not exists (
      select 1 from _untracked m
      where m.operator_id = u.operator_id
        and m.unit_id is not null
        and m.item_no = u.item_no
    )
)
delete from import_rows d
using ranked
where d.id = ranked.id
  and ranked.rn > least(ranked.qty, ranked.avail)
  and d.tracking_number is null
  and d.status = 'pending'
  and d.lot_id is null;

-- ── 3. Collapse the modern daily re-imports ─────────────────────────────────
-- unit_id IS the physical unit. One row each, earliest wins.
with ranked as (
  select u.id,
         row_number() over (
           partition by u.operator_id, u.unit_id
           order by u.created_at, u.id
         ) as rn
  from _untracked u
  where u.unit_id is not null
)
delete from import_rows d
using ranked
where d.id = ranked.id
  and ranked.rn > 1
  and d.tracking_number is null
  and d.status = 'pending'
  and d.lot_id is null;

-- ── 4. Stable natural key ───────────────────────────────────────────────────
alter table import_rows add column if not exists source_key text;

comment on column import_rows.source_key is
  'Stable per-unit natural key for UNTRACKED rows only, identical across '
  're-imports of the same source file: ''u:<unit_id>'' when the producer '
  'supplies one, else ''nk:<item_number>:<occurrence>'' where occurrence spans '
  'ReturnedQuantity. Enforced by import_rows_source_key_uniq; importers must '
  'target it in ON CONFLICT for untracked rows. Deliberately NULL on tracked '
  'rows — import_rows_tracking_uniq already keys those, and backfilling 233,800 '
  'redundant values rewrote 93% of a 405 MB / 18-index table for no gain. See '
  'mig 0310.';

-- Tracked rows must hold NO source_key, so the partial unique index below
-- covers the untracked population alone. Matches 0 rows on prod (the column is
-- new) — it costs one scan and no index churn, and it makes the invariant true
-- rather than assumed, including on a database where 0309 or an earlier cut of
-- this file had written tracking numbers here.
update import_rows
   set source_key = null
 where tracking_number is not null
   and source_key is not null;

-- Recomputed unconditionally (not `where source_key is null`) so this is
-- idempotent and so it repairs the keys 0309 would have written if it ever ran.
update import_rows r
   set source_key = 'u:' || u.unit_id
  from _untracked u
 where u.id = r.id
   and u.unit_id is not null
   and r.source_key is distinct from 'u:' || u.unit_id;

-- Survivors of step 2, re-ranked over what actually remains.
with occ as (
  select u.id,
         u.item_no,
         row_number() over (
           partition by u.operator_id, u.item_no
           order by u.created_at, u.id
         ) - 1 as idx
  from _untracked u
  join import_rows r on r.id = u.id   -- deleted rows are gone from import_rows
  where u.unit_id is null
)
update import_rows r
   set source_key = 'nk:' || occ.item_no || ':' || occ.idx
  from occ
 where occ.id = r.id
   and r.source_key is distinct from 'nk:' || occ.item_no || ':' || occ.idx;

-- ── 5. Enforce it ───────────────────────────────────────────────────────────
-- Partial so any row that somehow yields no derivable key stays legal rather
-- than blocking the migration. Dropped first so a rebuild is a clean rebuild.
drop index if exists import_rows_source_key_uniq;
create unique index import_rows_source_key_uniq
  on import_rows (operator_id, source_key)
  where source_key is not null;

-- import_rows_tracking_uniq is deliberately LEFT IN PLACE: it still correctly
-- enforces one-row-per-tracking-number, and dropping it would weaken the
-- tracked population that was never broken.

commit;
