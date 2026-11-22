#!/usr/bin/env python3
"""Bake generated boards into the shipped ports, verbatim.

Re-running a generator reshuffles every board, so boards must never be retyped by hand: this
splices the generator's own JS literal into the page's `const LEVELS = [ ... ];` block inside
the // >>>CORE section, and leaves the rest of the file untouched.

    python3 scripts/bake-levels.py shikaku
    python3 scripts/bake-levels.py queens
"""
import importlib.util
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PAGES = {
    'shikaku': os.path.expanduser('~/kaos/work/site/games/arcade/shikaku/index.html'),
    'queens': os.path.expanduser('~/kaos/work/site/games/arcade/queens/index.html'),
}


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + '-gen.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def literal(name):
    if name == 'shikaku':
        g = load('shikaku')
        sizes = [(5, True), (6, False), (7, False), (8, False)]
        levels = [g.make(n, g.SEEDS[i], unit=u) for i, (n, u) in enumerate(sizes)]
        out = ['const LEVELS = [']
        for L in levels:
            out.append('  { n: %d,' % L['n'])
            out.append('    rects: %s,' % json.dumps(L['rects']))
            out.append('    clues: %s },' % json.dumps(L['clues']))
        out.append('];')
        return '\n'.join(out), levels
    if name == 'queens':
        g = load('queens')
        sizes = [6, 7, 8]
        levels = [g.make(n, g.SEEDS[i]) for i, n in enumerate(sizes)]
        out = ['const LEVELS = [']
        for L in levels:
            regs = json.dumps(L['regions'])
            out.append('  { n: %d,' % L['n'])
            out.append('    regions: %s,' % regs)
            out.append('    solution: %s },' % json.dumps(L['solution']))
        out.append('];')
        return '\n'.join(out), levels
    raise SystemExit('unknown game ' + name)


def main():
    name = sys.argv[1]
    page = PAGES[name]
    js, levels = literal(name)
    html = open(page).read()
    pat = re.compile(r'const LEVELS = \[.*?\n\];', re.S)
    if not pat.search(html):
        raise SystemExit('no const LEVELS block in ' + page)
    html2 = pat.sub(lambda m: js, html, count=1)
    open(page, 'w').write(html2)
    print('baked %s into %s' % (name, page))
    for L in levels:
        print('  n=%d %s' % (L['n'], {k: (len(v) if isinstance(v, list) else v) for k, v in L.items() if k != 'regions'}))


if __name__ == '__main__':
    main()
