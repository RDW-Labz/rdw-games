-- Test for issue #738: the 0382 snapshot preflight must not claim a complete
-- reader audit, and must surface an obvious string-bodied reader that
-- pg_depend cannot see.
--
-- The CI database is built from all migrations, so 0382 has already created
-- public._stranded_closed_auction_drafts_20260930 and 0490 has locked it down.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

CREATE OR REPLACE FUNCTION public._test_738_string_reader()
RETURNS bigint
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN (SELECT count(*) FROM public._stranded_closed_auction_drafts_20260930);
END
$$;

-- Issue #740: same-named readers must stay distinguishable. Create a
-- same-named reader in another schema and two overloads in public.
CREATE SCHEMA IF NOT EXISTS _test_740_alt;

CREATE OR REPLACE FUNCTION _test_740_alt._test_738_string_reader()
RETURNS bigint
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN (SELECT count(*) FROM public._stranded_closed_auction_drafts_20260930);
END
$$;

CREATE OR REPLACE FUNCTION public._test_740_reader(p_offset bigint)
RETURNS bigint
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN (SELECT count(*) FROM public._stranded_closed_auction_drafts_20260930) + p_offset;
END
$$;

CREATE OR REPLACE FUNCTION public._test_740_reader(p_label text)
RETURNS bigint
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN (SELECT count(*) FROM public._stranded_closed_auction_drafts_20260930) + length(p_label);
END
$$;

-- Issue #749: the system toast-schema exclusion must be anchored. `_` is a
-- LIKE wildcard, so the old `NOT LIKE 'pg_toast%'` filter also hid a real
-- user schema whose name merely resembles `pg_toast`.
CREATE SCHEMA IF NOT EXISTS pgxtoast;

CREATE OR REPLACE FUNCTION pgxtoast._test_749_toast_reader()
RETURNS bigint
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN (SELECT count(*) FROM public._stranded_closed_auction_drafts_20260930);
END
$$;

\o /tmp/tracked_catalog_preflight_738.json
\i scripts/prod-rig/0731-preflight.sql
\o
\set preflight_out `cat /tmp/tracked_catalog_preflight_738.json`

SELECT (:'preflight_out'::jsonb ->> 'scope') ILIKE '%not a proof%' AS scope_is_explicit \gset
\if :scope_is_explicit
\else
  DO $$ BEGIN RAISE EXCEPTION 'tracked_catalog_preflight: scope label does not say tracked-only / not a proof'; END $$;
\endif

-- The synthetic reader has no pg_depend row: only the string-body heuristic
-- can report it, and it must do so.
SELECT (:'preflight_out'::jsonb -> 'string_body_references') @> '[{"kind":"function","name":"_test_738_string_reader"}]'::jsonb AS found_reader \gset
\if :found_reader
\else
  DO $$ BEGIN RAISE EXCEPTION 'tracked_catalog_preflight: synthetic string-bodied reader was not reported'; END $$;
\endif

-- It must not claim the reader is a tracked catalog dependency.
SELECT coalesce((:'preflight_out'::jsonb -> 'dependent_functions') @> '["_test_738_string_reader"]'::jsonb, false) AS falsely_tracked \gset
\if :falsely_tracked
  DO $$ BEGIN RAISE EXCEPTION 'tracked_catalog_preflight: string-bodied reader was reported as a tracked dependency'; END $$;
\endif

-- Issue #741: dependent_functions must exist as a JSON array. A missing key or
-- JSON null must fail rather than slip through a containment check.
SELECT coalesce(jsonb_typeof((:'preflight_out'::jsonb) -> 'dependent_functions') = 'array', false) AS dependent_functions_is_array \gset
\if :dependent_functions_is_array
\else
  DO $$ BEGIN RAISE EXCEPTION 'tracked_catalog_preflight: dependent_functions must be a JSON array'; END $$;
\endif

-- Cover the empty case: the synthetic string-bodied reader leaves no tracked
-- catalog dependency, so the array must be present but empty.
SELECT (:'preflight_out'::jsonb -> 'dependent_functions') = '[]'::jsonb AS dependent_functions_is_empty \gset
\if :dependent_functions_is_empty
\else
  DO $$ BEGIN RAISE EXCEPTION 'tracked_catalog_preflight: expected an empty dependent_functions array when there are no tracked dependents'; END $$;
\endif

-- Issue #740: each reported reader carries its fully qualified identity, so
-- same-named readers in another schema or as overloads are distinct entries.
SELECT ((:'preflight_out'::jsonb -> 'string_body_references') @> '[{"kind":"function","schema":"public","name":"_test_738_string_reader","arguments":"","identity":"public._test_738_string_reader()"}]'::jsonb) AS public_reader_identified \gset
\if :public_reader_identified
\else
  DO $$ BEGIN RAISE EXCEPTION 'tracked_catalog_preflight: public reader is missing schema/signature identity'; END $$;
\endif

SELECT ((:'preflight_out'::jsonb -> 'string_body_references') @> '[{"kind":"function","schema":"_test_740_alt","name":"_test_738_string_reader","arguments":"","identity":"_test_740_alt._test_738_string_reader()"}]'::jsonb) AS schema_reader_identified \gset
\if :schema_reader_identified
\else
  DO $$ BEGIN RAISE EXCEPTION 'tracked_catalog_preflight: same-named reader in another schema was not identified by schema'; END $$;
\endif

SELECT ((:'preflight_out'::jsonb -> 'string_body_references') @> '[{"kind":"function","schema":"public","name":"_test_740_reader","arguments":"p_offset bigint","identity":"public._test_740_reader(p_offset bigint)"}]'::jsonb) AS bigint_overload_identified \gset
\if :bigint_overload_identified
\else
  DO $$ BEGIN RAISE EXCEPTION 'tracked_catalog_preflight: bigint overload was not identified by argument signature'; END $$;
\endif

SELECT ((:'preflight_out'::jsonb -> 'string_body_references') @> '[{"kind":"function","schema":"public","name":"_test_740_reader","arguments":"p_label text","identity":"public._test_740_reader(p_label text)"}]'::jsonb) AS text_overload_identified \gset
\if :text_overload_identified
\else
  DO $$ BEGIN RAISE EXCEPTION 'tracked_catalog_preflight: text overload was not identified by argument signature'; END $$;
\endif

-- Issue #749: a non-system schema that matches `pg_toast` only because `_` is a
-- LIKE wildcard must still be discovered, with its fully qualified identity.
SELECT ((:'preflight_out'::jsonb -> 'string_body_references') @> '[{"kind":"function","schema":"pgxtoast","name":"_test_749_toast_reader","arguments":"","identity":"pgxtoast._test_749_toast_reader()"}]'::jsonb) AS toast_like_reader_identified \gset
\if :toast_like_reader_identified
\else
  DO $$ BEGIN RAISE EXCEPTION 'tracked_catalog_preflight: reader in a pg_toast-like user schema was hidden by an unanchored LIKE filter'; END $$;
\endif

SELECT count(*) = 2 AS overloads_not_collapsed
  FROM jsonb_array_elements(:'preflight_out'::jsonb -> 'string_body_references') e
 WHERE e ->> 'name' = '_test_740_reader' \gset
\if :overloads_not_collapsed
\else
  DO $$ BEGIN RAISE EXCEPTION 'tracked_catalog_preflight: same-named overloads collapsed under UNION'; END $$;
\endif

SELECT count(*) = count(DISTINCT e ->> 'identity') AS identities_unique
  FROM jsonb_array_elements(:'preflight_out'::jsonb -> 'string_body_references') e \gset
\if :identities_unique
\else
  DO $$ BEGIN RAISE EXCEPTION 'tracked_catalog_preflight: string_body_references contains duplicate reader identities'; END $$;
\endif

DROP FUNCTION public._test_738_string_reader();
DROP FUNCTION public._test_740_reader(bigint);
DROP FUNCTION public._test_740_reader(text);
DROP SCHEMA _test_740_alt CASCADE;
DROP SCHEMA pgxtoast CASCADE;

\echo 'tracked_catalog_preflight: all checks passed'
