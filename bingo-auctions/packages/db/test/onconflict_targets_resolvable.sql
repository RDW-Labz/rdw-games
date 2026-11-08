-- Contract test: every ON CONFLICT target the APPLICATION uses must be
-- resolvable by a PREDICATE-LESS conflict inference.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
-- On 2026-09-19 a manifest import failed in production with
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
-- for every untracked row. mig 0310 had created import_rows_source_key_uniq as
-- a PARTIAL unique index (… WHERE source_key IS NOT NULL). The application
-- reaches it through PostgREST/supabase-js:
--   .upsert(rows, { onConflict: 'operator_id,source_key' })
-- which emits `ON CONFLICT (operator_id, source_key)` with NO WHERE clause.
-- Postgres will not infer a PARTIAL index for ON CONFLICT unless the statement
-- repeats the index's predicate — and PostgREST cannot express one. So the
-- query the app actually sends could never match the index that existed.
--
-- The existing mig-0310 SQL test did not catch it because it spoke raw SQL,
-- where the predicate IS expressible, and even wrote it:
--   on conflict (operator_id, source_key) where source_key is not null …
-- It proved the database accepts a query the application can never send. That
-- is the same seam that bit us three times in one week: unit tests prove the
-- code builds the right query string; nothing proved the database would accept
-- the query PostgREST derives from it.
--
-- ── WHAT THIS ASSERTS ────────────────────────────────────────────────────────
-- For each (table, columns) the app upserts on, there must exist a unique
-- index that a PREDICATE-LESS `ON CONFLICT (columns)` can infer — i.e. a UNIQUE
-- index on EXACTLY those columns (as a set) with NO partial predicate and no
-- expression key. A PARTIAL or expression-only index does NOT count, because
-- PostgREST cannot name it. This is the exact condition that was violated.
--
-- The target list is maintained by hand from the codebase. Keep it in sync:
--   grep -rn "onConflict:" apps/operator-web/src --include='*.ts' --include='*.tsx'
-- A new upsert whose target is missing here is a gap, not a failure of this
-- test — add the row. A target here with no matching full unique index is the
-- bug this test is for.
--
-- Runs against the migrated CI database inside a ROLLED-BACK transaction.

\set ON_ERROR_STOP on

begin;

create temporary table _onconflict_targets (
  tbl   text not null,
  cols  text[] not null,
  used_by text not null
) on commit drop;

insert into _onconflict_targets (tbl, cols, used_by) values
  ('import_rows',             array['operator_id','tracking_number'], 'imports/actions.ts commitImport (tracked) + import-d2l-manifest.mjs'),
  ('import_rows',             array['operator_id','source_key'],      'imports/actions.ts commitImport (untracked) + import-d2l-manifest.mjs — the 2026-09-19 outage'),
  ('operator_shipping_config',array['operator_id'],                   'settings/fulfillment/actions.ts'),
  ('operator_bidder_relations',array['operator_id','bidder_id'],      'bidders/actions.ts'),
  ('product_lookups',         array['upc'],                           'imports/actions.ts catalog seed'),
  ('image_enrichment_jobs',   array['target_table','target_id'],      'imports/actions.ts image jobs'),
  ('pickup_lot_outcomes',     array['pickup_id','lot_id'],            'pickups/session/[token]/actions.ts'),
  ('auto_charge_jobs',        array['invoice_id'],                    'invoices/[id]/retry-auto-charge/route.ts'),
  ('product_cache_warm_jobs', array['upc'],                           'lib/queue.ts'),
  ('notifications_outbox',    array['idempotency_key'],               'cron/closing-soon.ts, add-card-nudge.ts, saved-searches.ts');

do $$
declare
  t       record;
  hit     boolean;
  missing text := '';
begin
  for t in select tbl, cols, used_by from _onconflict_targets loop
    -- The table itself must exist.
    if to_regclass('public.' || t.tbl) is null then
      missing := missing || format(E'\n  - %s(%s): table does not exist [%s]',
                                    t.tbl, array_to_string(t.cols, ','), t.used_by);
      continue;
    end if;

    -- Is there a UNIQUE, NON-partial, non-expression index on exactly this
    -- column set? indpred IS NULL rules out partial indexes; indexprs IS NULL
    -- rules out expression indexes (a predicate-less ON CONFLICT on bare
    -- columns cannot infer either). The key-column set must match exactly.
    select exists (
      select 1
      from pg_index i
      join pg_class c   on c.oid = i.indexrelid
      join pg_class rel on rel.oid = i.indrelid
      join pg_namespace n on n.oid = rel.relnamespace
      where n.nspname = 'public'
        and rel.relname = t.tbl
        and i.indisunique
        and i.indpred is null          -- not partial
        and i.indexprs is null         -- not an expression index
        and (
          select array_agg(a.attname::text order by a.attname::text)
          from unnest(i.indkey[0:i.indnkeyatts-1]) as k(attnum)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
        ) = (select array_agg(x order by x) from unnest(t.cols) as x)
    ) into hit;

    if not hit then
      missing := missing || format(
        E'\n  - %s ON CONFLICT (%s): no full UNIQUE index on exactly those columns (partial/expression indexes do NOT count) [used by %s]',
        t.tbl, array_to_string(t.cols, ','), t.used_by);
    end if;
  end loop;

  if missing <> '' then
    raise exception
      'onconflict-contract: % application upsert target(s) cannot be inferred by a predicate-less ON CONFLICT — PostgREST/supabase-js will 500 against them:%',
      (select count(*) from regexp_matches(missing, E'\n  -', 'g')), missing;
  end if;

  raise notice 'onconflict-contract: all % app upsert targets are resolvable',
    (select count(*) from _onconflict_targets);
end $$;

rollback;
