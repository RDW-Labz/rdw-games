#!/usr/bin/env bash
# Publish the free-phone-games catalog to game.cluerholdings.com (Cloudflare Pages,
# project internal-hybrid-builds), behind the existing sign-in gate.
#
# The Pages project serves the KAOS shelf from the site repo at $SITE_REPO. A direct
# upload replaces the whole deployment, so this script never uploads a catalog-only
# tree: it re-stages the shelf exactly as $SITE_REPO's deploy.sh does (REF=HEAD, so the
# result is reproducible and independent of that repo's working tree), injects the
# catalog at /catalog/, and uploads the combination. Net effect: shelf untouched,
# catalog refreshed, gate function (_middleware.js) redeployed unchanged.
#
# Auth: wrangler's stored OAuth session (~/.config/.wrangler). No API token needed.
#
#   scripts/publish-site.sh            # build + deploy
#   DRY_RUN=1 scripts/publish-site.sh  # build + stage, print the staged catalog, upload nothing
#
# Requires: python3, npx (wrangler), and a clean-enough $SITE_REPO at HEAD.
set -uo pipefail

PUBLISH_SCRIPTS=$(cd "$(dirname "$0")" && pwd)
SRC=${SRC:-$(dirname "$PUBLISH_SCRIPTS")}
SITE_REPO=${SITE_REPO:-$HOME/kaos/work/site}
PROJECT=${PROJECT:-internal-hybrid-builds}
ACCOUNT=${CLOUDFLARE_ACCOUNT_ID:-1ed454d65f1c74ae9cd7089c2460deef}
WORK=${WORK:-$HOME/.cache/rdw-games-publish/site}
SITE_PATH=${SITE_PATH:-}                # URL path the catalog lands on ("" = site root)
SHELF_PATH=${SHELF_PATH:-shelf}         # where the shelf moves to when the catalog takes root
DRY_RUN=${DRY_RUN:-}
ORIGINALS_BUILDS=${ORIGINALS_BUILDS:-$HOME/.cache/rdw-games-publish/originals}

die() { echo "FAIL: $*" >&2; exit 1; }

[ -d "$SITE_REPO" ] || die "site repo not found: $SITE_REPO"
[ -x "$SITE_REPO/deploy.sh" ] || die "no deploy.sh in $SITE_REPO"
command -v python3 >/dev/null || die "python3 missing"

rm -rf "$WORK"; mkdir -p "$WORK" || die "cannot create $WORK"

# 1. Resolve where each card should send people (game site / store page / releases). Offline,
#    from the .queue cache; a missing cache just means fewer play buttons, never a broken card.
python3 "$SRC/scripts/collect-play-links.py" --src "$SRC" || echo "WARN: play links not resolved" >&2

# 2. Render the catalog from the repo's own artifacts. With LIBRARY=1 (default now) the
#    rendered card catalog is only an AUDIT INPUT: it is the exact list of tiles the old
#    page would have shown, so the audit judges the shipped card set rather than the repo.
#    What gets published is the playable library face, built from the audit verdicts.
LIBRARY=${LIBRARY:-1}
CATSRC="$WORK/catalog-src"
python3 "$SRC/scripts/make-catalog-site.py" --src "$SRC" --out "$CATSRC" \
  --icon-cache "$HOME/.cache/rdw-games-publish/icons" || die "catalog render failed"
[ -s "$CATSRC/index.html" ] || die "catalog render produced no index.html"
echo "CATALOG $(du -h "$CATSRC/index.html" | cut -f1) $(python3 -c "
import json,sys
d=json.load(open('$CATSRC/games.json'))
print(f\"{d['total']} queued / {d['judged']} judged\")")"

if [ -n "$LIBRARY" ]; then
  # External "links-out" cards are only promotable through .queue/embed-verified.json, and
  # scripts/embed-probe.py is its only writer. Refresh it when it is missing or stale
  # (EMBED_PROBE_MAX_AGE_H days) so the bridge can never go dormant again — a failed probe
  # never blocks the deploy, it just leaves yesterday's verdicts in place.
  EV="$SRC/.queue/embed-verified.json"
  MAXAGE=${EMBED_PROBE_MAX_AGE_H:-336}
  if [ ! -s "$EV" ] || [ -n "$(find "$EV" -mmin +$((MAXAGE*60)) 2>/dev/null)" ]; then
    echo "EMBED-PROBE stale or missing — probing links-out URLs"
    python3 "$SRC/scripts/embed-probe.py" --src "$SRC" --workers 4 --wait 9 \
      || echo "WARN: embed probe failed; keeping existing embed-verified.json" >&2
  fi
  LIB_SRC="$SRC" python3 "$SRC/scripts/library-audit.py" --src "$SRC" --site-repo "$SITE_REPO" \
    --games-json "$CATSRC/games.json" || die "library audit failed"

  # Tile art: real in-game screenshots, one per live tile. REFRESH_ART=1 re-captures them
  # against a throwaway server that mirrors the deployed layout (/play/<slug>/ + /games/arcade/);
  # otherwise the last capture in .queue/lib-art is reused (a stale shot is cosmetic, a
  # missing shot falls back to the generated monogram plate, so neither blocks a deploy).
  if [ -n "${REFRESH_ART:-}" ]; then
    ARTROOT="$WORK/artroot"; rm -rf "$ARTROOT"; mkdir -p "$ARTROOT/games"
    [ -d "$SRC/.site-play" ] && cp -R "$SRC/.site-play" "$ARTROOT/play"
    git -C "$SITE_REPO" archive HEAD games/arcade | tar -x -C "$ARTROOT" \
      || echo "WARN: could not stage the arcade for art capture" >&2
    python3 -c "
import json,sys
d=json.load(open('$SRC/.queue/library-audit.json'))
json.dump([{'name':r['name'],'slug':r.get('slug') or r['name'],'url':r['launch']} for r in d['entries_live']],
          open('$SRC/.queue/library-art-tiles.json','w'))"
    ( cd "$ARTROOT" && python3 -m http.server 8791 --bind 127.0.0.1 >/dev/null 2>&1 & echo $! >"$WORK/art.pid" )
    sleep 1
    node "$SRC/scripts/lib-art.mjs" --base http://127.0.0.1:8791 --out "$SRC/.queue/lib-art" || echo "WARN: art capture incomplete" >&2
    kill "$(cat "$WORK/art.pid")" 2>/dev/null || true
  fi

  python3 "$PUBLISH_SCRIPTS/make-library.py" --audit "$SRC/.queue/library-audit.json" \
    --art "$SRC/.queue/lib-art" --site-repo "$SITE_REPO" --out "$WORK/catalog" || die "library face render failed"
  [ -s "$WORK/catalog/index.html" ] || die "library face produced no index.html"
  echo "LIBRARY $WORK/catalog"
else
  cp -R "$CATSRC/." "$WORK/catalog/" 2>/dev/null || { mkdir -p "$WORK/catalog"; cp -R "$CATSRC/." "$WORK/catalog/"; }
fi

# 2. Stage the shelf with the site repo's own deploy.sh, keeping the staging dir.
#    deploy.sh deletes its temp dir in an EXIT trap, so run a copy with the trap
#    replaced by a fixed path.
SHELF_STAGE="$WORK/stage"
sed -e "s|^STAGE=\$(mktemp -d); trap 'rm -rf \"\$STAGE\"' EXIT|STAGE=$SHELF_STAGE; rm -rf \"\$STAGE\"; mkdir -p \"\$STAGE\"|" \
    "$SITE_REPO/deploy.sh" > "$SITE_REPO/.deploy-stage.$$.sh" || die "could not prepare stager"
chmod +x "$SITE_REPO/.deploy-stage.$$.sh"
( cd "$SITE_REPO" && REF=HEAD STAGE_ONLY=1 CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" ./.deploy-stage.$$.sh ) >"$WORK/stage.log" 2>&1
rc=$?
rm -f "$SITE_REPO/.deploy-stage.$$.sh"
[ $rc -eq 0 ] || { tail -20 "$WORK/stage.log" >&2; die "shelf staging failed (rc=$rc)"; }
grep -q "STAGE_ONLY=1: nothing uploaded" "$WORK/stage.log" || die "stager did not run in STAGE_ONLY mode"
[ -f "$SHELF_STAGE/public/index.html" ] || die "staged shelf has no index.html"
echo "SHELF $(find "$SHELF_STAGE/public" -type f | wc -l) files staged"

# 3. Inject the catalog and sanity-check the gate function is in the bundle.
#    The catalog takes the site root (that is the page people actually open); the shelf
#    moves to /$SHELF_PATH/ with a <base href="/"> so its relative links to /games/ and
#    /assets/ keep resolving. /catalog/ is kept as an alias so old links still work.
if [ -n "$SITE_PATH" ]; then
  mkdir -p "$SHELF_STAGE/public/$SITE_PATH" || die "cannot create catalog dir in stage"
  cp "$WORK/catalog/index.html" "$WORK/catalog/games.json" "$SHELF_STAGE/public/$SITE_PATH/" || die "copy failed"
  echo "INJECT /$SITE_PATH/ <- $(ls "$WORK/catalog" | tr '\n' ' ')"
else
  mkdir -p "$SHELF_STAGE/public/$SHELF_PATH" || die "cannot create shelf dir in stage"
  python3 - "$SHELF_STAGE/public/index.html" "$SHELF_STAGE/public/$SHELF_PATH/index.html" <<'PY' || die "shelf move failed"
import re, sys
src, dst = sys.argv[1], sys.argv[2]
html = open(src, encoding="utf-8").read()
# Every href in the shelf is site-relative (games/…, assets/…), so a base tag keeps the
# whole page working one directory down instead of rewriting each link.
html = re.sub(r"(<head[^>]*>)", r'\1\n<base href="/">', html, count=1, flags=re.I)
open(dst, "w", encoding="utf-8").write(html)
PY
  cp "$WORK/catalog/index.html" "$SHELF_STAGE/public/index.html" || die "copy failed"
  cp "$WORK/catalog/games.json" "$SHELF_STAGE/public/games.json" || die "copy failed"
  mkdir -p "$SHELF_STAGE/public/catalog"
  cp "$WORK/catalog/index.html" "$SHELF_STAGE/public/catalog/index.html"
  cp "$WORK/catalog/games.json" "$SHELF_STAGE/public/catalog/games.json"
  # Tile art: real in-game screenshots captured by scripts/lib-art.mjs. Shipped as files
  # (not data URIs) so the face stays small and the browser can cache each tile.
  if [ -d "$WORK/catalog/art" ]; then
    mkdir -p "$SHELF_STAGE/public/art"
    cp -f "$WORK/catalog/art"/* "$SHELF_STAGE/public/art/" || die "tile art copy failed"
    echo "ART $(ls "$SHELF_STAGE/public/art" | wc -l) tile screenshots"
  fi
  echo "INJECT / <- $(ls "$WORK/catalog" | tr '\n' ' ') ; shelf moved to /$SHELF_PATH/ (+ /catalog/ alias)"
fi

# Thumbnails are served from our own origin (/thumbs/) so no CSP img-src exception and no
# hotlink dependency; the whole dir ships each deploy and wrangler only re-uploads changes.
if [ -d "$WORK/catalog/thumbs" ]; then
  mkdir -p "$SHELF_STAGE/public/thumbs"
  cp -f "$WORK/catalog/thumbs"/* "$SHELF_STAGE/public/thumbs/" || die "thumb copy failed"
  echo "THUMBS $(ls "$SHELF_STAGE/public/thumbs" | wc -l) files, $(du -sh "$SHELF_STAGE/public/thumbs" | cut -f1)"
fi
# Arcade: our own three.js ports. deploy.sh only stages games/live.txt + archive, so these
# nested pages (and the shared kit module they import) ship from $SITE_REPO's HEAD as a set.
if [ -n "$(git -C "$SITE_REPO" ls-tree --name-only HEAD games/arcade/ 2>/dev/null)" ]; then
  # games/arcade/ holds the shared kit module, one forwarding <slug>.html per game and a
  # <slug>/ folder with that game's index.html + its kit copy: archive the tree so the
  # forwards and the folders land together (git show on a tree name writes junk).
  mkdir -p "$SHELF_STAGE/public/games" || die "cannot create games dir in stage"
  git -C "$SITE_REPO" archive HEAD games/arcade | tar -x -C "$SHELF_STAGE/public" \
    || die "could not stage games/arcade"
  echo "ARCADE $(ls "$SHELF_STAGE/public/games/arcade" | tr '\n' ' ')"
fi

# In-browser builds: /play/<slug>/ mirrors of upstream static games, staged from .site-play
# (kept out of both git repos — 28 MB of vendored JS that wrangler only re-uploads on change).
if [ -d "$SRC/.site-play" ]; then
  mkdir -p "$SHELF_STAGE/public/play"
  cp -R "$SRC/.site-play/." "$SHELF_STAGE/public/play/" || die "play mirror copy failed"
  echo "PLAY $(find "$SHELF_STAGE/public/play" -type f | wc -l) files, $(du -sh "$SHELF_STAGE/public/play" | cut -f1)"
fi
if [ -n "$LIBRARY" ]; then
  python3 "$PUBLISH_SCRIPTS/originals.py" --builds "$ORIGINALS_BUILDS" \
    --public "$SHELF_STAGE/public" || die "original game staging failed"
fi
[ -f "$SHELF_STAGE/functions/_middleware.js" ] || die "no _middleware.js in stage — refusing to deploy a site without its gate"

if [ -n "$DRY_RUN" ]; then
  echo "DRY_RUN: staged at $SHELF_STAGE (nothing uploaded)"
  exit 0
fi

# 4. Upload. branch=main makes this the production deployment behind game.cluerholdings.com.
( cd "$SHELF_STAGE" && WRANGLER_SEND_METRICS=false CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" \
  npx --yes wrangler@3 pages deploy public --project-name "$PROJECT" --branch main --commit-dirty=true ) >"$WORK/deploy.log" 2>&1
rc=$?
tail -6 "$WORK/deploy.log"
[ $rc -eq 0 ] || die "wrangler deploy failed (rc=$rc) — see $WORK/deploy.log"
url=$(grep -oE 'https://[a-z0-9-]+\.'"${PROJECT}"'\.pages\.dev' "$WORK/deploy.log" | tail -1)
echo "DEPLOYED ${url:-<unknown url>}"
