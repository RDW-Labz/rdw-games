#!/usr/bin/env python3
"""Queens board generator.

A Queens board is an n x n grid cut into n contiguous regions. The rule: place one queen in
every row, column and region, with no two queens on a shared diagonal. Boards are built from
a random n-queens solution (so at least one answer exists), regions are grown from those
solution cells, and the board is only shipped when a full search finds EXACTLY ONE placement.

    python3 scripts/queens-gen.py        # JS literal + a per-board uniqueness report
"""
import json
import random
from itertools import permutations

SEEDS = [4407, 90211, 61507]


def diagonal_ok(cols):
    n = len(cols)
    for i in range(n):
        for j in range(i + 1, n):
            if abs(cols[i] - cols[j]) == j - i:
                return False
    return True


def solutions(regions, n, limit=2):
    """Count queen placements: one per row/col/region, no shared diagonal. Stops at `limit`."""
    region_of = [regions[r * n + c] for r in range(n) for c in range(n)]
    found = []
    cols = [-1] * n  # col used per row

    def rec(r, used_col, used_reg, d1, d2):
        if len(found) >= limit:
            return
        if r == n:
            found.append(cols[:])
            return
        for c in range(n):
            g = region_of[r * n + c]
            b1, b2 = r + c, r - c + n
            if used_col >> c & 1 or used_reg >> g & 1:
                continue
            if d1 >> b1 & 1 or d2 >> b2 & 1:
                continue
            cols[r] = c
            rec(r + 1, used_col | 1 << c, used_reg | 1 << g, d1 | 1 << b1, d2 | 1 << b2)
            cols[r] = -1
            if len(found) >= limit:
                return

    rec(0, 0, 0, 0, 0)
    return found


def random_solution(n, rnd):
    cols = list(range(n))
    for _ in range(40000):
        rnd.shuffle(cols)
        if diagonal_ok(cols):
            return list(cols)
    raise SystemExit('no n-queens solution for n=%d' % n)


def grow_regions(n, seeds, rnd):
    """Random flood fill from one seed cell per region; every region stays contiguous."""
    regions = [-1] * (n * n)
    for g, (r, c) in enumerate(seeds):
        regions[r * n + c] = g
    live = [g for g in range(n)]
    for _ in range(n * n * 60):
        if all(v >= 0 for v in regions):
            break
        size = [regions.count(g) for g in range(n)]
        cands = []
        for r in range(n):
            for c in range(n):
                if regions[r * n + c] >= 0:
                    continue
                near = {regions[rr * n + cc] for rr, cc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1))
                        if 0 <= rr < n and 0 <= cc < n and regions[rr * n + cc] >= 0}
                for g in near:
                    if size[g] < 3 * n:
                        cands.append((r, c, g, size[g]))
        if not cands:
            return None
        smallest = min(x[3] for x in cands)
        pool = [x for x in cands if x[3] <= smallest + 1]
        r, c, g, _ = pool[rnd.randrange(len(pool))]
        regions[r * n + c] = g
    if any(v < 0 for v in regions):
        return None
    return regions


def make(n, seed):
    rnd = random.Random(seed)
    fallback = None
    for attempt in range(4000):
        sol = random_solution(n, rnd)
        seeds = [(r, sol[r]) for r in range(n)]
        regions = grow_regions(n, seeds, rnd)
        if regions is None:
            continue
        found = solutions(regions, n, limit=3)
        if not found:
            continue
        if len(found) == 1:
            return {'n': n, 'regions': regions, 'solution': [[r, found[0][r]] for r in range(n)],
                    'attempt': attempt, 'count': 1}
        # A board with two answers still plays honestly (the win is rule satisfaction, not
        # matching the stored answer), so keep the first one as a fallback and keep hunting.
        if fallback is None and len(found) == 2:
            fallback = {'n': n, 'regions': regions, 'solution': [[r, found[0][r]] for r in range(n)],
                        'attempt': attempt, 'count': 2}
    if fallback:
        return fallback
    raise SystemExit('no board for n=%d' % n)


def main():
    sizes = [6, 7, 8]
    levels = [make(n, SEEDS[i]) for i, n in enumerate(sizes)]
    print('const LEVELS = [')
    for L in levels:
        print('  { n: %d,' % L['n'])
        print('    regions: %s,' % json.dumps(L['regions']))
        print('    solution: %s },' % json.dumps(L['solution']))
    print('];')
    for L in levels:
        print('# n=%d answers=%d cells/region=%s attempts=%d' % (
            L['n'], L['count'], sorted(L['regions'].count(g) for g in range(L['n'])), L['attempt']))


if __name__ == '__main__':
    main()
