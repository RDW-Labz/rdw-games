#!/usr/bin/env python3
"""Register the chess-clock port and fold the already-shipped chess card into the Bagatur entry."""
import json
import os

ARC = os.path.expanduser('~/cloned-free-games/arcade/arcade.json')
d = json.load(open(ARC))
games = d['games']
by = {g['slug']: g for g in games}

clock = {
    "slug": "chess-clock",
    "name": "Chess Clock",
    "match": [
        "chess-clock",
        "chess clock",
        "chess clock blitz",
        "chessclock",
        "com.chessclock.android",
        "simple-chess-clock",
        "simple chess clock",
        "com.chess.clock",
        "blitz-fischer-chess-clock",
        "blitz fischer chess clock",
        "blitz chess clock",
        "fischer chess clock",
        "fischer clock",
        "chess timer",
    ],
    "entry": "/games/arcade/chess-clock.html",
    "blurb": "Two 3D clocks on one body: tap a side to press it, your time stops and theirs starts, five controls from 1+0 bullet to 25+10 Fischer with the increment banked on every press, flag detection and a restart.",
    "tier": "first-party",
}
if 'chess-clock' in by:
    games[games.index(by['chess-clock'])] = clock
else:
    games.append(clock)

# "Chess" (jwtc.android.chess, Aart Bik's Chess for Android) is a standard-chess app we
# already ship as a playable board: the card is a manifest job, not a second port.
bag = by.get('bagatur-chess-engine')
if bag:
    add = ["chess", "chess for android", "jwtc.android.chess", "jwtc.android.chess-free", "chess android"]
    for m in add:
        if m not in bag['match']:
            bag['match'].append(m)

d['games'] = games
d['generated'] = '2026-11-17'
with open(ARC, 'w', encoding='utf-8') as fh:
    json.dump(d, fh, indent=1)
    fh.write('\n')
print('games:', len(games), '| bagatur match:', bag['match'] if bag else None)
