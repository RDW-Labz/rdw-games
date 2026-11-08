-- Preflight for the 0382 snapshot table (issue #731).
--
-- Scope contract (issue #738): `dependent_views` and `dependent_functions` are
-- TRACKED CATALOG DEPENDENCIES only. PostgreSQL records a dependency when it
-- parses the referencing definition, so string-bodied readers (PL/pgSQL or
-- plain SQL function bodies, dynamic SQL) leave no pg_depend row and cannot be
-- ruled out by those sections alone.
--
-- `string_body_references` is a name-match heuristic over pg_proc.prosrc and
-- non-catalog view definitions. It catches the obvious string-bodied cases but
-- is still not proof: a reader that builds the table name at runtime will not
-- appear. Treat any non-empty string_body_references (or any catalog
-- dependency) as a reader to inspect before changing grants.
--
-- Each reader carries its fully qualified identity (schema + name + argument
-- signature for functions), so same-named readers in different schemas or
-- overloads cannot collapse into one entry under UNION.
SELECT json_build_object(
  'scope', 'tracked catalog dependencies + string-body name match; not a proof that no reader exists',
  'exists', to_regclass('public._stranded_closed_auction_drafts_20260930') IS NOT NULL,
  'rows', (SELECT count(*) FROM public._stranded_closed_auction_drafts_20260930),
  'rls_enabled', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public._stranded_closed_auction_drafts_20260930')),
  'rls_forced', (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public._stranded_closed_auction_drafts_20260930')),
  'policies', (SELECT coalesce(json_agg(policyname), '[]'::json) FROM pg_policies WHERE schemaname = 'public' AND tablename = '_stranded_closed_auction_drafts_20260930'),
  'grants', (SELECT coalesce(json_agg(json_build_object('grantee', grantee, 'privilege', privilege_type)), '[]'::json) FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = '_stranded_closed_auction_drafts_20260930'),
  'dependent_views', (SELECT coalesce(json_agg(distinct v.relname), '[]'::json) FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class v ON v.oid = r.ev_class WHERE d.refobjid = to_regclass('public._stranded_closed_auction_drafts_20260930') AND v.oid <> to_regclass('public._stranded_closed_auction_drafts_20260930')),
  'dependent_functions', (SELECT coalesce(json_agg(distinct p.proname), '[]'::json) FROM pg_depend d JOIN pg_proc p ON p.oid = d.objid WHERE d.refobjid = to_regclass('public._stranded_closed_auction_drafts_20260930') AND d.deptype = 'n'),
  'string_body_references', (
    SELECT coalesce(
      json_agg(
        json_build_object(
          'kind', kind,
          'schema', schema_name,
          'name', name,
          'arguments', arguments,
          'identity', identity
        )
        ORDER BY kind, schema_name, name, arguments
      ),
      '[]'::json
    )
    FROM (
      SELECT
        'function' AS kind,
        n.nspname AS schema_name,
        p.proname AS name,
        pg_get_function_identity_arguments(p.oid) AS arguments,
        format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS identity
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         -- Anchored literal (issue #749): `LIKE 'pg_toast%'` treats `_` as a
         -- single-character wildcard and would also hide a real schema such as
         -- `pgxtoast`, so exclude only genuinely system toast schemas.
         AND n.nspname !~ '^pg_toast'
         AND p.prosrc ILIKE '%_stranded_closed_auction_drafts_20260930%'
      UNION
      SELECT
        'view' AS kind,
        v.schemaname AS schema_name,
        v.viewname AS name,
        ''::text AS arguments,
        format('%I.%I', v.schemaname, v.viewname) AS identity
        FROM pg_views v
       WHERE v.schemaname NOT IN ('pg_catalog', 'information_schema')
         AND v.definition ILIKE '%_stranded_closed_auction_drafts_20260930%'
    ) readers
  )
) AS result;
