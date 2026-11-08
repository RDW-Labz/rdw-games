#!/bin/bash
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../repos/agent-core" && pwd)
UV=${UV:-/Users/prime/.project-swarm/toolchains/bin/uv}
LOG="$HOME/.oasis/rig-service.out"
PORT=4405
ARGS=(--drawer "$HOME/.oasis/drawers/braden" --agent braden --person braden --catalog-dir ../connectors/catalog)
# RIG_ARGS is whitespace-separated arguments, never evaluated as shell code.
if [[ -n ${RIG_ARGS:-} ]]; then
    read -r -a ARGS <<< "$RIG_ARGS"
fi

no_pull=false
skip_gate=false
dry_run=false
for arg in "$@"; do
    case "$arg" in
        --no-pull) no_pull=true ;;
        --skip-gate) skip_gate=true ;;
        --dry-run) dry_run=true ;;
        *) echo "Usage: $0 [--no-pull] [--skip-gate] [--dry-run]" >&2; exit 1 ;;
    esac
done

# Print the same seven steps without querying or changing live state.
if "$dry_run"; then
    if "$skip_gate"; then
        echo '1. release gate skipped (--skip-gate)'
    else
        echo '1. gh run list --repo RDW-Labz/agent-core --workflow nightly.yml --branch main --limit 1 --json conclusion; require success'
    fi
    printf '2. git -C %q status --porcelain; refuse dirty tree; ' "$REPO"
    if "$no_pull"; then
        echo 'pull skipped (--no-pull)'
    else
        printf 'git -C %q pull --ff-only origin main\n' "$REPO"
    fi
    printf '3. cd %q && %q sync --locked\n' "$REPO" "$UV"
    printf '4. append === restart <UTC time> <old sha> -> <new sha> (<version from pyproject>) to %q\n' "$LOG"
    printf '5. pgrep -f rig-service; kill -TERM all matches; wait up to 30 s for port %s to close, then kill -KILL survivors\n' "$PORT"
    printf '6. cd %q && nohup %q run --no-sync rig-service' "$REPO" "$UV"
    printf ' %q' "${ARGS[@]}"
    printf ' >> %q 2>&1 < /dev/null & disown\n' "$LOG"
    printf '7. wait up to 60 s: lsof -nP -iTCP:%s -sTCP:LISTEN; print verified version, sha and pid, else tail -n 20 %q and exit 3\n' "$PORT" "$LOG"
    exit 0
fi

echo '1. release gate (unless --skip-gate)'
if ! "$skip_gate"; then
    if ! conclusion=$(gh run list --repo RDW-Labz/agent-core --workflow nightly.yml --branch main --limit 1 --json conclusion --jq '.[0].conclusion'); then
        echo 'nightly not green' >&2
        exit 2
    fi
    if [[ "$conclusion" != success ]]; then
        echo 'nightly not green' >&2
        exit 2
    fi
fi

echo '2. refuse dirty tree; pull --ff-only origin main (unless --no-pull)'
dirty=$(git -C "$REPO" status --porcelain)
if [[ -n "$dirty" ]]; then
    echo 'refusing to restart from a dirty tree' >&2
    exit 1
fi
old_sha=$(git -C "$REPO" rev-parse HEAD)
if ! "$no_pull"; then
    git -C "$REPO" pull --ff-only origin main
fi
new_sha=$(git -C "$REPO" rev-parse HEAD)

echo '3. uv sync --locked'
cd "$REPO"
"$UV" sync --locked
version=$(python3 -c '
import pathlib, re, sys
text = pathlib.Path("pyproject.toml").read_text()
section = re.search(r"(?ms)^\[project\]\s*\n(.*?)(?=^\[|\Z)", text)
version = re.search(r"(?m)^version\s*=\s*[\"\x27]([^\"\x27]+)[\"\x27]", section[1]) if section else None
if version is None:
    sys.exit("missing project.version in pyproject.toml")
print(version[1])
')

printf '4. append restart banner to %s\n' "$LOG"
mkdir -p "$(dirname "$LOG")"
printf '=== restart %s %s -> %s (%s)\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$old_sha" "$new_sha" "$version" >> "$LOG"

# Missing tools must not be mistaken for a free port.
command -v lsof >/dev/null
command -v pgrep >/dev/null
listening() {
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

echo "5. SIGTERM rig-service processes; wait up to 30 s for port $PORT to close, then SIGKILL survivors"
pids=$(pgrep -f '[r]ig-service') || { status=$?; [[ "$status" == 1 ]] || exit "$status"; }
for pid in $pids; do
    kill -TERM "$pid" || { ! kill -0 "$pid" 2>/dev/null; }
done
deadline=$((SECONDS + 30))
while listening && (( SECONDS < deadline )); do
    sleep 1
done
for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" || { ! kill -0 "$pid" 2>/dev/null; }
    fi
done
# Allow sockets to close after SIGKILL, and refuse an unrelated listener.
for ((attempt = 0; attempt < 5; attempt++)); do
    if ! listening; then break; fi
    sleep 1
done
if listening; then
    echo "port $PORT did not close" >&2
    exit 1
fi

echo '6. start rig-service with nohup and disown'
nohup "$UV" run --no-sync rig-service "${ARGS[@]}" >> "$LOG" 2>&1 < /dev/null &
launcher_pid=$!
disown "$launcher_pid"

echo "7. wait up to 60 s for port $PORT to listen"
deadline=$((SECONDS + 60))
while :; do
    if listener_pids=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t); then
        pid=${listener_pids%%$'\n'*}
        printf 'rig-service %s %s listening on 127.0.0.1:%s pid %s\n' "$version" "$new_sha" "$PORT" "$pid"
        exit 0
    fi
    if (( SECONDS >= deadline )); then break; fi
    sleep 1
done
echo "rig-service failed to listen on port $PORT" >&2
tail -n 20 "$LOG" >&2 || true
exit 3
