#!/bin/bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/build_app.sh"
ROOT="$(cd "$(dirname "$SCRIPT")/../.." && pwd)"
cd "$ROOT"
bash -n "$SCRIPT"

head_sha=$(git rev-parse HEAD 2>/dev/null)
wrong_sha=ffffffffffffffffffffffffffffffffffffffff
if wrong_sha_output=$(bash "$SCRIPT" "$wrong_sha" --dry-run 2>&1); then
    echo 'build app accepted a mismatched sha' >&2
    exit 1
fi
if [[ $wrong_sha_output != *'refusing build: HEAD'* ]]; then
    echo 'build app mismatch message missing' >&2
    exit 1
fi

test_home="$ROOT/.build-app-test-home.$$"
cargo_bin="$test_home/.project-swarm/toolchains/rust/cargo/bin"
rustup_home="$test_home/.project-swarm/toolchains/rust/rustup"
cargo_home="$test_home/.project-swarm/toolchains/rust/cargo"
plan=$(HOME="$test_home" bash "$SCRIPT" "$head_sha" --dry-run)
if ! printf '%s\n' "$plan" | grep -Fq "RUSTUP_HOME=$rustup_home"; then
    echo 'dry-run missing RUSTUP_HOME' >&2
    exit 1
fi
if ! printf '%s\n' "$plan" | grep -Fq "CARGO_HOME=$cargo_home"; then
    echo 'dry-run missing CARGO_HOME' >&2
    exit 1
fi
path_line=$(printf '%s\n' "$plan" | grep '^PATH=')
if [[ $path_line != "PATH=$cargo_bin:"* ]]; then
    echo 'dry-run did not put cargo toolchain first in PATH' >&2
    exit 1
fi

if missing_cargo_output=$(HOME="$test_home" bash "$SCRIPT" "$head_sha" 2>&1); then
    echo 'build app unexpectedly found cargo' >&2
    exit 1
fi
if [[ $missing_cargo_output != *'cargo not found'* ]]; then
    echo 'missing cargo message absent' >&2
    exit 1
fi
