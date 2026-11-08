#!/bin/bash
cd /Users/prime/Documents/repos-projects/oasis
S=$HOME/Documents/repos-projects/project-swarm-e1/tools/swarm.mjs
for c in c1 c2; do python3 coordination/tools/e1_replay.py --cases coordination/e1-cases.json --swarm "$S" --work /private/tmp/oasis-e1 --results coordination/e1/results.jsonl --max-usd 40 --arm candidate --only $c >> coordination/e1/replay-s33.log 2>&1; done
tail -c 600 coordination/e1/replay-s33.log
