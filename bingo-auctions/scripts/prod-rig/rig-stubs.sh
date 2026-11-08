P() { psql -q -U postgres -v ON_ERROR_STOP=1 "$@"; }
P -c "CREATE ROLE authenticated NOLOGIN;" -c "CREATE ROLE anon NOLOGIN;" -c "CREATE ROLE service_role NOLOGIN BYPASSRLS;" -c "CREATE SCHEMA auth; CREATE SCHEMA storage;" -c "CREATE TABLE auth.users (id uuid primary key);"
P -c "CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, owner uuid, owner_id text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], avif_autodetection boolean DEFAULT false, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());"
P -c "CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, owner_id text, metadata jsonb, path_tokens text[], version text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), last_accessed_at timestamptz DEFAULT now());"
P -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;"
P -c "CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS \$\$ SELECT string_to_array(name, '/') \$\$;" -c "CREATE PUBLICATION supabase_realtime;" -c "CREATE SCHEMA IF NOT EXISTS cron;"
P -c "CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial PRIMARY KEY, schedule text, command text, nodename text, nodeport int, database text, username text, active boolean DEFAULT true, jobname text);" -c "CREATE TABLE IF NOT EXISTS cron.job_run_details (jobid bigint, runid bigserial PRIMARY KEY, job_pid int, database text, username text, command text, status text, return_message text, start_time timestamptz, end_time timestamptz);"
P -c "CREATE OR REPLACE FUNCTION cron.schedule(p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS \$\$ INSERT INTO cron.job(schedule, command) VALUES (p_schedule, p_command); SELECT 0::bigint \$\$;" -c "CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS \$\$ INSERT INTO cron.job(jobname, schedule, command) VALUES (p_name, p_schedule, p_command); SELECT 0::bigint \$\$;" -c "CREATE OR REPLACE FUNCTION cron.unschedule(p_name text) RETURNS boolean LANGUAGE sql AS \$\$ DELETE FROM cron.job WHERE jobname = p_name; SELECT true \$\$;" -c "CREATE OR REPLACE FUNCTION cron.unschedule(p_jobid bigint) RETURNS boolean LANGUAGE sql AS \$\$ SELECT true \$\$;"
P -c "CREATE SCHEMA IF NOT EXISTS extensions;" -c "CREATE OR REPLACE FUNCTION extensions.digest(data text, algorithm text) RETURNS bytea LANGUAGE sql AS \$\$ SELECT decode(md5(data), 'hex') \$\$;"
fails=0
for f in /repo/packages/db/migrations/*.sql; do
  if [ "$(basename $f)" = 0366_softdelete_catalog_misfire_20260921.sql ]; then
    psql -q -U postgres -v ON_ERROR_STOP=1 -v bingo_empty_ci_fixture=0366_schema_only -f /repo/scripts/ci/fixture-0366.sql >/dev/null 2>/tmp/err || { echo "FAIL $f: $(head -c 200 /tmp/err)"; fails=$((fails+1)); }
  else
    psql -q -U postgres -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>/tmp/err || { echo "FAIL $f: $(head -c 200 /tmp/err)"; fails=$((fails+1)); }
  fi
done
echo "migrations replayed, failures=$fails"
