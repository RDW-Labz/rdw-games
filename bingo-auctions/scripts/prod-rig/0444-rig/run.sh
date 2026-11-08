# 0444 proof on the Docker prod copy (rig0431, template DB = master schema replay).
# Copy the migration, its rollback and these files into the container as /w/, then: docker exec rig0431 bash /w/run.sh
P() { psql -U postgres -At -v ON_ERROR_STOP=1 "$@"; }
psql -q -U postgres -c "DROP DATABASE IF EXISTS s0444" -c "CREATE DATABASE s0444 TEMPLATE postgres" || exit 1
echo "== apply"; P -q -d s0444 -f /w/0444_undo_invoice_line_forfeit.sql || exit 1
echo "== re-apply"; P -q -d s0444 -f /w/0444_undo_invoice_line_forfeit.sql || exit 1
P -d s0444 -c "SELECT 'grants anon/auth/service', has_function_privilege('anon','public.undo_invoice_line_forfeit(uuid,uuid,text,text,text)','EXECUTE'), has_function_privilege('authenticated','public.undo_invoice_line_forfeit(uuid,uuid,text,text,text)','EXECUTE'), has_function_privilege('service_role','public.undo_invoice_line_forfeit(uuid,uuid,text,text,text)','EXECUTE')"
P -q -d s0444 -c "ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text" >/dev/null; echo "== seed"; P -q -d s0444 -f /w/seed.sql || exit 1
echo "== cases"; P -q -d s0444 -f /w/cases.sql
echo "== rollback"; s=$(date +%s%N); P -q -d s0444 -f /w/0444_ROLLBACK_undo_invoice_line_forfeit.sql && echo "rollback ok $(( ($(date +%s%N)-s)/1000000 ))ms"
P -d s0444 -c "SELECT 'fn after rollback', count(*) FROM pg_proc WHERE proname = 'undo_invoice_line_forfeit'"
