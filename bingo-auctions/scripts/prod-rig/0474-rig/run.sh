#!/bin/sh
# 0474 proof on the Docker prod copy (rig0431), from the host:
#   sh scripts/prod-rig/0474-rig/run.sh
# x474 = rig0431's prod-schema template `postgres` + seed + 0474 (twice) +
# cases; then rollback, check nothing is left, re-apply. Only x474 is touched.
set -e
C=${C:-rig0431}
PENDING=${PENDING:-$HOME/Documents/bingo-migrations-pending}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG=$PENDING/0474_refund_override.sql
ROLLBACK=$HERE/../0474_ROLLBACK_refund_override.sql
psqlc() { docker exec -i "$C" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

echo "0474 sha256: $(shasum -a 256 "$MIG" | cut -d' ' -f1)"
docker exec "$C" psql -U postgres -qc "DROP DATABASE IF EXISTS x474" -c "CREATE DATABASE x474 TEMPLATE postgres"
psqlc -d x474 < "$HERE/seed.sql"
psqlc -d x474 < "$MIG" && echo "apply ok"
psqlc -d x474 < "$MIG" && echo "re-apply ok"

echo "===== CASES"
psqlc -d x474 -At < "$HERE/cases.sql" | tee /tmp/x474_cases.out | grep -E '^(PASS|FAIL)'
echo "cases: $(grep -c '^PASS' /tmp/x474_cases.out) PASS / $(grep -c '^FAIL' /tmp/x474_cases.out) FAIL"

psqlc -d x474 < "$ROLLBACK" && echo "rollback ok"
LEFT=$(docker exec "$C" psql -U postgres -d x474 -Atc "select count(*) from pg_proc where proname in ('record_refund_override','refund_override_settings_set')")
T=$(docker exec "$C" psql -U postgres -d x474 -Atc "select coalesce(to_regclass('public.refund_overrides')::text,'') || coalesce(to_regclass('public.refund_override_settings')::text,'')")
[ "$LEFT" = "0" ] && [ -z "$T" ] && echo "PASS rollback removed functions + tables" || echo "FAIL rollback left: $LEFT functions, tables '$T'"
psqlc -d x474 < "$MIG" && echo "re-apply after rollback ok"
docker exec "$C" psql -U postgres -qc "DROP DATABASE IF EXISTS x474"
