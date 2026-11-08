#!/usr/bin/env bash
# Proves 0478 as NON-superuser postgres on Supabase's own Postgres 17.6 image.
# Stubs the 11 functions with prod's signatures and prod's ACLs (read 10-30),
# then: apply, re-apply, anon/authenticated refused, postgres (pg_cron's role)
# and service_role still run them, rollback restores prod's ACLs, re-apply.
# usage: run.sh <path/to/0478.sql>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIG="${1:-$ROOT/packages/db/migrations/0478_revoke_cron_writer_functions.sql}"
RB="$ROOT/scripts/prod-rig/0478_ROLLBACK_revoke_cron_writer_functions.sql"
[ -f "$MIG" ] || { echo "usage: run.sh <0478.sql>"; exit 2; }
C=rig0478
docker rm -f $C >/dev/null 2>&1 || true
docker run -d --rm --name $C -e POSTGRES_PASSWORD=x public.ecr.aws/supabase/postgres:17.6.1.171 >/dev/null
until docker exec $C pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null; do sleep 1; done; sleep 8
q() { docker exec -i -e PGPASSWORD=x $C psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }
qf() { docker exec -i -e PGPASSWORD=x $C psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "$(cat "$1")"; }
fail() { echo "FAIL: $*"; docker rm -f $C >/dev/null; exit 1; }
[ "$(q -c "select rolsuper from pg_roles where rolname=current_user")" = "f" ] || fail "postgres is superuser here"

SIGS="auto_mark_pickup_no_show() advance_auction_lifecycle() auto_relist_unsold_lots() build_invoices_for_auction(uuid) drain_build_invoice_jobs(integer) mark_settlements_releasable() check_collected_item_invariants(interval) claim_refund_job(text,integer) claim_webhook_event(text,text) commit_webhook_event(text) mark_invite_consumed(uuid,uuid)"
for s in $SIGS; do
  name=${s%%(*}; args=${s#*(}; args=${args%)}
  params=$(echo "$args" | awk -F, '{for(i=1;i<=NF;i++){if($i!="")printf "%sp%d %s", (i>1?", ":""), i, $i}}')
  q -c "CREATE FUNCTION public.$name($params) RETURNS int LANGUAGE sql SECURITY DEFINER AS 'select 1';
        REVOKE ALL ON FUNCTION public.$s FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION public.$s TO anon, authenticated, service_role;"
done
# an app-called writer that must stay untouched
q -c "CREATE FUNCTION public.place_bid_stub(uuid) RETURNS int LANGUAGE sql SECURITY DEFINER AS 'select 1'; GRANT EXECUTE ON FUNCTION public.place_bid_stub(uuid) TO anon, authenticated;"

acl() { q -c "select string_agg(proname || ':' || (select string_agg(a::text, ',' order by a::text) from unnest(proacl) a), ' | ' order by proname) from pg_proc where pronamespace='public'::regnamespace and proname <> 'place_bid_stub'"; }
BEFORE="$(acl)"
can() { q -c "select string_agg(r || '=' || has_function_privilege(r, 'public.$1', 'execute')::text, ' ' order by r) from unnest(array['anon','authenticated','service_role','postgres']) r"; }

qf "$MIG"; qf "$MIG"; echo "apply + re-apply ok"
for s in $SIGS; do
  [ "$(can "$s")" = "anon=false authenticated=false postgres=true service_role=true" ] || fail "$s: $(can "$s")"
done
echo "PASS: 11 functions refused to anon/authenticated; postgres (pg_cron) and service_role keep EXECUTE"
q -c "set role anon; select public.auto_mark_pickup_no_show();" >/dev/null 2>&1 && fail "anon could still call the sweep"
echo "PASS: anon call to auto_mark_pickup_no_show() is refused"
[ "$(q -c "select public.auto_mark_pickup_no_show()")" = "1" ] || fail "postgres cannot run the sweep"
echo "PASS: postgres (the pg_cron job role) runs the sweep"
[ "$(can 'place_bid_stub(uuid)')" = "anon=true authenticated=true postgres=true service_role=true" ] || fail "app RPC changed"
echo "PASS: an app-called function outside the list is untouched"

qf "$RB"
[ "$(acl)" = "$BEFORE" ] || fail "rollback did not restore ACLs: $(acl)"
echo "PASS: rollback restores the exact pre-0478 ACLs"
qf "$MIG"
[ "$(can 'auto_mark_pickup_no_show()')" = "anon=false authenticated=false postgres=true service_role=true" ] || fail "re-apply after rollback"
echo "PASS: re-apply after rollback"
docker rm -f $C >/dev/null
