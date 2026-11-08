#!/bin/bash
# Finish the paying-scope sweep: the 234 zones still carrying last_enum IS NULL.
# Same chain as sweep-missing2, but the enum passes are told to take everything left rather than a
# fixed slice, and the tail stages only touch what the enum just added.
set -uo pipefail
cd /home/cluer/Projects/bug-bounty || exit 1
echo "=== start $(date -u +%FT%TZ)  pending=$(sqlite3 engine/state.db 'select count(*) from domains where last_enum is null')"
for t in 1 2 3 4; do
  echo "=== enum tier $t $(date -u +%FT%TZ)"
  python3 engine/dangling.py enum --tier "$t" --max-domains 400 --workers 4 || echo "enum tier $t rc=$?"
  echo "=== after tier $t pending=$(sqlite3 engine/state.db 'select count(*) from domains where last_enum is null')"
done
for stage in cname resolve reclass report; do
  echo "=== $stage $(date -u +%FT%TZ)"
  python3 "engine/dangling.py" "$stage" --workers 16 || echo "$stage rc=$?"
done
echo "=== fingerprint $(date -u +%FT%TZ)"
python3 engine/fingerprint.py run --workers 10 || echo "fingerprint rc=$?"
echo "=== totals $(date -u +%FT%TZ)"
sqlite3 engine/state.db "select 'hosts',count(*) from hosts union all select 'cnames',count(*) from cnames union all select 'claimable',count(*) from findings where claimable=1;"
echo "=== sweep3 exit 0 $(date -u +%FT%TZ)"
