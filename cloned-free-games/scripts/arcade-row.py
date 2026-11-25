#!/usr/bin/env python3
"""Add/replace a first-party port's row in arcade/arcade.json (library repo).

usage: python3 scripts/arcade-row.py <slug> "<Name>" "<blurb>" [--match <alias>]...

The row is what the catalog face uses to mark the audited card playable, so `match`
has to carry every name the card is known by (library slug, queue slug, store id,
repo path). Extras go in with repeated --match flags; the obvious variants of the
name and slug are added automatically.
"""
import argparse
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, 'arcade/arcade.json')

ap = argparse.ArgumentParser()
ap.add_argument('slug')
ap.add_argument('name')
ap.add_argument('blurb')
ap.add_argument('--match', action='append', default=[])
ap.add_argument('--entry', default=None)
a = ap.parse_args()

words = a.slug.split('-')
auto = [
    a.name.lower(),
    a.slug,
    a.name.replace(' ', '-'),
    '-'.join(words),
    '-'.join(w.capitalize() for w in words),
    ''.join(w.capitalize() for w in words),
    a.name.replace(' ', ''),
]
match = []
for m in auto + a.match:
    m = m.strip()
    if m and m not in match:
        match.append(m)

row = {
    'slug': a.slug,
    'name': a.name,
    'match': match,
    'entry': a.entry or ('/games/arcade/%s.html' % a.slug),
    'blurb': re.sub(r'\s+', ' ', a.blurb).strip(),
    'tier': 'first-party',
}

data = json.load(open(PATH))
games = [g for g in data['games'] if g.get('slug') != a.slug]
replaced = len(data['games']) - len(games)
games.append(row)
data['games'] = games
with open(PATH, 'w', encoding='utf-8') as fh:
    json.dump(data, fh, indent=1)
    fh.write('\n')
print(json.dumps({'slug': a.slug, 'rows': len(games), 'replaced': replaced, 'match': match}))
