#!/usr/bin/env python3
"""Shikaku board generator.

Builds boards by recursive guillotine splitting, so every board is a partition into
rectangles by construction: the stored rect list IS the solution. Each rectangle gets one
clue cell whose value is the rectangle's area, which is exactly the Shikaku rule. Every
board is therefore solvable, and the core test re-proves that against the shipped page.

    python3 scripts/shikaku-gen.py            # JS literal for the shipped page

A unit rectangle is forced into the first board so the tap/touch gate has a cell that a
single-cell rectangle can legitimately claim.
"""
import json
import random

SEEDS = [20261121, 771103, 99173, 40127]


def split(rect, rnd, p_stop=0.30):
    r0, c0, r1, c1 = rect
    h, w = r1 - r0 + 1, c1 - c0 + 1
    area = h * w
    if area <= 2 or (h == 1 and w == 1) or rnd.random() < p_stop:
        return [rect]
    cut_h = h >= w and h > 1
    if cut_h:
        k = rnd.randint(1, h - 1)
        return split((r0, c0, r0 + k - 1, c1), rnd, p_stop) + split((r0 + k, c0, r1, c1), rnd, p_stop)
    k = rnd.randint(1, w - 1)
    return split((r0, c0, r1, c0 + k - 1), rnd, p_stop) + split((r0, c0 + k, r1, c1), rnd, p_stop)


def area_of(r):
    return (r[2] - r[0] + 1) * (r[3] - r[1] + 1)


def partition(n, rnd):
    """A random tiling of n x n by rectangles; retries until it is not trivial."""
    for _ in range(3000):
        rects = split((0, 0, n - 1, n - 1), rnd)
        if len(rects) < max(6, int(n * 1.7)):
            continue
        if max(area_of(r) for r in rects) > max(4, (n * n) // 5):
            continue
        return rects
    raise SystemExit('no partition for n=%d' % n)


def force_unit(rects, rnd):
    """Split one rectangle so a 1x1 rect exists (the gate taps it as a legal claim)."""
    order = list(range(len(rects)))
    rnd.shuffle(order)
    for i in order:
        r0, c0, r1, c1 = rects[i]
        if c1 > c0:
            rest = (r0, c0 + 1, r1, c1)
        elif r1 > r0:
            rest = (r0 + 1, c0, r1, c1)
        else:
            continue
        return rects[:i] + [(r0, c0, r0, c0), rest] + rects[i + 1:]
    return rects


def make(n, seed, unit=False):
    rnd = random.Random(seed)
    rects = partition(n, rnd)
    if unit:
        rects = force_unit(rects, rnd)
    clues = []
    for r0, c0, r1, c1 in rects:
        clues.append([rnd.randint(r0, r1), rnd.randint(c0, c1), area_of((r0, c0, r1, c1))])
    return {'n': n, 'rects': [list(x) for x in rects], 'clues': clues}


def main():
    sizes = [(5, True), (6, False), (7, False), (8, False)]
    levels = [make(n, SEEDS[i], unit=u) for i, (n, u) in enumerate(sizes)]
    print('const LEVELS = [')
    for L in levels:
        print('  { n: %d,' % L['n'])
        print('    rects: %s,' % json.dumps(L['rects']))
        print('    clues: %s },' % json.dumps(L['clues']))
    print('];')
    json.dump(levels, open('/tmp/shikaku-levels.json', 'w'), indent=0)
    for L in levels:
        print('# level n=%d rects=%d areas=%s' % (L['n'], len(L['rects']), sorted(area_of(r) for r in L['rects'])))


if __name__ == '__main__':
    main()
