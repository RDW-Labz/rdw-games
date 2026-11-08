#!/usr/bin/env bash
# Verify that a documented rollback range actually reverts the change (issue #750).
#
# A RED TEAM PASS on #745/#740 named `git revert d4b7e4e2..53bc539c` as its
# rollback, but that range starts *after* the implementation commit
# (`d4b7e4e2`), so it reverted only the later fixture commit and left the
# feature in place. Reading the range is not enough — this replays it on a
# throwaway worktree and compares the touched files against the base commit.
#
# Usage:
#   scripts/prod-rig/0750-verify-rollback-range.sh \
#     <restore-point> <range-start> <head> <file> [<file>...]
#
#   <restore-point>  commit the files must come back to (the PR base, i.e. what
#                    the rollback is documented to undo)
#   <range-start>    first commit of the documented `git revert <start>..<head>`
#   <head>           last commit of that range (normally the PR head)
#   <file>           path the change touches; every listed file must end up
#                    byte-for-byte identical to <restore-point>
#
# The two are separate because that is exactly how #750 went wrong: the stated
# range started at the implementation commit, so it restored "to" the
# implementation instead of to the PR base.
#
# Exit codes: 0 = restored exactly, 1 = not restored / command failed,
#             2 = usage or repository problem.
set -euo pipefail

# Inherited Git plumbing variables can silently redirect every command below
# (the index, the work tree, the object store) and defeat the throwaway
# worktree. Drop them before doing anything so the verification only ever
# touches its own temporary worktree — never the caller's checkout or index.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_PREFIX GIT_SUPER_PREFIX \
  GIT_QUARANTINE_PATH GIT_CEILING_DIRECTORIES GIT_DISCOVERY_ACROSS_FILESYSTEM \
  GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT 2>/dev/null || true

die() { printf 'rollback-range: %s\n' "$1" >&2; exit "${2:-1}"; }

if [ "$#" -lt 4 ]; then
  die "usage: $0 <restore-point> <range-start> <head> <file> [<file>...]" 2
fi

base_arg="$1"
start_arg="$2"
head_arg="$3"
base="$base_arg"
start="$start_arg"
head="$head_arg"
shift 3
files=("$@")

repo="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository" 2

# Resolve every input exactly once, here in the caller. The temp worktree is
# detached at <head>, so a HEAD-relative expression resolved again inside it
# names a different commit and could certify restoration to the wrong version.
base="$(git -C "$repo" rev-parse --verify --quiet "${base}^{commit}")" \
  || die "unknown base commit: $base_arg" 2
start="$(git -C "$repo" rev-parse --verify --quiet "${start}^{commit}")" \
  || die "unknown range-start commit: $start_arg" 2
head="$(git -C "$repo" rev-parse --verify --quiet "${head}^{commit}")" \
  || die "unknown head commit: $head_arg" 2

git -C "$repo" merge-base --is-ancestor "$start" "$head" \
  || die "range start $start is not an ancestor of head $head" 2

tmp="$(mktemp -d "${TMPDIR:-/tmp}/rollback-range.XXXXXX")"
cleanup() {
  git -C "$repo" worktree remove --force "$tmp" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

git -C "$repo" worktree add --detach "$tmp" "$head" >/dev/null 2>&1 \
  || die "could not create a worktree at $head" 2

for f in "${files[@]}"; do
  [ -e "$tmp/$f" ] || die "file missing at head $head: $f" 2
done

# A clean detached worktree lets `git revert` stage without touching the
# caller's checkout or index.
git -C "$tmp" revert --no-commit --no-edit "${start}..${head}" >/dev/null 2>&1 \
  || die "git revert ${start}..${head} failed on head $head" 1

status=0
for f in "${files[@]}"; do
  if ! git -C "$tmp" diff --quiet "$base" -- "$f"; then
    printf 'rollback-range: NOT RESTORED: %s (range %s..%s, expected %s)\n' \
      "$f" "$start" "$head" "$base" >&2
    status=1
  fi
done

# Check what the *range itself* changes, not what differs from the restore
# point: the base..head span can legitimately carry unrelated work that the
# documented range must leave alone. A range that touches a path outside the
# documented rollback fails; a narrow range that leaves unrelated work intact
# passes.
range_paths="$(git -C "$tmp" diff --name-only "${start}..${head}")"
extra="$(printf '%s\n' "$range_paths" \
  | grep -v '^$' \
  | grep -vxF -f <(printf '%s\n' "${files[@]}") || true)"
if [ -n "$extra" ]; then
  printf 'rollback-range: range also reverts unrelated paths:\n%s\n' "$extra" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  printf 'rollback-range: OK — %s..%s restores %d file(s) to %s\n' \
    "$start" "$head" "${#files[@]}" "$base"
fi
exit "$status"
