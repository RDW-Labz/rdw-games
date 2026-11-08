#!/bin/bash
set -u
cd /Users/prime/Documents/repos-projects/oasis
S=$HOME/Documents/repos-projects/project-swarm-e1/tools/swarm.mjs
run() { python3 coordination/tools/e1_replay.py --cases coordination/e1-cases.json --swarm "$S" --work /private/tmp/oasis-e1 --results coordination/e1/results-c2rerun.jsonl --max-usd 24 --arm "$1" --only "$2"; }
: > coordination/e1/replay-s34c2.log
# c2 re-run: the s33 rows overlapped a pass-1 shoot on Vite 24678 (#141); nothing else shoots now.
run candidate c2 >> coordination/e1/replay-s34c2.log 2>&1
run baseline c2 >> coordination/e1/replay-s34c2.log 2>&1
tail -c 1200 coordination/e1/replay-s34c2.log
