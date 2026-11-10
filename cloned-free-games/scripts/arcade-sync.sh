#!/usr/bin/env bash
# Bring every game we can into the browser, then publish the catalog.
#
# Runs unattended (systemd timer, nightly). Each step is idempotent and only touches
# what changed, so a quiet night costs a scan and nothing else:
#
#   detect    find clones whose static build already runs from the repo as-is
#   build     build the clones that carry their own `npm run build`, validate the output,
#             and allow-list the ones that pass (auto-build.py)
#   promote   mirror the allow-listed ones into .site-play/ (what /play/<slug>/ serves)
#   plan      re-classify every clone into a conversion lane (web-buildable / asset-donor /
#             native-only) so the next port to write is always named, plus disk accounting
#   publish   catalog + mirrors + gate function -> Cloudflare Pages
#
# Set NO_PUBLISH=1 to stop after the plan (e.g. while iterating on a port by hand).
# Set NO_BUILD=1 to skip the build step (it is the only stage that installs packages).
set -uo pipefail

SRC=${SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
STATE=${STATE:-$HOME/.local/state}
mkdir -p "$STATE"
LOG=$STATE/games-arcade.log
export STATE

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

say "=== arcade sync start ==="
cd "$SRC" || exit 1

# 1. Detector. Its own budget is bounded; a hung scan must not wedge the night.
timeout 1200 python3 scripts/detect-web-games.py >>"$LOG" 2>&1
rc=$?
[ $rc -eq 0 ] || say "detect rc=$rc — continuing with the last known list"

# 1b. Build lane. Two candidates a night, each with its own timeout; a failure is recorded
# in scripts/playable-block.txt so tomorrow's run spends its two slots on fresh trees.
if [ -z "${NO_BUILD:-}" ]; then
  # Disk guard: a build is the only stage that writes hundreds of MB of scratch, and a full
  # disk breaks the publish that follows. Skip (don't fail) when headroom is thin.
  free_gb=$(df -BG --output=avail "$SRC" | tail -1 | tr -dc '0-9')
  if [ "${free_gb:-0}" -lt "${MIN_FREE_GB:-20}" ]; then
    say "build: skipped, only ${free_gb}G free (MIN_FREE_GB=${MIN_FREE_GB:-20})"
  else
    # Leftovers from an interrupted run are the only unbounded growth in .build/.
    find "$SRC/.build/src" -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec rm -rf {} + 2>/dev/null
    timeout 3000 python3 scripts/auto-build.py --max 2 >>"$LOG" 2>&1
    rc=$?
    [ $rc -eq 0 ] || say "auto-build rc=$rc — continuing"
    say "build: $(python3 - <<'PY'
import json, pathlib
p = pathlib.Path('.queue/auto-build.json')
try:
    d = json.loads(p.read_text())
    ok = ', '.join(r['slug'] for r in d.get('passed', [])) or 'none'
    bad = ', '.join(r['slug'] for r in d.get('failed', [])) or 'none'
    print(f"built={ok} failed={bad}")
except Exception as e:
    print(f"no build report ({e})")
PY
)"
  fi
fi

# 1c. Playtest lane. Every detected-but-unshipped static build gets loaded in headless
# Chromium: uncaught errors, failed local requests and blank renders are failures. Passes are
# appended to scripts/playable-auto.txt (shipped by promote below), failures to
# scripts/playable-block.txt so tomorrow's run doesn't chew the same broken tree. This is what
# makes "it built" different from "it plays" without a human in the loop.
if command -v node >/dev/null && command -v chromium >/dev/null && command -v magick >/dev/null; then
  timeout 1800 node scripts/playtest-web.mjs --from-queue --auto-promote >"$STATE/playtest-last.log" 2>&1
  rc=$?
  say "playtest rc=$rc: $(grep -E '^this run' "$STATE/playtest-last.log" | tr '\n' ' ' | cut -c1-240)"
else
  say "playtest: skipped (node, chromium or magick missing)"
fi


# 2. Mirror. Allow-listed only: playable-allow.txt is hand-played, playable-auto.txt is
# what the build lane validated (all refs on disk, no CDN). Nothing ships unvetted.
timeout 1800 python3 scripts/promote-web-games.py --prune >>"$LOG" 2>&1
rc=$?
[ $rc -eq 0 ] || { say "promote rc=$rc — aborting before publish"; exit 1; }
say "promote: $(grep -E '^PLAYABLE ' "$LOG" | tail -1)"

# 3. Plan. Cheap and read-only; this is what tells the next session what to port, and the
# only place disk growth is measured (clones kept, published bytes, per-port art budget).
timeout 1800 python3 scripts/port-plan.py --src . --quiet >>"$LOG" 2>&1
say "plan: $(python3 - <<'PY'
import json, pathlib
p = pathlib.Path('.queue/port-plan.json')
try:
    d = json.loads(p.read_text())
    lanes = ', '.join(f"{k}={v}" for k, v in sorted(d.get('by_lane', {}).items()))
    disk = d.get('disk') or {}
    print(f"{lanes} | games/ {disk.get('games_dir_mb', 0)/1024:.1f} GB, "
          f"published {disk.get('published_mb', {}).get('play', 0):.1f} MB, "
          f"{disk.get('free_gb', 0):.0f} GB free")
except Exception as e:
    print(f"unreadable ({e})")
PY
)"

if [ -n "${NO_PUBLISH:-}" ]; then
  say "=== arcade sync done (NO_PUBLISH) ==="
  exit 0
fi

# 4. Publish. Restages the shelf, re-renders the catalog with the play mirrors, redeploys.
timeout 1800 scripts/publish-site.sh >>"$LOG" 2>&1
rc=$?
if [ $rc -eq 0 ]; then
  say "published: $(grep -E '^DEPLOYED ' "$LOG" | tail -1)"
else
  say "publish rc=$rc — see $LOG"
fi
say "=== arcade sync done ==="
exit $rc
