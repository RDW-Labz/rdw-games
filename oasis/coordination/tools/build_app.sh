#!/bin/bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
    echo "Usage: $0 <sha> [--dry-run]" >&2
    exit 1
fi

requested_sha=$1
dry_run=false
if [[ $# -eq 2 ]]; then
    if [[ $2 != --dry-run ]]; then
        echo "Usage: $0 <sha> [--dry-run]" >&2
        exit 1
    fi
    dry_run=true
fi

script_dir=$(cd "$(dirname "$0")" && pwd)
oasis_root=$(cd "$script_dir/../.." && pwd)
worktree=$(pwd -P)

export RUSTUP_HOME="$HOME/.project-swarm/toolchains/rust/rustup"
export CARGO_HOME="$HOME/.project-swarm/toolchains/rust/cargo"
export PATH="$CARGO_HOME/bin:$PATH"

if ! head_sha=$(git rev-parse HEAD 2>/dev/null); then
    echo "refusing build: not a git worktree" >&2
    exit 1
fi
if [[ $head_sha != "$requested_sha"* ]]; then
    echo "refusing build: HEAD $head_sha does not start with $requested_sha" >&2
    exit 1
fi

cargo="$CARGO_HOME/bin/cargo"
app_dir="$worktree/src-tauri/target/release/bundle/macos"
destination="$oasis_root/worktrees/builds/OASIS-$requested_sha.app"

if "$dry_run"; then
    printf 'RUSTUP_HOME=%s\n' "$RUSTUP_HOME"
    printf 'CARGO_HOME=%s\n' "$CARGO_HOME"
    printf 'PATH=%s\n' "$PATH"
    printf 'cargo=%s\n' "$cargo"
    printf 'cd %s\n' "$worktree"
    printf 'if [ ! -d %s/node_modules ]; then npm ci; fi\n' "$worktree"
    printf 'npm run tauri build\n'
    printf 'mkdir -p %s/worktrees/builds && ditto %s/*.app %s\n' "$oasis_root" "$app_dir" "$destination"
    exit 0
fi

if [[ ! -x $cargo ]]; then
    echo "cargo not found: $cargo" >&2
    exit 1
fi

if [[ ! -d "$worktree/node_modules" ]]; then
    npm ci
fi
npm run tauri build

built_app=''
if [[ -d "$app_dir/OASIS.app" ]]; then
    built_app="$app_dir/OASIS.app"
elif [[ -d "$app_dir" ]]; then
    while IFS= read -r candidate; do
        built_app=$candidate
        break
    done < <(find "$app_dir" -maxdepth 1 -type d -name '*.app' -print)
fi
if [[ -z $built_app ]]; then
    echo "built .app not found: $app_dir" >&2
    exit 1
fi

mkdir -p "$oasis_root/worktrees/builds"
ditto "$built_app" "$destination"
