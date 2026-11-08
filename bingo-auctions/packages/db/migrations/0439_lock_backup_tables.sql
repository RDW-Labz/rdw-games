-- 0439 — lock the three cleanup backup tables (#499 advisor audit).
--
-- WHY (read-only prod check 2026-10-21): these tables were created by data
-- migrations as reversal copies and never had RLS or grants set, so the
-- Supabase defaults left SELECT (and more) open to anon and authenticated —
-- anyone with the public key could read them over /rest/v1:
--   _catalog_misfire_20260921            347 rows  (0366: lot ids + prior status)
--   _manifest_rows_already_lotted_20260928 59 rows (0373: full import_rows copies:
--                                                   order_id, po_number, tracking_number,
--                                                   cost_cents, raw_data …)
--   _poisoned_tracking_lookups_20260924   16 rows  (0372: catalog rows, prices, comps)
--
-- WHAT: enable RLS with no policy (deny all for anon/authenticated) and revoke
-- every privilege from anon and authenticated. The owner (migrations, the
-- Management API, service_role scripts) keeps full access; the reversal blocks
-- in 0366/0372/0373 and scripts/correct-restored-lot-titles.mjs run as the owner,
-- so they are unaffected. No data changes.
-- CI replay: the three tables are created by 0366 (via its CI fixture), 0372 and 0373.
-- LOCKS: ALTER TABLE ... ENABLE ROW LEVEL SECURITY takes a brief ACCESS EXCLUSIVE
-- on each backup table only (no app reads them); lock_timeout 3s.
-- ROLLBACK: scripts/prod-rig/0439_ROLLBACK_lock_backup_tables.sql.
SET lock_timeout = '3s';

-- Plain statements (no DO/EXECUTE, so the guard lint can analyse them). This is
-- the same change prod received on 2026-10-22 from the DO-loop version
-- (identical effect); the repo keeps the lint-clean form.
ALTER TABLE public._catalog_misfire_20260921 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._manifest_rows_already_lotted_20260928 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._poisoned_tracking_lookups_20260924 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
  public._catalog_misfire_20260921,
  public._manifest_rows_already_lotted_20260928,
  public._poisoned_tracking_lookups_20260924
FROM anon, authenticated;
