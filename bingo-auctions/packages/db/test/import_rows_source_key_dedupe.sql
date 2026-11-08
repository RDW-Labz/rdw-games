-- Behavioural test for mig 0310's untracked-manifest dedupe.
-- Plain-psql assertions, no pgTAP (matches scan_resolver_collision.sql).
--
-- The bug: import_rows_tracking_uniq is UNIQUE (operator_id, tracking_number),
-- and a plain UNIQUE btree treats NULLs as DISTINCT. Every box on a Wayfair
-- D2L manifest without a ReturnTrackingNumber therefore slipped past the
-- importer's ON CONFLICT and was re-inserted in full by the daily
-- import-d2l-folder workflow — 18,297 prod rows standing in for 923 real
-- units, growing +812/day.
--
-- 0310 keys the fix on UNIT IDENTITY. Four properties are easy to lose in a
-- refactor and are pinned here:
--
--   • the NULL hole itself. A second (operator_id, NULL) insert must now be
--     rejected by import_rows_source_key_uniq. If someone "simplifies" the
--     importer back to ON CONFLICT (operator_id, tracking_number), or drops
--     source_key, this test fails.
--
--   • multi-unit orders SURVIVE. One order_id + product_sku can carry many
--     physical units — prod has a group with 21 distinct unit_ids. Each unit
--     keys separately, so all of them persist.
--
--   • the UPC fan-out COLLAPSES. The legacy PascalCase manifests emit one row
--     per catalog-photo variant of the same unit — up to 500 for a single
--     ReturnedQuantity="1" item. Those share an ItemNumber and must collapse
--     to one row. This is the case mig 0309 got backwards.
--
--   • tracked rows are untouched. 233,800 rows that were never broken.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that
-- is ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

begin;

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- slug / contact_email / code are NOT NULL with no default — same column set
-- the other fixtures in this directory insert.
insert into operators (id, slug, business_name, contact_email, code, is_demo)
values ('00000000-0000-0000-0000-0000000009a1', 'srckeytest', 'Test Op 0310',
        'srckey@example.com', 'SKT', true)
on conflict (id) do nothing;

insert into imports (id, operator_id, filename, source_label, status)
values ('00000000-0000-0000-0000-0000000009b1',
        '00000000-0000-0000-0000-0000000009a1',
        'Harrison_ir_test.json', 'wayfair-d2l', 'completed');

-- ── 1. The index exists and is a FULL UNIQUE index ──────────────────────────
-- mig 0310 first built this PARTIAL (… WHERE source_key IS NOT NULL). mig 0364
-- rebuilt it WITHOUT the predicate, because the application reaches it through
-- PostgREST — `.upsert(..., { onConflict: 'operator_id,source_key' })` — which
-- emits `ON CONFLICT (operator_id, source_key)` with no WHERE, and Postgres
-- cannot infer a partial index from a predicate-less conflict clause. So the
-- index MUST be full, or the import 500s (the 2026-09-19 outage). NULLs stay
-- distinct in a btree, so tracked rows (source_key NULL) remain unconstrained.
do $$
begin
  if not exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where c.relname = 'import_rows_source_key_uniq'
      and i.indisunique
      and i.indpred is null   -- full, not partial — the whole point of 0364
  ) then
    raise exception
      '0310/0364: import_rows_source_key_uniq must be a FULL unique index (no WHERE predicate) so a predicate-less ON CONFLICT can infer it';
  end if;
end $$;

-- ── 2. Two units of the SAME sku+order both persist ─────────────────────────
-- The multi-unit case. Distinct unit_ids ⇒ distinct keys ⇒ two rows.
insert into import_rows
  (operator_id, import_id, title, order_id, product_sku, tracking_number, source_key, status)
values
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
   'Accent Chair', 'ORD-1', 'SKU-A', null, 'u:UNIT-0001', 'pending'),
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
   'Accent Chair', 'ORD-1', 'SKU-A', null, 'u:UNIT-0002', 'pending');

do $$
declare n int;
begin
  select count(*) into n from import_rows
   where order_id = 'ORD-1' and product_sku = 'SKU-A';
  if n <> 2 then
    raise exception '0310: multi-unit order collapsed — expected 2 rows, got %', n;
  end if;
end $$;

-- ── 3. Re-importing the SAME file is a no-op ────────────────────────────────
-- Identical source_keys, exactly what the importer regenerates tomorrow.
-- ON CONFLICT DO NOTHING is the importer's resolution=ignore-duplicates.
-- Predicate-less on purpose: it must match what PostgREST emits, not raw SQL.
insert into import_rows
  (operator_id, import_id, title, order_id, product_sku, tracking_number, source_key, status)
values
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
   'Accent Chair', 'ORD-1', 'SKU-A', null, 'u:UNIT-0001', 'pending'),
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
   'Accent Chair', 'ORD-1', 'SKU-A', null, 'u:UNIT-0002', 'pending')
on conflict (operator_id, source_key) do nothing;  -- predicate-less: exactly what PostgREST/supabase-js sends

do $$
declare n int;
begin
  select count(*) into n from import_rows
   where order_id = 'ORD-1' and product_sku = 'SKU-A';
  if n <> 2 then
    raise exception '0310: re-import duplicated untracked rows — expected 2, got %', n;
  end if;
end $$;

-- ── 4. The legacy UPC fan-out collapses to one row per unit ─────────────────
-- Same ItemNumber, different catalog photo/UPC — one physical unit. Prod's
-- worst case is 500 of these for a single ReturnedQuantity="1" item. mig 0309
-- kept all 500 and deleted the 21 real units beside them; the key must make
-- that structurally impossible.
insert into import_rows
  (operator_id, import_id, title, order_id, product_sku, tracking_number, source_key, status, raw_data)
values
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
   'Patio Set', 'ORD-4', 'SKU-C', null, 'nk:12170717039:0', 'pending',
   '{"ItemNumber":"12170717039","ReturnedQuantity":"1","ImageURL":"https://x/a.jpg"}'::jsonb)
on conflict (operator_id, source_key) do nothing;  -- predicate-less: exactly what PostgREST/supabase-js sends

insert into import_rows
  (operator_id, import_id, title, order_id, product_sku, tracking_number, source_key, status, raw_data)
values
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
   'Patio Set', 'ORD-4', 'SKU-C', null, 'nk:12170717039:0', 'pending',
   '{"ItemNumber":"12170717039","ReturnedQuantity":"1","ImageURL":"https://x/b.jpg"}'::jsonb)
on conflict (operator_id, source_key) do nothing;  -- predicate-less: exactly what PostgREST/supabase-js sends

do $$
declare n int;
begin
  select count(*) into n from import_rows where order_id = 'ORD-4';
  if n <> 1 then
    raise exception
      '0310: UPC fan-out was not collapsed — expected 1 row for one unit, got %', n;
  end if;
end $$;

-- ── 5. A legacy line with ReturnedQuantity > 1 keeps every unit ─────────────
-- Occurrence index spans the quantity, so a genuine 2-unit legacy line is two
-- rows — collapsing must key on the unit, not on the ItemNumber alone.
insert into import_rows
  (operator_id, import_id, title, order_id, product_sku, tracking_number, source_key, status, raw_data)
values
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
   'Bar Stool', 'ORD-5', 'SKU-D', null, 'nk:80158563980:0', 'pending',
   '{"ItemNumber":"80158563980","ReturnedQuantity":"2"}'::jsonb),
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
   'Bar Stool', 'ORD-5', 'SKU-D', null, 'nk:80158563980:1', 'pending',
   '{"ItemNumber":"80158563980","ReturnedQuantity":"2"}'::jsonb)
on conflict (operator_id, source_key) do nothing;  -- predicate-less: exactly what PostgREST/supabase-js sends

do $$
declare n int;
begin
  select count(*) into n from import_rows where order_id = 'ORD-5';
  if n <> 2 then
    raise exception
      '0310: multi-unit legacy line collapsed — expected 2 rows, got %', n;
  end if;
end $$;

-- ── 6. The NULL hole is actually closed ─────────────────────────────────────
-- Without ON CONFLICT this must RAISE. Pre-0310 it succeeded silently, which
-- is the entire bug.
do $$
begin
  begin
    insert into import_rows
      (operator_id, import_id, title, order_id, product_sku, tracking_number, source_key, status)
    values
      ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
       'Accent Chair', 'ORD-1', 'SKU-A', null, 'u:UNIT-0001', 'pending');
    raise exception '0310: duplicate source_key was accepted — NULL-tracking hole is still open';
  exception
    when unique_violation then null;  -- expected
  end;
end $$;

-- ── 7. Tracked rows dedupe on the tracking number, with NO source_key ───────
-- The population that was never broken must stay unbroken — and must stay OUT
-- of the partial index. mig 0310 skips a 233,800-row backfill on the strength
-- of that, and the importer posts these against their own conflict target, so
-- a change that starts writing source_key here needs to know it.
insert into import_rows
  (operator_id, import_id, title, order_id, tracking_number, status)
values
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
   'Side Table', 'ORD-2', '392482938403', 'pending');

do $$
begin
  begin
    insert into import_rows
      (operator_id, import_id, title, order_id, tracking_number, status)
    values
      ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
       'Side Table', 'ORD-2', '392482938403', 'pending');
    raise exception '0310: duplicate tracking number was accepted';
  exception
    when unique_violation then null;  -- expected
  end;
end $$;

-- Two tracked rows with NULL source_key must coexist: NULLs are DISTINCT in a
-- btree, so the full unique index (mig 0364) leaves them unconstrained, exactly
-- as the old partial index did. If either changed, every tracked insert after
-- the first would 23505.
insert into import_rows
  (operator_id, import_id, title, order_id, tracking_number, status)
values
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
   'Side Table B', 'ORD-2b', '392482938404', 'pending');

do $$
declare n int;
begin
  -- Scoped to this fixture's operator: the assertion must hold on a database
  -- that already has tracked rows, not just the empty CI one.
  select count(*) into n from import_rows
   where operator_id = '00000000-0000-0000-0000-0000000009a1'
     and tracking_number is not null and source_key is null;
  if n <> 2 then
    raise exception
      '0310: tracked rows are not both present with NULL source_key — got %', n;
  end if;
end $$;

-- ── 8. A genuinely new box still gets in ────────────────────────────────────
-- Guard against a fix that dedupes by refusing everything.
insert into import_rows
  (operator_id, import_id, title, order_id, product_sku, tracking_number, source_key, status)
values
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009b1',
   'Floor Lamp', 'ORD-3', 'SKU-B', null, 'u:UNIT-0003', 'pending')
on conflict (operator_id, source_key) do nothing;  -- predicate-less: exactly what PostgREST/supabase-js sends

do $$
declare n int;
begin
  select count(*) into n from import_rows where order_id = 'ORD-3';
  if n <> 1 then
    raise exception '0310: new untracked box was rejected — expected 1 row, got %', n;
  end if;
end $$;

rollback;
