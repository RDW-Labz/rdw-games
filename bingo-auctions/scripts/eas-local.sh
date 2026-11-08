#!/usr/bin/env bash
# ============================================================================
# scripts/eas-local.sh — Local EAS build + submit (x86 Linux fallback)
#
# WHY THIS EXISTS
#   eas-build.yml / eas-submit.yml run on GitHub Actions runners. When Actions
#   is unavailable (e.g. a billing / account block) OR to avoid spending Actions
#   minutes, run the SAME build+submit here on any x86_64 Linux box (e.g. the
#   Ubuntu server). The win32-arm64 laptop CANNOT run eas-cli (hermesc is an
#   x86 ELF binary), which is the whole reason the CI workflows exist — this
#   script is the cheaper, Actions-free equivalent for an x86 machine. EAS still
#   runs the actual macOS/Xcode (or Android) build in its cloud; this only
#   drives the CLI.
#
# PREREQUISITES (one-time, on the x86 Linux box)
#   - Node 20+ and eas-cli:            npm i -g eas-cli@13
#   - Repo cloned and on the commit you want to ship:   git fetch && git checkout master && git pull
#   - Workspace deps installed:        npm ci
#   - EXPO_TOKEN available — export it, OR leave it in apps/field-mobile/.env
#     (this script auto-reads it from there). Scopes: build:create, submit:create.
#   - For `--submit ios`:     .secrets/AuthKey_25M83P99J8.p8 present
#                             (eas.json ascApiKeyPath -> ../../.secrets/...).
#   - For `--submit android`: .secrets/google-play-service-account.json present
#                             (eas.json serviceAccountKeyPath -> ../../.secrets/...).
#   The .env + .secrets files are gitignored, so copy them from the dev machine
#   to this box once (scp/rsync). Nothing else is machine-specific.
#
# USAGE
#   scripts/eas-local.sh <app> <profile> <platform> [--submit]
#     app:      bidder | staff | both
#     profile:  preview | production         (preview = internal/TestFlight)
#     platform: ios | android | all          (staff is iOS-only in eas.json)
#
#   Examples:
#     scripts/eas-local.sh both preview ios            # build staff + bidder iOS, no submit
#     scripts/eas-local.sh staff preview ios --submit  # build, wait, submit to TestFlight
#     scripts/eas-local.sh bidder preview all --submit # iOS TestFlight + Android internal
#
# NOTES
#   - eas.json has requireCommit:true — commit / pull first; the build uses the
#     committed tree (uncommitted changes are refused).
#   - WITHOUT --submit: builds are queued with --no-wait (returns immediately;
#     watch progress at expo.dev). WITH --submit: builds run to completion
#     (blocking, ~15-40 min each) so `eas submit --latest` grabs the right one.
#   - appVersionSource:remote + autoIncrement:true means EAS bumps the build
#     number automatically — no manual version edits.
# ============================================================================
set -euo pipefail

APP="${1:?usage: eas-local.sh <bidder|staff|both> <preview|production> <ios|android|all> [--submit]}"
PROFILE="${2:?profile required: preview|production}"
PLATFORM="${3:?platform required: ios|android|all}"
SUBMIT="${4:-}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

app_dir() {
  case "$1" in
    bidder) echo "apps/bidder-app" ;;
    staff)  echo "apps/field-mobile" ;;
    *) echo "unknown app: $1" >&2; exit 1 ;;
  esac
}

case "$APP" in
  both) APPS=(staff bidder) ;;
  bidder|staff) APPS=("$APP") ;;
  *) echo "bad app '$APP' (bidder|staff|both)" >&2; exit 1 ;;
esac

command -v eas >/dev/null 2>&1 || { echo "eas-cli missing — run: npm i -g eas-cli@13" >&2; exit 1; }

# EXPO_TOKEN: prefer the environment, else read it out of the staff app's .env.
if [ -z "${EXPO_TOKEN:-}" ] && [ -f "$ROOT/apps/field-mobile/.env" ]; then
  EXPO_TOKEN="$(grep -E '^EXPO_TOKEN=' "$ROOT/apps/field-mobile/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  export EXPO_TOKEN
fi
[ -n "${EXPO_TOKEN:-}" ] || { echo "EXPO_TOKEN not set (export it, or put it in apps/field-mobile/.env)" >&2; exit 1; }

# Submit reads ASC key id/issuer from eas.json; the team id is supplied via env
# (mirrors eas-submit.yml). The .p8 / Play JSON come from the eas.json paths.
export EXPO_APPLE_TEAM_ID="73554WL25P"
export EXPO_APPLE_TEAM_TYPE="COMPANY_OR_ORGANIZATION"

# With --submit we must wait for the build to finish so `eas submit --latest`
# picks the build we just made (not a prior one). Without it, fire-and-forget.
BUILD_WAIT="--no-wait"
[ "$SUBMIT" = "--submit" ] && BUILD_WAIT=""

echo "ROOT=$ROOT  apps=[${APPS[*]}]  profile=$PROFILE  platform=$PLATFORM  submit=${SUBMIT:-no}"
echo "eas: $(eas --version 2>/dev/null || true)  whoami: $(eas whoami 2>/dev/null || echo '??')"

for a in "${APPS[@]}"; do
  dir="$ROOT/$(app_dir "$a")"
  echo "==> [$a] eas build --platform $PLATFORM --profile $PROFILE ${BUILD_WAIT}"
  ( cd "$dir" && eas build --platform "$PLATFORM" --profile "$PROFILE" --non-interactive $BUILD_WAIT )
done

if [ "$SUBMIT" = "--submit" ]; then
  for a in "${APPS[@]}"; do
    dir="$ROOT/$(app_dir "$a")"
    echo "==> [$a] eas submit --platform $PLATFORM --latest --profile $PROFILE"
    ( cd "$dir" && eas submit --platform "$PLATFORM" --latest --profile "$PROFILE" --non-interactive )
  done
fi

echo "done."
