#!/bin/sh
# 0476 proof on the Docker prod copy (rig0431), from the host:
#   sh scripts/prod-rig/0476-rig/run.sh
# x476 = template `postgres` + the LIVE prod body of _find_lot_by_scan
# (loaded from the rollback file, so the preflight sees prod's exact body) +
# seed. Prints every scan BEFORE and AFTER, then checks the expected moves,
# re-apply, rollback (restores the exact live body), re-apply.
set -e
C=${C:-rig0431}
PENDING=${PENDING:-$HOME/Documents/bingo-migrations-pending}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG=$PENDING/0476_scan_resolver_ignores_dead_sales.sql
RB=$HERE/../0476_ROLLBACK_scan_resolver_ignores_dead_sales.sql
psqlc() { docker exec -i "$C" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
md5f() { echo "select md5(pg_get_functiondef('public._find_lot_by_scan(text[])'::regprocedure))" | psqlc -d x476 -At; }
F=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; F=$((F+1)); }

echo "0476 sha256: $(shasum -a 256 "$MIG" | cut -d' ' -f1)"
docker exec "$C" psql -U postgres -qc "DROP DATABASE IF EXISTS x476" -c "CREATE DATABASE x476 TEMPLATE postgres" >/dev/null
psqlc -d x476 < "$RB"
[ "$(md5f)" = "6a40bb40390d5c812534d791b778fa8a" ] && ok "rig body = prod live body (md5 6a40bb40…)" || bad "rig body md5 $(md5f)"
psqlc -d x476 < "$HERE/seed.sql"

psqlc -d x476 -At < "$HERE/cases.sql" | grep '^SCAN' > /tmp/x476_before.txt
psqlc -d x476 < "$MIG" && echo "apply ok"
psqlc -d x476 < "$MIG" && echo "re-apply ok"
psqlc -d x476 -At < "$HERE/cases.sql" | grep '^SCAN' > /tmp/x476_after.txt
echo "--- BEFORE"; cat /tmp/x476_before.txt; echo "--- AFTER"; cat /tmp/x476_after.txt

g() { grep "^SCAN $1 " "$2"; }
g TEA4842561 /tmp/x476_before.txt | grep -q -- '-> OLD1 | owner Declined Buyer' && ok "BEFORE reproduces prod: TEA4842561 -> old row, declined buyer named" || bad "before did not reproduce"
g TEA4842561 /tmp/x476_after.txt | grep -q -- '-> NEW1 | owner Current Buyer' && ok "AFTER: TEA4842561 -> current row, current (refunded) buyer" || bad "after TEA4842561"
g OLD1 /tmp/x476_after.txt | grep -q -- '-> NEW1' && ok "AFTER: old code OLD1 also hops to the current row" || bad "after OLD1"
g TEA0000002 /tmp/x476_after.txt | grep -q -- '-> NEW2 | owner Current Buyer' && ok "chain 2: live paid line on new row -> new row" || bad "chain 2"
g TEA0000003 /tmp/x476_after.txt | grep -q -- '-> NEW3' && ok "chain 3: old row picked up -> new row (unchanged)" || bad "chain 3"
g TEA0000004 /tmp/x476_after.txt | grep -q -- '-> OLD4' && ok "chain 4: old row genuinely still owed (paid, open) -> old row (unchanged)" || bad "chain 4"
CH=$(diff /tmp/x476_before.txt /tmp/x476_after.txt | grep -c '^>' || true)
[ "$CH" = "4" ] && ok "only the 4 scans of the TEA4842561 chain changed" || echo "NOTE changed lines: $CH"

psqlc -d x476 < "$RB" && echo "rollback ok"
[ "$(md5f)" = "6a40bb40390d5c812534d791b778fa8a" ] && ok "rollback restores the exact live body" || bad "rollback md5 $(md5f)"
psqlc -d x476 -At < "$HERE/cases.sql" | grep '^SCAN' | diff - /tmp/x476_before.txt >/dev/null && ok "scans after rollback == BEFORE" || bad "rollback scans differ"
psqlc -d x476 < "$MIG" && echo "re-apply after rollback ok"
ACL=$(echo "select proacl::text from pg_proc where oid='public._find_lot_by_scan(text[])'::regprocedure" | psqlc -d x476 -At)
echo "acl after: $ACL"
docker exec "$C" psql -U postgres -qc "DROP DATABASE IF EXISTS x476" >/dev/null
echo "RESULT: $F failure(s)"
exit $F
