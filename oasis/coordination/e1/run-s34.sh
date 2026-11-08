#!/bin/bash
set -u
cd /Users/prime/Documents/repos-projects/oasis
S=$HOME/Documents/repos-projects/project-swarm-e1/tools/swarm.mjs
run() { python3 coordination/tools/e1_replay.py --cases coordination/e1-cases.json --swarm "$S" --work /private/tmp/oasis-e1 --results coordination/e1/results.jsonl --max-usd 40 --arm "$1" --only "$2"; }
: > coordination/e1/replay-s34.log
run candidate c3 >> coordination/e1/replay-s34.log 2>&1
run baseline c3 >> coordination/e1/replay-s34.log 2>&1
run baseline c4 >> coordination/e1/replay-s34.log 2>&1
run candidate c4 >> coordination/e1/replay-s34.log 2>&1
tail -c 1200 coordination/e1/replay-s34.log
