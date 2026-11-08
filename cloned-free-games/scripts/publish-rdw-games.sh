#!/usr/bin/env bash
# Publish the scraped game catalog + clone queue to RDW-Labz/rdw-games, branch main.
#
# The scrape keeps writing to ~/cloned-free-games exactly as before (queue -> clones ->
# judge -> CATALOG.md). This script is the only thing that changed: instead of the output
# dying on this box (the repo has been ~267 commits ahead of its old remote for weeks),
# every run mirrors the tracked artifacts into rdw-games/cloned-free-games/ and pushes.
#
# Mirrors every file the repo tracks (`git ls-files`, currently 108 files: README.md,
# CATALOG.md, GAMES.lock, GAMES.queue, GAMES.aaa, .gitignore, scripts/*, evidence/*) verbatim —
# no reformatting, the catalog format is the contract. Parity is defined by git itself, so a
# new tracked artifact carries over on the next run and a deleted one is pruned.
# Never mirrored: untracked local state — games/ (multi-GB clones), .queue/ (raw scrape
# inputs), build logs that were never committed.
#
#   scripts/publish-rdw-games.sh              # mirror + commit + push
#   DRY_RUN=1 scripts/publish-rdw-games.sh    # show the file diff, push nothing
#
# Prints "PUSHED <sha>" or "UNCHANGED <sha>" on success; exits non-zero on any failure.
set -uo pipefail

SRC=${SRC:-/home/cluer/cloned-free-games}
REPO_SLUG=${REPO_SLUG:-RDW-Labz/rdw-games}
BRANCH=${BRANCH:-main}
PREFIX=${PREFIX:-cloned-free-games}
WORK=${WORK:-$HOME/.cache/rdw-games-publish}
REMOTE=${REMOTE:-https://github.com/$REPO_SLUG.git}

die() { echo "FAIL: $*" >&2; exit 1; }

[ -d "$SRC" ] || die "source repo not found: $SRC"
cd "$SRC" || die "cannot cd $SRC"

# --- work tree: shallow + sparse clone of rdw-games, only the cloned-free-games/ prefix ---
if [ ! -d "$WORK/.git" ]; then
  rm -rf "$WORK"
  mkdir -p "$(dirname "$WORK")"
  git clone --quiet --depth 1 --no-checkout --branch "$BRANCH" "$REMOTE" "$WORK" \
    || die "clone of $REPO_SLUG failed"
  git -C "$WORK" sparse-checkout init --no-cone >/dev/null 2>&1
  git -C "$WORK" sparse-checkout set "/$PREFIX/" >/dev/null 2>&1
  git -C "$WORK" checkout --quiet "$BRANCH" || die "checkout of $BRANCH failed"
else
  git -C "$WORK" fetch --quiet origin "$BRANCH" || die "fetch failed"
  git -C "$WORK" reset --quiet --hard "origin/$BRANCH" || die "reset failed"
fi

DEST="$WORK/$PREFIX"
mkdir -p "$DEST" || die "cannot create $DEST"

# --- mirror every file the repo tracks (nothing hand-picked: parity with what this repo
#     publishes is defined by `git ls-files`, so new artifacts carry over automatically) ---
mapfile -d '' FILES < <(git -C "$SRC" ls-files -z) || die "git ls-files failed"
[ "${#FILES[@]}" -gt 0 ] || die "no tracked files in $SRC"
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "WARN: tracked but missing on disk: $f" >&2; continue; }
  mkdir -p "$DEST/$(dirname "$f")" || die "mkdir for $f failed"
  cp -f "$SRC/$f" "$DEST/$f" || die "copy $f failed"
done

# prune anything previously published that the repo no longer tracks (deletions propagate)
if [ -d "$DEST" ]; then
  while IFS= read -r rel; do
    [ -n "$rel" ] && rm -f "$DEST/$rel"
  done < <(cd "$DEST" && find . -type f -printf '%P\n' | sed 's|^\./||' \
             | sort > "$WORK/.pub-dest.txt"; printf '%s\n' "${FILES[@]}" | sort > "$WORK/.pub-src.txt"; \
             comm -23 "$WORK/.pub-dest.txt" "$WORK/.pub-src.txt")
fi
echo "mirrored ${#FILES[@]} tracked files -> $PREFIX/"

# --- commit ---
cd "$WORK" || die "cannot cd $WORK"
# -f is required: the mirrored set is defined by the source repo's index, so files the source
# tracks but its own .gitignore would exclude (build-*.log) must still be published.
git add -Af -- "$PREFIX" >/dev/null || die "git add failed"

if git diff --cached --quiet -- "$PREFIX"; then
  SHA=$(git rev-parse HEAD)
  echo "UNCHANGED $SHA  (rdw-games already matches $SRC)"
  exit 0
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY RUN — would push these changes to $REPO_SLUG@$BRANCH:"
  git diff --cached --stat -- "$PREFIX"
  exit 0
fi

JUDGED=$(grep -cE '^\| *[0-9]+ *\|' "$SRC/CATALOG.md" 2>/dev/null || echo 0)
QUEUED=$(( $(wc -l < "$SRC/GAMES.queue") - 1 ))
MSG="catalog: daily publish $(date -u +%Y-%m-%d) — $JUDGED judged, $QUEUED queued"

git -c user.name="RDW scrape" -c user.email="scrape@cluerholdings.com" \
    commit --quiet -m "$MSG" -- "$PREFIX" || die "commit failed"

GIT_TERMINAL_PROMPT=0 git push --quiet origin "HEAD:$BRANCH" || die "push to $REPO_SLUG@$BRANCH failed"

SHA=$(git rev-parse HEAD)
echo "PUSHED $SHA  $MSG"
echo "https://github.com/$REPO_SLUG/commit/$SHA"
