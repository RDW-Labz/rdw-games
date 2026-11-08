#!/bin/sh
# 0473 proof on the Docker prod copy (rig0431), from the host:
#   sh scripts/prod-rig/0473-rig/run.sh
# x473 = rig0431's prod-schema template `postgres` + seed + 0473 (twice) +
# cases; then rollback, check nothing is left, re-apply. Only x473 is touched.
set -e
C=${C:-rig0431}
PENDING=${PENDING:-$HOME/Documents/bingo-migrations-pending}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG=$PENDING/0473_lot_warehouse_transfer.sql
ROLLBACK=$HERE/../0473_ROLLBACK_lot_warehouse_transfer.sql
psqlc() { docker exec -i "$C" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

echo "0473 sha256: $(shasum -a 256 "$MIG" | cut -d' ' -f1)"
docker exec "$C" psql -U postgres -qc "DROP DATABASE IF EXISTS x473" -c "CREATE DATABASE x473 TEMPLATE postgres"
psqlc -d x473 < "$HERE/seed.sql"

echo "===== BEFORE 0473 (prod today)"
psqlc -d x473 -At <<'SQL'
SELECT rig_as('00000000-0000-0000-0000-0000000000c1');
SELECT 'before: ' || rig_err($q$SELECT public.confirm_move_lot_to_bin('00000000-0000-0000-0000-000000000113', '00000000-0000-0000-0000-00000000aad2')$q$);
SQL

psqlc -d x473 < "$MIG" && echo "apply ok"
psqlc -d x473 < "$MIG" && echo "re-apply ok"

echo "===== CASES"
psqlc -d x473 -At < "$HERE/cases.sql" | tee /tmp/x473_cases.out | grep -E '^(PASS|FAIL)'
echo "cases: $(grep -c '^PASS' /tmp/x473_cases.out) PASS / $(grep -c '^FAIL' /tmp/x473_cases.out) FAIL"

psqlc -d x473 < "$ROLLBACK" && echo "rollback ok"
LEFT=$(docker exec "$C" psql -U postgres -d x473 -Atc "select count(*) from pg_proc where proname in ('transfer_lot_to_bin','lots_0473_transfer_guard')")
TRG=$(docker exec "$C" psql -U postgres -d x473 -Atc "select count(*) from pg_trigger where tgname = 'lots_0473_transfer_guard'")
[ "$LEFT" = "0" ] && [ "$TRG" = "0" ] && echo "PASS rollback removed function + trigger" || echo "FAIL rollback left: $LEFT functions, $TRG triggers"
psqlc -d x473 < "$MIG" && echo "re-apply after rollback ok"
docker exec "$C" psql -U postgres -qc "DROP DATABASE IF EXISTS x473"
