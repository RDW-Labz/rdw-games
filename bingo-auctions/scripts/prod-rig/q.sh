#!/bin/zsh
# usage: q.sh file.sql  -> dispatch prod read-only query, wait, print JSON rows
# Output also lands in <file>.out. SELECT/WITH only; no double quotes in the SQL.
F=${1:A}
[ -f "$F" ] || { echo "usage: q.sh file.sql" >&2; exit 1; }
cd "${0:A:h}/../.." || exit 1
# The file is sent as one line, so a "--" comment would swallow the rest of
# the query: drop line comments first. (A "--" inside a string literal would be
# cut too; keep those out of q.sh queries.)
SQL=$(sed -e 's/--.*$//' "$F" | tr '\n' ' ')
case "$SQL" in *'"'*) echo "q.sh: no double quotes in the SQL (the workflow input breaks on them)" >&2; exit 1;; esac
B=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run apply-migration.yml -f mode=query -f "sql=$SQL" >/dev/null || exit 1
# The first run created at or after the dispatch is ours. Another session's
# query dispatched in the same second could still be picked; check the rows.
for i in $(seq 1 20); do
  ID=$(gh run list --workflow apply-migration.yml -L 10 --json databaseId,createdAt -q "[.[] | select(.createdAt >= \"$B\")] | last | .databaseId // empty")
  [ -n "$ID" ] && break; sleep 3
done
[ -n "$ID" ] || { echo "q.sh: dispatched run not found" >&2; exit 1; }
gh run watch $ID >/dev/null 2>&1
# Don't filter on the step name: gh now labels every step "UNKNOWN STEP".
# The rows are the top-level JSON array the query step prints: a line that is
# exactly "[" through the next line that is exactly "]" (or a bare "[]").
# Right after a run completes GitHub can serve a log missing its later steps,
# so fetch again until the rows or an error show up.
for i in 1 2 3 4 5 6; do
  LOG=$(gh run view $ID --log | cut -f3- | sed -E 's/^[0-9T:.-]+Z //')
  print -r -- "$LOG" | awk '/^\[\]$/{print; exit} /^\[$/{f=1} f{print} f&&/^\]$/{exit}' > "${F%.sql}.out"
  [ -s "${F%.sql}.out" ] && break
  print -r -- "$LOG" | grep -q '^##\[error\]' && break
  sleep 10
done
if [ -s "${F%.sql}.out" ]; then
  head -c 40000 "${F%.sql}.out"
else
  echo "q.sh: no rows in run $ID" >&2
  print -r -- "$LOG" | grep -m3 '^##\[error\]' | cut -c1-600 >&2
  echo "q.sh: run conclusion: $(gh run view $ID --json conclusion -q .conclusion)" >&2
  exit 1
fi
