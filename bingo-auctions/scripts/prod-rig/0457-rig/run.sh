#!/bin/bash
# 0457 proof on rig0431. The container's bind-mounted /repo is a stale
# worktree (migrations only through 0430), so this rig does NOT use
# `CREATE DATABASE ... TEMPLATE postgres` (that template is equally stale).
# Instead it bootstraps Supabase-shaped stubs (same primitives as
# scripts/prod-rig/rig-stubs.sh) directly into a fresh database and replays
# every migration file copied into /work/0457-rig/migrations (current master
# + 0457 itself) in order, exactly like a real `supabase db reset` would.
#
# Copy this whole 0457-rig/ directory (plus migrations/ and the fixture) to
# /work/0457-rig inside rig0431, then: docker exec rig0431 bash /work/0457-rig/run.sh
set -e
D=/work/0457-rig
P() { psql -q -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }

psql -q -U postgres -c "DROP DATABASE IF EXISTS s0457" -c "CREATE DATABASE s0457" || exit 1

echo "===== bootstrap Supabase-shaped stubs (roles, auth/storage schemas, cron, extensions schema)"
# Roles are cluster-wide -- other rigs (0435, 0451) on this same postgres
# cluster may have already created them. Create only if missing.
psql -q -U postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END \$\$;"
psql -q -U postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; END \$\$;"
psql -q -U postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END \$\$;"
P -d s0457 -c "CREATE SCHEMA auth; CREATE SCHEMA storage;"
P -d s0457 -c "CREATE TABLE auth.users (id uuid primary key, email text);"
P -d s0457 -c "CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, owner uuid, owner_id text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], avif_autodetection boolean DEFAULT false, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());"
P -d s0457 -c "CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, owner_id text, metadata jsonb, path_tokens text[], version text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), last_accessed_at timestamptz DEFAULT now());"
P -d s0457 -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;"
P -d s0457 -c "CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS \$\$ SELECT string_to_array(name, '/') \$\$;" -c "CREATE PUBLICATION supabase_realtime;" -c "CREATE SCHEMA IF NOT EXISTS cron;"
P -d s0457 -c "CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial PRIMARY KEY, schedule text, command text, nodename text, nodeport int, database text, username text, active boolean DEFAULT true, jobname text);" -c "CREATE TABLE IF NOT EXISTS cron.job_run_details (jobid bigint, runid bigserial PRIMARY KEY, job_pid int, database text, username text, command text, status text, return_message text, start_time timestamptz, end_time timestamptz);"
P -d s0457 -c "CREATE OR REPLACE FUNCTION cron.schedule(p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS \$\$ INSERT INTO cron.job(schedule, command) VALUES (p_schedule, p_command); SELECT 0::bigint \$\$;" -c "CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS \$\$ INSERT INTO cron.job(jobname, schedule, command) VALUES (p_name, p_schedule, p_command); SELECT 0::bigint \$\$;" -c "CREATE OR REPLACE FUNCTION cron.unschedule(p_name text) RETURNS boolean LANGUAGE sql AS \$\$ DELETE FROM cron.job WHERE jobname = p_name; SELECT true \$\$;" -c "CREATE OR REPLACE FUNCTION cron.unschedule(p_jobid bigint) RETURNS boolean LANGUAGE sql AS \$\$ SELECT true \$\$;"
P -d s0457 -c "CREATE SCHEMA IF NOT EXISTS extensions;" -c "CREATE OR REPLACE FUNCTION extensions.digest(data text, algorithm text) RETURNS bytea LANGUAGE sql AS \$\$ SELECT decode(md5(data), 'hex') \$\$;"

echo "===== replay all migrations through 0452 + 0457 (fails fast on first error)"
fails=0
for f in $D/migrations/*.sql; do
  base=$(basename "$f")
  if [ "$base" = "0457_member_pro.sql" ]; then continue; fi  # applied separately, after the BEFORE snapshot
  if [ "$base" = "0366_softdelete_catalog_misfire_20260921.sql" ]; then
    # fixture-0366.sql \ir's ../../packages/db/migrations/0366_*.sql relative to
    # its OWN location -- run the real repo copy (content-identical, sha256
    # verified) so that relative include resolves, instead of our copy.
    psql -q -U postgres -d s0457 -v ON_ERROR_STOP=1 -v bingo_empty_ci_fixture=0366_schema_only -f /repo/scripts/ci/fixture-0366.sql >/dev/null 2>/tmp/err0457 || { echo "FAIL $base: $(head -c 300 /tmp/err0457)"; fails=$((fails+1)); }
  else
    psql -q -U postgres -d s0457 -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>/tmp/err0457 || { echo "FAIL $base: $(head -c 300 /tmp/err0457)"; fails=$((fails+1)); }
  fi
done
echo "migrations through 0452 replayed, failures=$fails"
if [ "$fails" -gt 0 ]; then echo "ABORT: base schema replay failed"; exit 1; fi

echo "===== simulate Supabase cluster-level default grants (rig-stubs.sh only creates the roles, not the default privileges Supabase sets at project bootstrap)"
P -d s0457 -c "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON operators, operator_users, warehouses, bidders, operator_pro_plans, bidder_subscriptions TO anon, authenticated;"

P -d s0457 -f "$D/seed.sql" || { echo SEED FAILED; exit 1; }

echo "===== BEFORE 0457 (prod today)"
psql -U postgres -At -d s0457 -f "$D/cases-before.sql" 2>&1 | grep -v "^$"

echo "===== APPLY 0457"
s=$(date +%s%N); P -d s0457 -f "$D/migrations/0457_member_pro.sql" || exit 1
echo "apply ok $(ms $s)ms"

echo "===== RE-APPLY 0457 (idempotency)"
s=$(date +%s%N); P -d s0457 -f "$D/migrations/0457_member_pro.sql" || exit 1
echo "re-apply ok $(ms $s)ms"

echo "===== grant on 0457's NEW tables (the earlier 'GRANT ALL ... TO service_role' ran before these tables existed, so service_role needs its own grant too, same as anon/authenticated -- a real Supabase project's default privileges would cover this automatically; the rig has to do it by hand)"
P -d s0457 -c "GRANT ALL ON member_warehouse_settings, member_waitlist, member_slot_bookings, member_inspections TO service_role;"
P -d s0457 -c "GRANT SELECT, INSERT, UPDATE, DELETE ON member_warehouse_settings, member_waitlist, member_slot_bookings, member_inspections TO anon, authenticated;"

echo "===== AFTER 0457 (shape)"
psql -U postgres -At -d s0457 -f "$D/cases-after.sql" 2>&1 | grep -v "^$"

echo "===== RLS + constraint matrix"
psql -U postgres -At -d s0457 -f "$D/cases.sql" 2>&1 | grep -v "^$"

echo "===== clear synthetic rows made by cases.sql (prod has 0 rows in these tables today -- this reproduces that real shape before proving the rollback, same reasoning as 0435-rig's seed_reset.sql step)"
P -d s0457 -c "DELETE FROM member_inspections; DELETE FROM member_slot_bookings; DELETE FROM member_waitlist; DELETE FROM member_warehouse_settings; DELETE FROM bidder_subscriptions; DELETE FROM operator_pro_plans;"

echo "===== ROLLBACK"
s=$(date +%s%N); P -d s0457 -f "$D/0457_ROLLBACK_member_pro.sql" && echo "rollback ok $(ms $s)ms"
P -d s0457 -c "SELECT 'cols after rollback (should be 0): ' || count(*) FROM information_schema.columns WHERE (table_name='operator_pro_plans' AND column_name IN ('billing_interval','intro_price_cents','intro_months','intro_seats','member_cap','past_due_grace_days','early_access_minutes','perk_inspection_before_pickup','perk_scheduled_pickup_slots','perk_early_building_access','perk_longer_pickup_window','perk_payment_grace','standard_pickup_allowance_qty','standard_pickup_allowance_unit','large_order_slot_minutes','large_order_fee_enabled','large_order_fee_cents','inspections_per_member_month','max_active_slots_per_member')) OR (table_name='bidder_subscriptions' AND column_name IN ('intro_applied','square_subscription_id','past_due_since')) OR (table_name='member_warehouse_settings' AND column_name IN ('large_orders_per_day','standard_pickup_allowance_qty_override','standard_pickup_allowance_unit_override'))"
P -d s0457 -c "SELECT 'tables after rollback (should be 0): ' || count(*) FROM information_schema.tables WHERE table_name IN ('member_warehouse_settings','member_waitlist','member_slot_bookings','member_inspections')"
P -d s0457 -c "SELECT 'operator_pro_plans count (should be 0, synthetic rows cleared above): ' || count(*) FROM operator_pro_plans"
