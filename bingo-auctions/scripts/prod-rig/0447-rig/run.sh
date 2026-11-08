# 0447 proof on the Docker prod copy (rig0431). Copy the migration, its rollback and cases.sql into the container as /w9/, then: docker exec rig0431 bash /w9/run.sh
P() { psql -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
psql -q -U postgres -c "DROP DATABASE IF EXISTS s0447" -c "CREATE DATABASE s0447 TEMPLATE postgres" || exit 1
P -q -d s0447 -c "ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text" >/dev/null
P -d s0447 -c "SELECT 'has 0357 fn: ' || (to_regprocedure('public.collected_item_gone_lots()') IS NOT NULL)"
echo "== apply"; P -q -d s0447 -f /w9/0447_builder_collected_lots.sql || exit 1; echo "== re-apply"; P -q -d s0447 -f /w9/0447_builder_collected_lots.sql || exit 1
psql -U postgres -At -d s0447 -f /w9/cases.sql 2>&1 | grep -E ": |ERROR"
echo "== rollback"; P -q -d s0447 -f /w9/0447_ROLLBACK_builder_collected_lots.sql && P -d s0447 -c "SELECT 'fn after rollback: ' || count(*) FROM pg_proc WHERE proname = 'builder_collected_lot_ids'"
