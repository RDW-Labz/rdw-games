#!/bin/bash
# Builds sq4base on rig0431: Supabase-shaped stubs + a replay of every
# migration in $D/migrations (master's packages/db/migrations + pending 0446,
# copied in per run.sh's header), then the seed. The container's template DB
# `postgres` is stale (~0430), so this does NOT clone it; the stubs are the
# same as scripts/prod-rig/0457-rig/run.sh. Everything in run.sh clones
# sq4base, so BEFORE and AFTER copies start from identical bytes.
# Database names are prefixed sq4 (other workers share the container).
D=${D:-/work/sq4-0454}
P() { psql -q -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
psql -q -U postgres -c "DROP DATABASE IF EXISTS sq4base" -c "CREATE DATABASE sq4base" || exit 1
for r in authenticated anon; do
  psql -q -U postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$r') THEN CREATE ROLE $r NOLOGIN; END IF; END \$\$;"
done
psql -q -U postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END \$\$;"
P -d sq4base -c "CREATE SCHEMA auth; CREATE SCHEMA storage;"
P -d sq4base -c "CREATE TABLE auth.users (id uuid primary key, email text);"
P -d sq4base -c "CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, owner uuid, owner_id text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], avif_autodetection boolean DEFAULT false, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());"
P -d sq4base -c "CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, owner_id text, metadata jsonb, path_tokens text[], version text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), last_accessed_at timestamptz DEFAULT now());"
P -d sq4base -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;"
P -d sq4base -c "CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS \$\$ SELECT string_to_array(name, '/') \$\$;" -c "CREATE PUBLICATION supabase_realtime;" -c "CREATE SCHEMA IF NOT EXISTS cron;"
P -d sq4base -c "CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial PRIMARY KEY, schedule text, command text, nodename text, nodeport int, database text, username text, active boolean DEFAULT true, jobname text);" -c "CREATE TABLE IF NOT EXISTS cron.job_run_details (jobid bigint, runid bigserial PRIMARY KEY, job_pid int, database text, username text, command text, status text, return_message text, start_time timestamptz, end_time timestamptz);"
P -d sq4base -c "CREATE OR REPLACE FUNCTION cron.schedule(p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS \$\$ INSERT INTO cron.job(schedule, command) VALUES (p_schedule, p_command); SELECT 0::bigint \$\$;" -c "CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS \$\$ INSERT INTO cron.job(jobname, schedule, command) VALUES (p_name, p_schedule, p_command); SELECT 0::bigint \$\$;" -c "CREATE OR REPLACE FUNCTION cron.unschedule(p_name text) RETURNS boolean LANGUAGE sql AS \$\$ DELETE FROM cron.job WHERE jobname = p_name; SELECT true \$\$;" -c "CREATE OR REPLACE FUNCTION cron.unschedule(p_jobid bigint) RETURNS boolean LANGUAGE sql AS \$\$ SELECT true \$\$;"
P -d sq4base -c "CREATE SCHEMA IF NOT EXISTS extensions;" -c "CREATE OR REPLACE FUNCTION extensions.digest(data text, algorithm text) RETURNS bytea LANGUAGE sql AS \$\$ SELECT decode(md5(data), 'hex') \$\$;"
fails=0; n=0
for f in $D/migrations/*.sql; do
  base=$(basename "$f"); n=$((n+1))
  if [ "$base" = "0366_softdelete_catalog_misfire_20260921.sql" ]; then
    psql -q -U postgres -d sq4base -v ON_ERROR_STOP=1 -v bingo_empty_ci_fixture=0366_schema_only -f /repo/scripts/ci/fixture-0366.sql >/dev/null 2>/tmp/sq4err || { echo "FAIL $base: $(head -c 300 /tmp/sq4err)"; fails=$((fails+1)); }
  else
    psql -q -U postgres -d sq4base -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>/tmp/sq4err || { echo "FAIL $base: $(head -c 300 /tmp/sq4err)"; fails=$((fails+1)); }
  fi
done
[ $fails -eq 0 ] || { echo "ABORT: replay failures=$fails"; exit 1; }
P -d sq4base -c "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;"
# sq4bare = schema only, no seed: for the repo SQL tests (packages/db/test, as CI runs them).
psql -q -U postgres -c "DROP DATABASE IF EXISTS sq4bare" -c "CREATE DATABASE sq4bare TEMPLATE sq4base" || exit 1
if [ -f $D/seed.sql ]; then P -d sq4base -f $D/seed.sql || { echo "SEED FAILED"; exit 1; }; fi
echo "base: replayed=$n last=$(ls $D/migrations | tail -1) lots=$(P -d sq4base -c 'select count(*) from lots') auctions=$(P -d sq4base -c 'select count(*) from auctions')"
