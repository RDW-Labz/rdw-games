#!/usr/bin/env bash
# Clone (or refresh) donor game sources into games/.
#
#   scripts/clone-donors.sh                # every entry in GAMES.lock
#   scripts/clone-donors.sh wesnoth crawl  # just these
#
# games/ is gitignored: these are upstream mirrors, not vendored content. Re-running is
# safe and idempotent — an existing clone is fetched, never deleted.
#
# The failure this script exists to prevent: an earlier one-off did `rm -rf "games/$name"`
# with an unset name and wiped all 20 GB of mirrors, because a bare assignment list like
# `name=$1 url=$2 shift 2` only sets those vars for the `shift` command. Hence: set -u,
# a non-empty name check, and an absolute-path guard before anything destructive runs.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GAMES="$ROOT/games"
LOCK="$ROOT/GAMES.lock"
mkdir -p "$GAMES"

# name \t url \t pinned-commit \t sparse-paths (optional, space separated)
entries() {
  while IFS=$'\t' read -r name url commit sparse; do
    case "$name" in ''|'#'*) continue ;; esac
    printf '%s\t%s\t%s\t%s\n' "$name" "$url" "$commit" "${sparse:-}"
  done < "$LOCK"
}

clone_one() {
  local name="$1" url="$2" sparse="${3:-}"
  local dest="$GAMES/$name"

  # hard guard: never operate on anything but a concrete child of games/
  if [[ -z "$name" || "$name" == */* || "$name" == "." || "$name" == ".." ]]; then
    echo "REFUSING: bad clone name '${name}'" >&2
    return 1
  fi
  if [[ "$dest" != "$GAMES/"* || "$dest" == "$GAMES/" ]]; then
    echo "REFUSING: destination '$dest' is not inside '$GAMES/'" >&2
    return 1
  fi

  if [[ -d "$dest/.git" ]]; then
    echo "↻ $name"
    git -C "$dest" fetch --depth 1 -q origin || { echo "  fetch failed"; return 1; }
    git -C "$dest" reset --hard -q FETCH_HEAD || return 1
  else
    echo "↓ $name"
    if [[ -n "$sparse" ]]; then
      git clone --depth 1 --filter=blob:none --sparse -q "$url" "$dest" || return 1
      # shellcheck disable=SC2086
      git -C "$dest" sparse-checkout set $sparse || return 1
    else
      git clone --depth 1 -q "$url" "$dest" || return 1
    fi
  fi
  printf '  %s  %s  %s\n' "$(du -sh "$dest" | cut -f1)" "$(git -C "$dest" rev-parse --short HEAD)" "$(basename "$url" .git)"
}

wanted=("$@")
rc=0
while IFS=$'\t' read -r name url commit sparse; do
  if ((${#wanted[@]})) && [[ ! " ${wanted[*]} " == *" $name "* ]]; then continue; fi
  clone_one "$name" "$url" "$sparse" || rc=1
done < <(entries)

echo "---"
du -sh "$GAMES"/* 2>/dev/null | sort -h | tail -5
exit $rc
