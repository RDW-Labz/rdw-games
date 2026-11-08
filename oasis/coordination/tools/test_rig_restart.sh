#!/bin/bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/rig_restart.sh"
bash -n "$SCRIPT"
plan=$(bash "$SCRIPT" --dry-run --skip-gate --no-pull)
printf -v log_path '%q' "$HOME/.oasis/rig-service.out"
for expected in nohup disown 4405 "$log_path"; do
    if ! printf '%s\n' "$plan" | grep -Fq "$expected"; then
        echo "restart plan missing: $expected" >&2
        exit 1
    fi
done
if printf '%s\n' "$plan" | grep -Fq setsid; then
    echo 'restart plan uses unsupported setsid' >&2
    exit 1
fi
