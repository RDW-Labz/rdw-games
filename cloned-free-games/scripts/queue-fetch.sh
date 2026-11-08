#!/usr/bin/env bash
# Walk GAMES.queue and clone the next few upstreams into games/.
#
#   scripts/queue-fetch.sh              # clone up to $MAX_PER_RUN (default 2)
#   MAX_PER_RUN=5 scripts/queue-fetch.sh
#   scripts/queue-fetch.sh --dry-run    # show what it would clone, touch nothing
#   scripts/queue-fetch.sh --status     # queue progress only
#   scripts/queue-fetch.sh --queue GAMES.aaa --target /mnt/models/cloned-free-games/games
#                                       # same walker, different queue + destination (the
#                                       # shield holds multi-GB AAA clones; builds stay on btrfs)
#
# This is the deterministic half of the "free phone games" job: no LLM, no judgement,
# just fetch. Every successful clone is pinned into GAMES.lock so scripts/clone-donors.sh
# can recreate it later, and every attempt is appended to .queue/status.tsv.
#
# Safety rules inherited from the 2026-10-30 incident (an unset $name ran `rm -rf games/`):
#   * set -u, a non-empty name check, and an absolute-path guard before anything destructive
#   * nothing here deletes: an existing clone is skipped, never refreshed, never removed
#   * a disk floor (DISK_FLOOR_GB) stops the walk before clones can fill the volume
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GAMES="$ROOT/games"
QUEUE="$ROOT/GAMES.queue"
LOCK="$ROOT/GAMES.lock"
STATUS="$ROOT/.queue/status.tsv"
LOGDIR="$ROOT/logs"
mkdir -p "$GAMES" "$LOGDIR" "$(dirname "$STATUS")"
touch "$STATUS"

MAX_PER_RUN="${MAX_PER_RUN:-2}"
PER_CLONE_TIMEOUT="${PER_CLONE_TIMEOUT:-300}"
DISK_FLOOR_GB="${DISK_FLOOR_GB:-120}"
BIG_REPO_KB="${BIG_REPO_KB:-800000}"   # above this, clone blobless instead of full

dry=0
while (( $# )); do
  case "$1" in
    --dry-run) dry=1; shift ;;
    --status)  dry=2; shift ;;
    --queue)   QUEUE="$2"; shift 2 ;;
    --target)  GAMES="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
QUEUE="$(cd "$(dirname "$QUEUE")" && pwd)/$(basename "$QUEUE")"
mkdir -p "$GAMES"

[[ -f "$QUEUE" ]] || { echo "no GAMES.queue at $QUEUE — run scripts/build-queue.py" >&2; exit 2; }

# --- already-known repos (by clone dir and by upstream url) -------------------
declare -A have_dir have_url
for d in "$GAMES"/*/; do [[ -d "$d" ]] && have_dir["$(basename "$d")"]=1; done
while IFS=$'\t' read -r n u _rest; do
  case "$n" in ''|'#'*) continue ;; esac
  have_dir["$n"]=1
  have_url["${u%.git}"]=1
done < "$LOCK"

# --- self-heal: a scheduler restart mid-checkout leaves an empty worktree -------
# (this is exactly what produced a 324M games/bar with zero files on 2026-11-01)
if (( dry == 0 )); then
  for d in "$GAMES"/*/; do
    d="${d%/}"; n="$(basename "$d")"
    [[ -n "${have_dir[$n]:-}" && -d "$d/.git" ]] || continue
    if [[ -z "$(ls -A "$d" | grep -v '^\.git$' | head -1)" ]]; then
      if git -C "$d" checkout -f HEAD >>"$LOGDIR/clone-queue.log" 2>&1; then
        printf '%s\tREPAIRED\t%s\t%s\t%s\t%s\n' "$(date -Is)" "$n" \
          "$(git -C "$d" rev-parse --short HEAD)" "$(du -sh "$d" | cut -f1)" "checkout" >> "$STATUS"
      else
        printf '%s\tBROKEN\t%s\t-\t-\tcheckout-failed\n' "$(date -Is)" "$n" >> "$STATUS"
      fi
    fi
  done
fi

queued=0; cloned=0; failed=0; skipped=0; out=""
while IFS=$'\t' read -r name url stars lic size_kb source summary; do
  case "$name" in ''|'#'*) continue ;; esac
  queued=$((queued + 1))

  if [[ -n "${have_dir[$name]:-}" || -n "${have_url[${url%.git}]:-}" ]]; then
    skipped=$((skipped + 1)); continue
  fi
  (( dry == 2 )) && { out+="$name (${stars}★, ${source})"$'\n'; continue; }
  (( cloned >= MAX_PER_RUN )) && break

  if (( dry == 1 )); then
    echo "WOULD CLONE: $name  $url  (${size_kb}KB, ${source})"
    cloned=$((cloned + 1)); continue
  fi

  free_gb=$(df -BG --output=avail "$GAMES" | tail -1 | tr -dc '0-9')
  if (( free_gb < DISK_FLOOR_GB )); then
    echo "STOPPING: only ${free_gb}G free, floor is ${DISK_FLOOR_GB}G" | tee -a "$LOGDIR/clone-queue.log"
    break
  fi

  # a URL that has failed three times is dead or needs credentials — stop burning slots
  fails=$(grep -c $'\tFAILED\t'"$name"$'\t' "$STATUS" 2>/dev/null || true)
  if [[ "${fails:-0}" -ge 3 ]]; then
    skipped=$((skipped + 1)); continue
  fi

  dest="$GAMES/$name"
  # hard guard: concrete child of games/, never games/ itself
  if [[ -z "$name" || "$name" == */* || "$name" == "." || "$name" == ".." || "$dest" != "$GAMES/"* || "$dest" == "$GAMES/" ]]; then
    echo "REFUSING bad clone name '$name'" | tee -a "$LOGDIR/clone-queue.log" >&2
    failed=$((failed + 1)); continue
  fi

  started=$(date -Is)
  # -c core.symlinks=false: exfat (the shield) cannot hold symlinks, and a clone that
  # trips over one leaves a half-checked-out tree. git then writes the link target as a
  # plain file instead of failing; core.fileMode=false for the same reason.
  clonecmd=(git -c core.symlinks=false -c core.fileMode=false clone --depth 1 -q "$url" "$dest")
  [[ "$size_kb" =~ ^[0-9]+$ ]] || size_kb=0   # a stray header row must not abort the walk
  (( size_kb > BIG_REPO_KB )) && clonecmd=(git -c core.symlinks=false -c core.fileMode=false clone --depth 1 --filter=blob:none -q "$url" "$dest")

  if timeout "$PER_CLONE_TIMEOUT" "${clonecmd[@]}" >>"$LOGDIR/clone-queue.log" 2>&1; then
    if [[ -z "$(ls -A "$dest" | grep -v '^\.git$' | head -1)" ]]; then
      git -C "$dest" checkout -f HEAD >>"$LOGDIR/clone-queue.log" 2>&1
    fi
    head_sha=$(git -C "$dest" rev-parse --short HEAD 2>/dev/null || echo "?")
    size=$(du -sh "$dest" 2>/dev/null | cut -f1)
    printf '%s\t%s\t%s\n' "$name" "$url" "$head_sha" >> "$LOCK"   # name/url/pin only — col 4 is sparse paths
    printf '%s\tCLONED\t%s\t%s\t%s\t%s\n' "$started" "$name" "$head_sha" "$size" "$source" >> "$STATUS"
    out+="↓ $name  $head_sha  $size  (${source})"$'\n'
    cloned=$((cloned + 1))
  else
    rm -rf -- "$dest" 2>/dev/null   # only ever this exact dir, verified above
    printf '%s\tFAILED\t%s\t-\t-\t%s\n' "$started" "$name" "$source" >> "$STATUS"
    echo "✗ $name ($url) — see $LOGDIR/clone-queue.log" >> "$LOGDIR/clone-queue.log"
    out+="✗ $name failed"$'\n'
    failed=$((failed + 1))
  fi
done < "$QUEUE"

total=$(( $(grep -vc '^#' "$QUEUE") - 1 ))   # minus the header line
known=$(awk -F'\t' 'NR>1 && !/^#/ {print $1}' "$QUEUE" | while read -r n; do
          [[ -n "${have_dir[$n]:-}" ]] && echo "$n"; done | wc -l)
remaining=$(( total - known ))

if (( dry == 2 )); then
  printf 'queue: %s repos, %s already cloned, %s pending\n%s' "$total" "$skipped" "$remaining" "$out" | head -40
  exit 0
fi

# keep the record of what got cloned in git — local commit only, pushing stays a human step
if (( cloned > 0 )) && [[ -d "$ROOT/.git" ]]; then
  git -C "$ROOT" add GAMES.lock "$QUEUE" >/dev/null 2>&1
  git -C "$ROOT" commit -q -m "queue: fetch $cloned clone(s)" --no-verify >/dev/null 2>&1 || true
fi

[[ -n "$out" ]] && printf '%s' "$out"
printf 'queue %s · cloned %s · skipped %s · failed %s · %s remaining\n' \
  "$total" "$cloned" "$skipped" "$failed" "$remaining"
exit 0
