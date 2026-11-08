#!/bin/zsh
# usage: wait-merge.sh <repo> <pr> — merge only when every check is SUCCESS/SKIPPED/NEUTRAL
repo=$1; pr=$2; sleep 20
while true; do
  s=$(gh pr checks $pr --repo $repo --json state -q '[.[].state]|join(",")' 2>/dev/null)
  if [[ -n "$s" && "$s" != *PENDING* && "$s" != *IN_PROGRESS* && "$s" != *QUEUED* ]]; then break; fi
  sleep 20
done
echo "checks: $s"
if [[ "$s" == *FAILURE* || "$s" == *ERROR* || "$s" == *CANCELLED* || "$s" == *TIMED_OUT* ]]; then echo "NOT MERGED: red CI"; exit 1; fi
gh pr merge $pr --repo $repo --squash && gh pr view $pr --repo $repo --json state,mergeCommit -q '.state+" "+.mergeCommit.oid[0:7]'
