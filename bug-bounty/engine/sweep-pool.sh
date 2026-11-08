#!/usr/bin/env bash
# Big paying-pool sweep: seed fresh zones from programmes that pay, enumerate, resolve, classify.
set -uo pipefail
cd /home/cluer/Projects/bug-bounty/engine || exit 1
{
  echo "=== $(date -u +%FT%TZ) paying-pool sweep start"
  python3 programs.py seed --limit 280 --order big --per-program 4
  python3 dangling.py run --tier bounty: --workers 2 --max-domains 400 --days 7
  echo "=== $(date -u +%FT%TZ) done rc=$?"
} >> sweep-bounty2.log 2>&1
