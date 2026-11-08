#!/usr/bin/env bash
# Cloudflare CDN cache purge for cdn.clovrbid.com.
#
# Usage:
#   bash scripts/r2-purge-cache.sh URL1 URL2 ...
#   bash scripts/r2-purge-cache.sh --all-r2          (purges everything; max 30 URLs/req)
#   echo "url1\nurl2" | bash scripts/r2-purge-cache.sh -   (stdin)
#
# Cloudflare's API caps purge_cache to 30 URLs per request, so we batch.
# Token: CLOUDFLARE_PURGE_TOKEN (Zone:Cache Purge scope on clovrbid.com).

set -euo pipefail

ENV_FILE="${ENV_FILE:-/mnt/c/Users/jmacl/Projects/auction-platform/.env.cloudflare.local}"
[[ ! -f "$ENV_FILE" ]] && ENV_FILE="/c/Users/jmacl/Projects/auction-platform/.env.cloudflare.local"

PURGE_TOKEN=$(grep "^CLOUDFLARE_PURGE_TOKEN=" "$ENV_FILE" | cut -d= -f2-)
ZONE_ID=$(grep "^CLOUDFLARE_ZONE_ID=" "$ENV_FILE" | cut -d= -f2-)

[[ -z "$PURGE_TOKEN" ]] && { echo "Missing CLOUDFLARE_PURGE_TOKEN in $ENV_FILE" >&2; exit 1; }
[[ -z "$ZONE_ID" ]]     && { echo "Missing CLOUDFLARE_ZONE_ID in $ENV_FILE"     >&2; exit 1; }

# Collect URLs from args or stdin
URLS=()
if [[ "${1:-}" == "-" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && URLS+=("$line")
  done
elif [[ "${1:-}" == "--all-r2" ]]; then
  echo "ERROR: --all-r2 not yet implemented — would need to list R2 keys first." >&2
  echo "Pass explicit URLs instead." >&2
  exit 1
else
  URLS=("$@")
fi

if [[ ${#URLS[@]} -eq 0 ]]; then
  echo "Usage: $0 URL [URL...]  (or - for stdin)" >&2
  exit 1
fi

echo "Purging ${#URLS[@]} URL(s) from cache..."

# Batch into chunks of 30 (CF API limit)
total_ok=0
total_fail=0
batch_size=30
for ((i=0; i<${#URLS[@]}; i+=batch_size)); do
  batch=("${URLS[@]:i:batch_size}")
  # Build JSON array
  files_json=$(printf '"%s",' "${batch[@]}" | sed 's/,$//')
  res=$(curl -sS -X POST \
    -H "Authorization: Bearer $PURGE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"files\":[$files_json]}" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache")
  if echo "$res" | grep -q '"success":true'; then
    echo "  OK batch of ${#batch[@]}"
    total_ok=$((total_ok + ${#batch[@]}))
  else
    echo "  FAIL batch of ${#batch[@]}: $res" >&2
    total_fail=$((total_fail + ${#batch[@]}))
  fi
done

echo ""
echo "Purged: $total_ok   Failed: $total_fail"
[[ "$total_fail" -gt 0 ]] && exit 1
exit 0
