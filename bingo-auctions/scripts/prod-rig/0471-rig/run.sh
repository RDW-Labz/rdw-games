#!/bin/sh
# 0471 proof on the Docker rig (rig0431), from the host:
#   sh scripts/prod-rig/0471-rig/run.sh
# MASTER_BASE = a database with master's migrations replayed (the 0462 rig's
# fx588_base). Only wd_* databases are created / dropped.
#   1. wd_base = MASTER_BASE + auth stub columns
#   2. wd_run  = wd_base + seed + 0471 (twice), cases.sql
#   3. rollback: applies, restores the three replaced functions byte for
#      byte, drops the new tables / functions; 0471 then re-applies.
set -e
C=${C:-rig0431}
MASTER_BASE=${MASTER_BASE:-fx588_base}
PENDING=${PENDING:-$HOME/Documents/bingo-migrations-pending}
HERE=$(cd "$(dirname "$0")" && pwd)
ROLLBACK=$HERE/../0471_ROLLBACK_lot_withdraw_and_undo.sql
MIG=$PENDING/0471_lot_withdraw_and_undo.sql
psqlc() { docker exec -i "$C" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
fresh() { docker exec "$C" psql -U postgres -qc "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1 TEMPLATE $2"; }
defs() {
  docker exec "$C" psql -U postgres -d "$1" -Atc "SELECT md5(string_agg(pg_get_functiondef(p.oid), '' ORDER BY p.proname))
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('keep_lot_for_business', 'lots_removal_is_terminal', 'remove_lot_from_inventory')"
}

echo "===== base: $MASTER_BASE + auth stub"
fresh wd_base "$MASTER_BASE"
psqlc -d wd_base < "$HERE/auth-stub.sql"
echo "0471 sha256: $(shasum -a 256 "$MIG" | cut -d' ' -f1)"

echo "===== APPLY 0471 + RE-APPLY"
fresh wd_run wd_base
psqlc -d wd_run < "$HERE/seed.sql"
psqlc -d wd_run < "$MIG" 2>/dev/null && echo "apply ok"
psqlc -d wd_run < "$MIG" 2>/dev/null && echo "re-apply ok"

echo "===== CASES"
psqlc -d wd_run -At < "$HERE/cases.sql" | tee /tmp/wd_cases.out | grep -E '^(PASS|FAIL)'
echo "cases: $(grep -c '^PASS' /tmp/wd_cases.out) PASS / $(grep -c '^FAIL' /tmp/wd_cases.out) FAIL"

echo "===== ROLLBACK while a withdrawal can still be undone (must refuse)"
if psqlc -d wd_run < "$ROLLBACK" > /dev/null 2>/tmp/wd_rb.err; then echo "FAIL rollback ran with an undoable withdrawal"; else
  grep -q "0471 rollback refused" /tmp/wd_rb.err && echo "PASS rollback refused while a withdrawal can be undone" || { echo "FAIL other error:"; cat /tmp/wd_rb.err; }; fi
psqlc -d wd_run -c "UPDATE lot_withdrawals SET close_at = now() - interval '1 minute' WHERE undone_at IS NULL"
echo "===== ROLLBACK"
psqlc -d wd_run < "$ROLLBACK" > /dev/null 2>/tmp/wd_rb.err && echo "rollback ok" || cat /tmp/wd_rb.err
A="$(defs wd_run) $(docker exec "$C" psql -U postgres -d wd_run -Atc "SELECT coalesce(to_regclass('public.lot_withdrawals')::text, 'no-table') || ' ' || coalesce(to_regclass('public.lot_removal_undos')::text, 'no-table') || ' ' || (SELECT count(*) FROM pg_proc WHERE proname IN ('withdraw_lot_from_auction','undo_lot_withdrawal','undo_lot_removal','dispose_lot_attributed','keep_lot_for_business_attributed','lot_staff_action_check'))")"
B="$(defs wd_base) no-table no-table 0"
[ "$A" = "$B" ] && echo "PASS rollback restores the replaced functions exactly and drops the new ones ($A)" || echo "FAIL rollback: $A vs $B"
psqlc -d wd_run < "$MIG" 2>/dev/null && echo "re-apply after rollback ok"
