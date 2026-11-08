#!/bin/sh
# Download every completed master, frame it, write stats to stats.jsonl.
cd "$(dirname "$0")"
UV=$HOME/.project-swarm/toolchains/bin/uv
mkdir -p raw out
python3 - <<'PY' > urls.tsv
import json
R=json.load(open('results.json')); B=json.load(open('briefs.json'))
names={c['id']:c['name'] for t in B['themes'] for c in t['characters']}
for th,items in R.items():
    for i,v in items.items():
        if v['url']: print(f"{th}-{int(i)+1:02d}\t{v['url']}")
PY
while IFS="$(printf '\t')" read -r id url; do
  [ -f "raw/$id.png" ] || curl -s -o "raw/$id.png" "$url"
done < urls.tsv
: > stats.jsonl
for f in raw/*.png; do
  id=$(basename "$f" .png); th=${id%-*}
  $UV run -q --no-project --with pillow python frame.py "$f" "out/$th" "$id" >> stats.jsonl
done
wc -l < stats.jsonl
