#!/usr/bin/env bash
# Stub the Supabase-only surface on a vanilla Postgres, then apply every
# migration in order. Extracted from ci.yml's "schema migrations" job so other
# workflows (postgrest-embed-smoke.yml) can build the same scratch database
# without duplicating the stub list. Keep the stubs in sync with ci.yml.
#
# Connection comes from the standard PG* env vars (PGHOST, PGUSER, PGPASSWORD).
set -euo pipefail

PSQL=(psql -v ON_ERROR_STOP=1)

# Supabase roles referenced by GRANTs in migrations.
"${PSQL[@]}" -c "CREATE ROLE authenticated NOLOGIN;" || true
"${PSQL[@]}" -c "CREATE ROLE anon NOLOGIN;" || true
"${PSQL[@]}" -c "CREATE ROLE service_role NOLOGIN BYPASSRLS;" || true

"${PSQL[@]}" -c "CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS storage;"
"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS auth.users (id uuid primary key);"

"${PSQL[@]}" -c "
  CREATE TABLE IF NOT EXISTS storage.buckets (
    id text PRIMARY KEY, name text, owner uuid, owner_id text,
    public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[],
    avif_autodetection boolean DEFAULT false,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());"
"${PSQL[@]}" -c "
  CREATE TABLE IF NOT EXISTS storage.objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, owner_id text,
    metadata jsonb, path_tokens text[], version text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    last_accessed_at timestamptz DEFAULT now());"

"${PSQL[@]}" -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT NULL::uuid \$\$;"
"${PSQL[@]}" -c "CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS \$\$ SELECT string_to_array(name, '/') \$\$;"
"${PSQL[@]}" -c "CREATE PUBLICATION supabase_realtime;" || true

# pg_cron stubs — cron.schedule() calls in migrations must apply and record.
"${PSQL[@]}" -c "CREATE SCHEMA IF NOT EXISTS cron;"
"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial PRIMARY KEY, schedule text, command text, nodename text, nodeport int, database text, username text, active boolean DEFAULT true, jobname text);"
"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS cron.job_run_details (jobid bigint, runid bigserial PRIMARY KEY, job_pid int, database text, username text, command text, status text, return_message text, start_time timestamptz, end_time timestamptz);"
"${PSQL[@]}" -c "CREATE OR REPLACE FUNCTION cron.schedule(p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS \$\$ INSERT INTO cron.job(schedule, command) VALUES (p_schedule, p_command); SELECT 0::bigint \$\$;"
"${PSQL[@]}" -c "CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS \$\$ INSERT INTO cron.job(jobname, schedule, command) VALUES (p_name, p_schedule, p_command); SELECT 0::bigint \$\$;"
"${PSQL[@]}" -c "CREATE OR REPLACE FUNCTION cron.unschedule(p_name text) RETURNS boolean LANGUAGE sql AS \$\$ DELETE FROM cron.job WHERE jobname = p_name; SELECT true \$\$;"
"${PSQL[@]}" -c "CREATE OR REPLACE FUNCTION cron.unschedule(p_jobid bigint) RETURNS boolean LANGUAGE sql AS \$\$ SELECT true \$\$;"

# Supabase ships pgcrypto in `extensions`; stub the qualified digest() call.
"${PSQL[@]}" -c "CREATE SCHEMA IF NOT EXISTS extensions;"
"${PSQL[@]}" -c "CREATE OR REPLACE FUNCTION extensions.digest(data text, algorithm text) RETURNS bytea LANGUAGE sql AS \$\$ SELECT decode(md5(data), 'hex') \$\$;"

for f in packages/db/migrations/*.sql; do
  echo "Applying $f"
  if [[ "$f" == packages/db/migrations/0476_scan_resolver_ignores_dead_sales.sql ]]; then
    # 0476's preflight demands prod's exact _find_lot_by_scan text; master's
    # differs in comments only. The fixture refuses any non-comment difference.
    "${PSQL[@]}" -v bingo_empty_ci_fixture=0476_prod_function -f scripts/ci/fixture-0476-prod-find-lot-by-scan.sql
  fi
  if [[ "$f" == packages/db/migrations/0366_softdelete_catalog_misfire_20260921.sql ]]; then
    # This one-off production cleanup requires a positive capture count. Keep
    # its assertion intact and exercise it with an empty-CI-only fixture.
    if [[ "${GITHUB_ACTIONS:-}" != true || ! "${PGHOST:-}" =~ ^(localhost|127\.0\.0\.1|::1)$ ]]; then
      echo '0366 fixture requires GitHub Actions and an explicit loopback PGHOST.' >&2
      exit 1
    fi
    "${PSQL[@]}" -v bingo_empty_ci_fixture=0366_schema_only -f scripts/ci/fixture-0366.sql
  else
    "${PSQL[@]}" -f "$f" >/dev/null
  fi
done
echo "All migrations applied."
