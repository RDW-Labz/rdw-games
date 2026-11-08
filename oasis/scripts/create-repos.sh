#!/usr/bin/env bash
# Creates the nine private OASIS repos under RDW-Labz and pushes each repos/<name> as its first commit.
# Needs: gh (logged in: `gh auth login`), git. Safe to re-run: skips repos that already exist on GitHub.
set -euo pipefail
OWNER="${OWNER:-RDW-Labz}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPOS=(remote agent-core skills connectors agent-amber agent-michael rag-pipeline desktop-app playbooks)

for name in "${REPOS[@]}"; do
  dir="$ROOT/repos/$name"
  full="$OWNER/$name"
  echo "== $full"
  if gh repo view "$full" >/dev/null 2>&1; then
    echo "   exists on GitHub, skipping create"
  else
    gh repo create "$full" --private --description "OASIS — $name" >/dev/null
    echo "   created (private)"
  fi
  if [ ! -d "$dir/.git" ]; then
    ( cd "$dir" && git init -q -b main && git add -A && git commit -q -m "chore: skeleton

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" )
    echo "   committed skeleton"
  fi
  ( cd "$dir" && git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$full.git" )
  ( cd "$dir" && git push -q -u origin main ) && echo "   pushed" || echo "   push failed (already pushed?)"
done

echo
echo "Done. Next: open prompts/00-kickoff.md and paste it to Codex."
