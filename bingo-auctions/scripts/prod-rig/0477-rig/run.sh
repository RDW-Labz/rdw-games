#!/usr/bin/env bash
# Proves 0477 on Supabase's own Postgres 17.6 image as NON-superuser postgres.
# Usage: run.sh [path/to/0477.sql]  (default: pending folder copy)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIG="${1:-$HOME/Documents/bingo-migrations-pending/0477_feedback_notify_and_reply.sql}"
RB="$ROOT/scripts/prod-rig/0477_ROLLBACK_feedback_notify_and_reply.sql"
M="$ROOT/packages/db/migrations"
C=rig0477
docker rm -f $C >/dev/null 2>&1 || true
docker run -d --rm --name $C -e POSTGRES_PASSWORD=x public.ecr.aws/supabase/postgres:17.6.1.171 >/dev/null
trap 'docker rm -f $C >/dev/null 2>&1 || true' EXIT
until docker exec $C pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null; do sleep 1; done
sleep 8
q()  { docker exec -i -e PGPASSWORD=x $C psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }
qf() { docker exec -i -e PGPASSWORD=x $C psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$1" >/dev/null; }
fail() { echo "FAIL: $*"; exit 1; }
[ "$(q -c "select rolsuper from pg_roles where rolname=current_user")" = "f" ] || fail "postgres is superuser; proves nothing"

# Minimal stand-ins for what 0317/0325 reference. Setup only: storage tables
# are created as supabase_admin (the storage service owns them on a real
# project) and handed to postgres; every migration below runs as postgres.
qa() { docker exec -i $C psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }
qa -c "create table if not exists storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
       create table if not exists storage.objects(bucket_id text, name text);
       alter table storage.objects enable row level security;
       create or replace function storage.foldername(name text) returns text[] language sql immutable as \$\$ select string_to_array(name, '/') \$\$;
       alter table storage.buckets owner to postgres; alter table storage.objects owner to postgres;
       grant usage on schema storage to postgres;"
q -c "create table public.operators(id uuid primary key default gen_random_uuid());
      create table public.operator_users(user_id uuid, operator_id uuid);
      create function public.current_operator_role() returns text language sql stable as \$\$ select 'admin'::text \$\$;"
for f in 0317_app_feedback 0325_feedback_attachments 0327_customer_feedback_from_the_web 0330_bigger_feedback_attachments; do qf "$M/$f.sql"; done
q -c "insert into public.app_feedback(app, kind, message, created_at) values
      ('web','bug','old report number one', now() - interval '9 days'),
      ('web','idea','old report number two', now() - interval '3 days');"

qf "$MIG"; qf "$MIG"; echo "applied twice: ok"
[ "$(q -c "select count(*) from public.app_feedback where notified_at is null")" = "0" ] || fail "old rows not marked notified"
[ "$(q -c "select count(*) from public.app_feedback where notified_at = created_at")" = "2" ] || fail "backfill should use created_at"

# A new item arrives; the cron notifies it; a re-run must not touch pending rows.
q -c "insert into public.app_feedback(app, kind, message) values ('web','bug','brand new report A'), ('web','bug','brand new report B');"
q -c "update public.app_feedback set notified_at = now() where message = 'brand new report A';"
qf "$MIG"
[ "$(q -c "select count(*) from public.app_feedback where notified_at is null")" = "1" ] || fail "re-run backfilled a pending row"
echo "PASS: backfill once, pending rows stay pending on re-run"

for r in anon authenticated; do
  [ "$(q -c "select has_table_privilege('$r','public.feedback_digest_runs','select')")" = "f" ] || fail "$r can read feedback_digest_runs"
done
[ "$(q -c "select has_table_privilege('service_role','public.feedback_digest_runs','insert')")" = "t" ] || fail "service_role cannot insert digest run"
q -c "insert into public.feedback_digest_runs(day, items) values (date '2026-10-31', 3) on conflict (day) do nothing;"
[ "$(q -c "with ins as (insert into public.feedback_digest_runs(day) values (date '2026-10-31') on conflict (day) do nothing returning 1) select count(*) from ins")" = "0" ] || fail "digest day not unique"
echo "PASS: digest log is service-role only and once per day"

qf "$RB"
[ "$(q -c "select count(*) from information_schema.columns where table_name='app_feedback' and column_name in ('notified_at','reply_emailed_at')")" = "0" ] || fail "rollback left columns"
[ "$(q -c "select to_regclass('public.feedback_digest_runs') is null")" = "t" ] || fail "rollback left table"
[ "$(q -c "select count(*) from public.app_feedback")" = "4" ] || fail "rollback lost feedback rows"
qf "$MIG"; echo "PASS: rollback clean, re-apply ok"

echo "== lock check: a writer holding app_feedback makes 0477 give up after 3s"
docker exec -d -e PGPASSWORD=x $C psql -h 127.0.0.1 -U postgres -d postgres -c "begin; insert into public.app_feedback(app,kind,message) values ('web','bug','held open by a test'); select pg_sleep(12); commit;"
sleep 2
qf "$RB" || true
t0=$(date +%s); if qf "$MIG" 2>/dev/null; then fail "expected lock timeout"; fi
echo "PASS: lock_timeout fired after $(( $(date +%s)-t0 ))s"
echo "ALL PASS"
