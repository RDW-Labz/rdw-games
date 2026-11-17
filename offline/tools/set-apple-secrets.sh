#!/usr/bin/env bash
# Puts the App Store Connect credentials into the repo's Actions secrets and kicks
# off the TestFlight upload. Run it on a machine where `gh` is already logged in.
#
#   ./tools/set-apple-secrets.sh
#
# Nothing here prints a secret back out, and nothing is written to disk except the
# .p8 file you point it at (which Apple gives you exactly once — keep it).
set -euo pipefail

REPO=${REPO:-RDW-Labz/awesome-offline-mobile-games}

command -v gh >/dev/null || { echo "gh is not installed"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in — run: gh auth login"; exit 1; }

read -rp "Team ID (10 characters, developer.apple.com → Membership details): " TEAM
read -rp "API Key ID (App Store Connect → Users and Access → Integrations): " KEYID
read -rp "Issuer ID (UUID shown above the key list): " ISSUER
read -rp "Path to the downloaded AuthKey_${KEYID}.p8: " P8

[[ $TEAM =~ ^[A-Z0-9]{10}$ ]]            || { echo "team id should be 10 uppercase letters/digits"; exit 1; }
[[ $KEYID =~ ^[A-Z0-9]{8,12}$ ]]         || { echo "key id looks wrong (expected ~10 uppercase characters)"; exit 1; }
[[ $ISSUER =~ ^[0-9a-fA-F-]{36}$ ]]      || { echo "issuer id should be a UUID"; exit 1; }
[[ -f $P8 ]]                             || { echo "no such file: $P8"; exit 1; }
grep -q "BEGIN PRIVATE KEY" "$P8"        || { echo "$P8 is not a .p8 private key"; exit 1; }

echo "setting secrets on $REPO …"
printf '%s' "$TEAM"   | gh secret set APPLE_TEAM_ID   -R "$REPO"
printf '%s' "$KEYID"  | gh secret set APPLE_API_KEY_ID -R "$REPO"
printf '%s' "$ISSUER" | gh secret set APPLE_API_ISSUER -R "$REPO"
base64 -w0 "$P8"      | gh secret set APPLE_API_KEY   -R "$REPO"

echo
gh secret list -R "$REPO"
echo
echo "triggering the iOS workflow — it uploads to TestFlight when the secrets are present"
gh workflow run ios.yml -R "$REPO"
sleep 5
gh run list --workflow=ios.yml -R "$REPO" --limit 1
echo
echo "watch it with:  gh run watch \$(gh run list --workflow=ios.yml -R $REPO --limit 1 --json databaseId -q '.[0].databaseId')"
echo "then add your Apple ID under App Store Connect → TestFlight → Internal Testing."
