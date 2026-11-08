#!/usr/bin/env python3
"""Asset inventory for the cloned game tree.

Answers the question the catalog cannot: *what could we actually build with this clone?*
For every clone under games/ it reports licence, art files by type, audio files, and the
data tables that carry real content (units, items, monsters, techs), with byte totals.

Usage:  scripts/asset-inventory.py [clone ...]        # default: every clone with a .git
        scripts/asset-inventory.py --json out.json
"""
import json, os, re, sys
from collections import Counter
from typing import Any, Dict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES = os.path.join(ROOT, 'games')

ART_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.tga', '.webp', '.pnm'}
AUDIO_EXT = {'.ogg', '.opus', '.mp3', '.wav', '.flac', '.it', '.xm', '.mod', '.s3m'}
DATA_EXT = {'.txt', '.yaml', '.yml', '.xml', '.json', '.wml', '.def', '.cfg', '.dat'}
LICENCE_NAMES = ('licence', 'license', 'copying', 'copyright', 'gpl', 'unlicense')

# what a donor is good for — used to label the inventory rather than to score it
SIGNALS = {
    'units/creatures': re.compile(r'(units?|creatures?|monsters?|chars?|actors?)/', re.I),
    'items': re.compile(r'(items?|equip|weapons?|outfits?|armou?r)/', re.I),
    'terrain/tiles': re.compile(r'(terrain|tiles?|tile_?set|dungeon|screens|ground)/', re.I),
    'portraits/faces': re.compile(r'(portraits?|faces?|heads?)/', re.I),
    'ui/icons': re.compile(r'(ui|gui|icons?|buttons?|hud)/', re.I),
    'effects': re.compile(r'(effects?|fx|projectiles?|explosions?)/', re.I),
    'land/scenery': re.compile(r'(land|scenery|backgrounds?|bgs?)/', re.I),
}


def size_of(path):
    total = 0
    for dirpath, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return total


def licence_of(path):
    found = []
    for entry in sorted(os.listdir(path)):
        low = entry.lower()
        if any(low.startswith(n) for n in LICENCE_NAMES) and not low.endswith('.png'):
            try:
                head = open(os.path.join(path, entry), encoding='utf-8', errors='replace').read(4000)
            except OSError:
                continue
            m = re.search(r'(GNU (?:Lesser |Affero )?General Public License[^\n]*?'
                          r'(?:version|v\.?)\s*([0-9.]+)?|GPL-?([0-9.]+)|MIT License|'
                          r'Creative Commons[^\n]*|CC[- ]BY[- A-Z0-9.]*|zlib License|'
                          r'Mozilla Public License[^\n]*)', head, re.I)
            found.append((entry, (m.group(0).strip() if m else head.split('\n')[0][:70])))
    return found[:4]


def inventory(name: str, root: str = GAMES) -> Dict[str, Any]:
    path = os.path.join(root, name)
    art, audio, data = Counter(), Counter(), Counter()
    art_bytes = audio_bytes = data_bytes = 0
    for dirpath, dirnames, files in os.walk(path):
        dirnames[:] = [d for d in dirnames if d not in ('.git', 'node_modules', 'build', 'bin')]
        rel = os.path.relpath(dirpath, path)
        for f in files:
            ext = os.path.splitext(f)[1].lower()
            try:
                n = os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                continue
            if ext in ART_EXT:
                art[os.path.splitext(f)[1].lower()] += 1; art_bytes += n
            elif ext in AUDIO_EXT:
                audio[ext] += 1; audio_bytes += n
            elif ext in DATA_EXT:
                data[rel.split(os.sep)[0]] += 1; data_bytes += n
    buckets = {}
    for dirpath, dirnames, files in os.walk(path):
        dirnames[:] = [d for d in dirnames if d not in ('.git', 'node_modules')]
        hits = sum(1 for f in files if os.path.splitext(f)[1].lower() in ART_EXT)
        if not hits:
            continue
        rel = os.path.relpath(dirpath, path) + '/'
        for label, rx in SIGNALS.items():
            if rx.search('/' + rel):
                buckets[label] = buckets.get(label, 0) + hits
    return dict(
        clone=name,
        licences=licence_of(path),
        bytes=size_of(path),
        art_total=sum(art.values()), art_by_ext=dict(art), art_bytes=art_bytes,
        audio_total=sum(audio.values()), audio_by_ext=dict(audio), audio_bytes=audio_bytes,
        art_buckets=dict(sorted(buckets.items(), key=lambda kv: -kv[1])),
        data_dirs=dict(sorted(data.items(), key=lambda kv: -kv[1])[:8]), data_bytes=data_bytes,
    )


def main():
    argv = sys.argv[1:]
    out = None
    if '--json' in argv:
        i = argv.index('--json'); out = argv[i + 1]; del argv[i:i + 2]
    root = GAMES
    if '--root' in argv:
        i = argv.index('--root'); root = os.path.expanduser(argv[i + 1]); del argv[i:i + 2]
    names = argv or sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d, '.git')))
    rows: list[Dict[str, Any]] = [inventory(n, root) for n in names]
    for r in rows:
        lic = '; '.join(f'{f}: {t}' for f, t in r['licences']) or 'NONE FOUND'
        print(f"\n{r['clone']}  ({r['bytes'] / 1e6:.0f} MB on disk)")
        print(f"  licence: {lic[:150]}")
        print(f"  art: {r['art_total']} files ({r['art_bytes'] / 1e6:.1f} MB) "
              f"{', '.join(f'{k}:{v}' for k, v in r['art_by_ext'].items())}")
        print(f"  audio: {r['audio_total']} files ({r['audio_bytes'] / 1e6:.1f} MB) "
              f"{', '.join(f'{k}:{v}' for k, v in r['audio_by_ext'].items())}")
        if r['art_buckets']:
            print("  art buckets: " + ', '.join(f'{k} {v}' for k, v in r['art_buckets'].items()))
        if r['data_dirs']:
            print(f"  data ({r['data_bytes'] / 1e6:.1f} MB): " +
                  ', '.join(f'{k} {v}' for k, v in r['data_dirs'].items()))
    if out:
        open(out, 'w', encoding='utf-8').write(json.dumps(rows, indent=1))
        print(f"\nwrote {out}")


if __name__ == '__main__':
    main()
