#!/usr/bin/env bash
# Publish the scraped game catalog + clone queue to RDW-Labz/rdw-games, branch main.
#
# The scrape keeps writing to ~/cloned-free-games exactly as before (queue -> clones ->
# judge -> CATALOG.md). This script is the only thing that changed: instead of the output
# dying on this box (the repo has been ~267 commits ahead of its old remote for weeks),
# every run mirrors the tracked artifacts into rdw-games/cloned-free-games/ and pushes.
#
# Mirrored (verbatim, no reformatting — the catalog format is the contract):
#   README.md CATALOG.md GAMES.lock GAMES.queue GAMES.aaa .gitignore scripts/*
# Never mirrored: games/ (gitignored multi-GB clones), evidence/, .queue/ (raw scrape
# inputs), build-*.log — local-only or reproducible, and not part of the catalog.
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

TRACKED=(README.md CATALOG.md GAMES.lock GAMES.queue GAMES.aaa .gitignore)

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
mkdir -p "$DEST/scripts" || die "cannot create $DEST"

# --- mirror ---
for f in "${TRACKED[@]}"; do
  [ -f "$f" ] || die "missing tracked artifact: $f"
  cp -f "$f" "$DEST/$f" || die "copy $f failed"
done
cp -f scripts/*.sh scripts/*.py "$DEST/scripts/" || die "copy scripts/ failed"

# --- commit ---
cd "$WORK" || die "cannot cd $WORK"
git add -A -- "$PREFIX" >/dev/null || die "git add failed"

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
