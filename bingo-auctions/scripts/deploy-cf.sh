#!/usr/bin/env bash
# Canonical Cloudflare Workers deploy script. Run from WSL Ubuntu.
#
# Why this exists: Next.js builds inside /mnt/c hit EPERM errors when
# Next copies _not-found.html -> 404.html (WSL <-> Windows filesystem
# interop limitation, not fixable with Defender exclusions). Builds must
# happen in WSL's native filesystem (~/build/auction-platform). This
# script handles the rsync + install + build + deploy automatically.
#
# Usage from WSL Ubuntu:
#   bash /mnt/c/Users/jmacl/Projects/auction-platform/scripts/deploy-cf.sh
#
#   Or after cd'ing into the project:
#   bash scripts/deploy-cf.sh
#
# What it does:
#   1. Loads CLOUDFLARE_API_TOKEN from .env.cloudflare.local
#   2. Rsyncs project source to ~/build/auction-platform (excludes
#      node_modules + build artifacts; preserves env files)
#   3. Runs npm install in the WSL-native copy
#   4. Builds operator-web with webpack (not Turbopack -- known WSL issue)
#      then opennextjs-cloudflare to produce the Worker bundle
#   5. Deploys bingo-web Worker
#   6. Deploys bingo-cron Worker
#   7. Optionally pushes CRON_SECRET + CRON_TARGET_URL to both Workers
#      (set CRON_SECRET env var beforehand, or pass --rotate-cron-secret
#      to generate a new one)
#
# Idempotent: re-run any time. The rsync is incremental after first run.

set -euo pipefail

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
SRC=/mnt/c/Users/jmacl/Projects/auction-platform
DST=$HOME/build/auction-platform
# Historical helper: Phase 1 deploys use deploy-cloudflare.yml only.
# Audit this fallback and its callers in step 4 before using this script.
TARGET_URL="${CRON_TARGET_URL:-https://clovrbid.com}"

# -----------------------------------------------------------------------------
# Parse flags
# -----------------------------------------------------------------------------
ROTATE_CRON_SECRET=false
SKIP_OPERATOR_WEB=false
SKIP_CRON_TRIGGER=false
SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --rotate-cron-secret) ROTATE_CRON_SECRET=true ;;
    --skip-operator-web)  SKIP_OPERATOR_WEB=true ;;
    --skip-cron-trigger)  SKIP_CRON_TRIGGER=true ;;
    --skip-build)         SKIP_BUILD=true ;;
    -h|--help)
      grep '^#' "$0" | head -40 | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# -----------------------------------------------------------------------------
# Load API token
# -----------------------------------------------------------------------------
if [[ ! -f "$SRC/.env.cloudflare.local" ]]; then
  echo "FATAL: $SRC/.env.cloudflare.local not found." >&2
  echo "Create it with a single line: CLOUDFLARE_API_TOKEN=<your-token>" >&2
  exit 1
fi
set -a; source "$SRC/.env.cloudflare.local"; set +a
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "FATAL: CLOUDFLARE_API_TOKEN not set after sourcing env file." >&2
  exit 1
fi

echo ">>> Token loaded (first 8 chars: ${CLOUDFLARE_API_TOKEN:0:8}...)"

# -----------------------------------------------------------------------------
# Sentry release name (git SHA). withSentryConfig in next.config.ts reads this
# to tag uploaded source maps + register a release with Sentry. Without it the
# Sentry CLI skips upload silently.
# -----------------------------------------------------------------------------
if [[ -z "${SENTRY_RELEASE:-}" ]]; then
  SENTRY_RELEASE="$(cd "$SRC" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  export SENTRY_RELEASE
fi
echo ">>> Sentry release: $SENTRY_RELEASE"

# -----------------------------------------------------------------------------
# Build id. Identifies THIS build to the running console so an open tab can
# tell it has gone stale (apps/operator-web/src/lib/build-id.ts).
#
# A deploy replaces the Worker's _next/static assets wholesale, so a tablet
# left open from before it holds chunk URLs that now 404 and the console
# quietly stops responding to clicks (2026-09-15: "the auction builder
# glitches out, we can't select any items").
#
# MUST match .github/workflows/deploy-cloudflare.yml, which uses the FULL
# github.sha. Not SENTRY_RELEASE above — that one is the SHORT sha here and
# the full sha in CI, so reusing it would make every deploy-path switch look
# like a new build to every open tablet.
# -----------------------------------------------------------------------------
if [[ -z "${NEXT_PUBLIC_BUILD_ID:-}" ]]; then
  NEXT_PUBLIC_BUILD_ID="$(cd "$SRC" && git rev-parse HEAD 2>/dev/null || echo unknown)"
  export NEXT_PUBLIC_BUILD_ID
fi
echo ">>> Build id: $NEXT_PUBLIC_BUILD_ID"

# -----------------------------------------------------------------------------
# Sync source to WSL native FS
# -----------------------------------------------------------------------------
mkdir -p "$DST"
echo ">>> Syncing $SRC -> $DST (rsync, excludes node_modules/.next/.open-next/.git)"
rsync -a --delete \
  --exclude=node_modules \
  --exclude=.next \
  --exclude=.open-next \
  --exclude=.git \
  --exclude=.turbo \
  --exclude=.cache \
  --exclude=dist \
  --exclude=build \
  "$SRC/" "$DST/"
cp -f "$SRC/.env.cloudflare.local" "$DST/.env.cloudflare.local" 2>/dev/null || true
echo ">>> Source synced."

# -----------------------------------------------------------------------------
# Install dependencies in WSL native FS
# -----------------------------------------------------------------------------
cd "$DST"
echo ">>> npm install (may take 1-2 min)..."
npm install --no-audit --no-fund 2>&1 | tail -5

# -----------------------------------------------------------------------------
# Build operator-web (webpack, not Turbopack)
# -----------------------------------------------------------------------------
if [[ "$SKIP_BUILD" != true && "$SKIP_OPERATOR_WEB" != true ]]; then
  cd "$DST/apps/operator-web"
  echo ">>> Building operator-web with webpack (5-8 min)..."
  npx next build --webpack 2>&1 | tail -10
  echo ">>> opennextjs-cloudflare build..."
  npx opennextjs-cloudflare build 2>&1 | tail -10
fi

# -----------------------------------------------------------------------------
# Generate or load CRON_SECRET
# -----------------------------------------------------------------------------
if [[ "$ROTATE_CRON_SECRET" == true ]]; then
  CRON_SECRET="$(openssl rand -hex 32)"
  echo ">>> Generated new CRON_SECRET (first 8 chars: ${CRON_SECRET:0:8}...)"
  echo ">>> SAVE THIS to 1Password / vault before continuing:"
  echo "    CRON_SECRET=$CRON_SECRET"
  echo ">>> Continuing in 5s; Ctrl-C now if you need to save first."
  sleep 5
fi

# -----------------------------------------------------------------------------
# Deploy operator-web Worker (bingo-web)
# -----------------------------------------------------------------------------
if [[ "$SKIP_OPERATOR_WEB" != true ]]; then
  cd "$DST/apps/operator-web"
  echo ">>> Deploying bingo-web Worker..."
  npx wrangler deploy

  if [[ -n "${CRON_SECRET:-}" ]]; then
    echo ">>> Setting CRON_SECRET on bingo-web..."
    echo "$CRON_SECRET" | npx wrangler secret put CRON_SECRET
  fi
fi

# -----------------------------------------------------------------------------
# Deploy cron-trigger Worker (bingo-cron)
# -----------------------------------------------------------------------------
if [[ "$SKIP_CRON_TRIGGER" != true ]]; then
  cd "$DST/apps/cron-trigger"
  echo ">>> Deploying bingo-cron Worker..."
  npx wrangler deploy

  if [[ -n "${CRON_SECRET:-}" ]]; then
    echo ">>> Setting CRON_SECRET on bingo-cron..."
    echo "$CRON_SECRET" | npx wrangler secret put CRON_SECRET
    echo ">>> Setting CRON_TARGET_URL on bingo-cron..."
    echo "$TARGET_URL" | npx wrangler secret put CRON_TARGET_URL
  fi
fi

echo
echo ">>> Done."
echo
echo "Next steps:"
echo "  - Watch logs: cd $DST/apps/cron-trigger && npx wrangler tail"
echo "  - Verify: a cron firing should appear within 60s on bingo-cron"
echo "  - End-to-end test: create 2-min test auction in operator UI, watch DB + cron drains"
