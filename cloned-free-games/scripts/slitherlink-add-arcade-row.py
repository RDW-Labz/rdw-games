import json, io
p = '/home/cluer/cloned-free-games/arcade/arcade.json'
raw = open(p, encoding='utf-8').read()
d = json.loads(raw)
entry = {
    "slug": "Slitherlink-Logic-Loop-Puzzle",
    "name": "Slitherlink",
    "match": [
        "slitherlink-logic-loop-puzzle",
        "Slitherlink-Logic-Loop-Puzzle",
        "slitherlink logic loop puzzle",
        "slitherlink",
        "com.sidhant.slitherlink",
        "sidhant947/slitherlink",
    ],
    "entry": "/games/arcade/slitherlink.html",
    "blurb": "Draw one closed loop through a dot lattice: tap an edge to draw a line, tap again to cross it out, and every number must count exactly the lines touching its cell. 4x4, 5x5 and 6x6 boards; five impossible lines ends the run, and Reveal shows the answer.",
    "tier": "first-party",
}
g = d['games']
g = [x for x in g if x.get('slug') != entry['slug']]
g.append(entry)
d['games'] = g
out = json.dumps(d, indent=1, ensure_ascii=True) + '\n'
open(p, 'w', encoding='utf-8').write(out)
print('ports', len(g), 'last', g[-1]['slug'], g[-1]['entry'])
