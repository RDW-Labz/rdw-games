#!/usr/bin/env bash
# Record one ota_publishes row (0413) per destination branch after a real EAS
# publish or republish, so the health check's silent-exit email can say "staff
# update published at HH:MM" and map telemetry's update ids to a group.
#
# Usage (from the app directory, EAS already authenticated):
#   record-ota-publish.sh <bidder|staff> "<branch> [<branch> ...]"
# Env: SUPABASE_URL, KEY (service role), MSG, GH_RUN_ID.
#
# Best-effort by design: every failure is a ::warning:: and exit 0. A publish
# that went out must never be reported as failed because its log row did not.
set +e
APP="$1"
BRANCHES="$2"
if [[ -z "${SUPABASE_URL:-}" || -z "${KEY:-}" ]]; then
  echo "::warning::SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing; skipping ota_publishes record"
  exit 0
fi
for B in $BRANCHES; do
  # The newest group on the branch is the one just published. Group shape
  # differs across eas-cli versions (string or {id}), hence the tolerant jq.
  LIST="$(eas update:list --branch "$B" --json --non-interactive --limit 1 2>/dev/null)"
  GROUP="$(jq -r '[.. | objects | .group? | select(. != null) | if type == "object" then .id else . end][0] // empty' <<<"$LIST" 2>/dev/null)"
  IDS='[]'
  if [[ -n "$GROUP" ]]; then
    IDS="$(jq -c --arg g "$GROUP" '[.. | objects | select((.group? | if type == "object" then .id else . end) == $g) | .id | select(. != null)] | unique' <<<"$LIST" 2>/dev/null)"
    jq -e 'type == "array"' <<<"$IDS" >/dev/null 2>&1 || IDS='[]'
  fi
  JSON="$(jq -n --arg app "$APP" --arg branch "$B" --arg msg "${MSG:-}" --arg gh "${GH_RUN_ID:-}" --arg g "$GROUP" --argjson ids "$IDS" \
    '{app:$app, branch:$branch, group_id:(if $g == "" then null else $g end), update_ids:$ids, message:$msg, gh_run_id:$gh}')"
  if curl -fsS --max-time 10 -X POST "${SUPABASE_URL%/}/rest/v1/ota_publishes" \
      -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
      -H "Content-Type: application/json" -H "Prefer: return=minimal" -d "$JSON"; then
    echo "Recorded ota_publishes: $APP $B group=${GROUP:-unknown} ids=$IDS"
  else
    echo "::warning::ota_publishes insert failed for $APP $B (publish itself is unaffected)"
  fi
done
exit 0
