# 0458 proof on the Docker prod copy (rig0431): copy the migration as /w11/0458.sql, the rollback as /w11/0458_RB.sql and this file into the container, then: docker exec rig0431 bash /w11/run.sh
P() { psql -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
psql -q -U postgres -c "DROP DATABASE IF EXISTS s0458" -c "CREATE DATABASE s0458 TEMPLATE postgres" || exit 1
P -d s0458 -c "SELECT 'fn exists: ' || count(*) FROM pg_proc WHERE proname = 'enqueue_notification'"
for r in anon authenticated service_role; do psql -U postgres -d s0458 -At -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$r') THEN CREATE ROLE $r NOLOGIN; END IF; END \$\$;" >/dev/null; done
# prod ACL shape before 0458
P -q -d s0458 -c "GRANT EXECUTE ON FUNCTION public.enqueue_notification(notification_kind, uuid, jsonb, text) TO anon, authenticated, service_role"
# a SECURITY DEFINER caller owned by postgres (like place_bid/finalize_lot)
P -q -d s0458 -c "CREATE FUNCTION public.t_caller() RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS \$f\$ BEGIN BEGIN PERFORM public.enqueue_notification('outbid'::notification_kind, NULL::uuid, '{}'::jsonb, 'k' || clock_timestamp()::text); EXCEPTION WHEN not_null_violation OR foreign_key_violation OR check_violation THEN RETURN 'called (data error ok: ' || SQLSTATE || ')'; END; RETURN 'called'; END \$f\$; GRANT EXECUTE ON FUNCTION public.t_caller() TO authenticated;"
try() { psql -U postgres -d s0458 -At -c "SET ROLE $1; $2" 2>&1 | tail -1; }
EX="SELECT public.enqueue_notification('onboarding_nudge'::notification_kind, '00000000-0000-0000-0000-000000000001'::uuid, '{\"email\":\"victim@example.test\"}'::jsonb, 'x1')"
echo "== before 0458"; echo "anon direct: $(try anon "$EX")"; echo "auth via definer caller: $(try authenticated 'SELECT public.t_caller()')"
echo "== apply"; P -q -d s0458 -f /w11/0458.sql || exit 1; P -q -d s0458 -f /w11/0458.sql || exit 1; echo "(applied twice)"
echo "anon direct: $(try anon "$EX")"; echo "authenticated direct: $(try authenticated "$EX")"; echo "auth via definer caller: $(try authenticated 'SELECT public.t_caller()')"
P -d s0458 -c "SELECT 'acl after: ' || proacl::text FROM pg_proc WHERE proname = 'enqueue_notification'"
echo "== rollback"; P -q -d s0458 -f /w11/0458_RB.sql && echo "anon direct after rollback: $(try anon "$EX")"
P -d s0458 -c "SELECT 'acl after rollback: ' || proacl::text FROM pg_proc WHERE proname = 'enqueue_notification'"
