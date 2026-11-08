#!/bin/sh
# T47 setup: rebuild the three vendored wheels from their merged commits (decision #34 provenance).
set -eu
ROOT=/Users/prime/Documents/repos-projects/oasis
UV=$HOME/.project-swarm/toolchains/bin/uv
OUT="$PWD/.t47-wheels"; rm -rf "$OUT"; mkdir -p "$OUT"
for spec in connectors:4585bd2 skills:e78f0a2 playbooks:455a354; do
  repo=${spec%%:*}; rev=${spec##*:}
  full=$(git -C "$ROOT/repos/$repo" rev-parse "$rev^{commit}")
  src=$(mktemp -d); git -C "$ROOT/repos/$repo" archive "$full" | tar -x -C "$src"
  "$UV" build --wheel --out-dir "$OUT" "$src" >/dev/null 2>&1
  echo "$repo $full" >> "$OUT/commits.txt"; rm -rf "$src"
done
( cd "$OUT" && shasum -a 256 *.whl > sha256.txt )
cat "$OUT/commits.txt" "$OUT/sha256.txt"
