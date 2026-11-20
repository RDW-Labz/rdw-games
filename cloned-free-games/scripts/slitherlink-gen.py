#!/usr/bin/env python3
"""Author Slitherlink boards that are solvable by construction.

A Slitherlink solution is a single closed loop on the dot lattice. Rather than hand-drawing
edges (which reliably produces a loop that touches itself at a dot, or a cell with all four
sides drawn — a clue of 4, which is not a legal Slitherlink number), this builds the loop as
the boundary of a one-cell-wide snake of cells:

  * the snake never touches itself — a new cell must be Chebyshev distance >= 2 from every
    earlier cell except the one it steps from. No shared edge => each cell keeps its own
    boundary pieces, and no shared corner => no dot ever gets degree 4.
  * the loop is the set of cell sides not shared with another snake cell, so every dot on it
    has degree exactly 2 and the whole thing is one closed cycle.
  * clues are the per-cell count of those sides (1..3), so they agree with the loop by
    construction. Cells outside the snake are clue 0.

Usage:  python3 scripts/slitherlink-gen.py [W H SEED SENTINEL]
Prints JS board literals for games/arcade/slitherlink/index.html.
"""
import random
import sys

STEP = [(1, 0), (-1, 0), (0, 1), (0, -1)]


def snake(W, H, rng, target):
    """Grow a path of `target` cells that never re-joins itself by an edge.

    Only one rule is enforced while growing: a new cell may not be edge-adjacent to any cell
    except the one it steps from (a shared edge between non-consecutive cells merges or splits
    the boundary). Corner contact is left alone — an L-turn legitimately has two cells meeting
    at a dot, and it is check() that rejects the real pinch points (a dot of degree 4).
    """
    start = (rng.randrange(W), rng.randrange(H))
    path = [start]
    used = {start}

    def reaches(cell, i):
        """Would stepping to `cell` from path[-1] touch an older cell by an edge?"""
        cx, cy = cell
        if not (0 <= cx < W and 0 <= cy < H) or (cx, cy) in used:
            return True
        for j, (px, py) in enumerate(path):
            if j == len(path) - 1:
                continue
            if abs(px - cx) + abs(py - cy) == 1:
                return True
        return False

    guard = 0
    while len(path) < target and guard < 20000:
        guard += 1
        cx, cy = path[-1]
        cands = [(cx + dx, cy + dy) for dx, dy in STEP]
        rng.shuffle(cands)
        grew = False
        for cand in cands:
            if not reaches(cand, len(path) - 1):
                path.append(cand)
                used.add(cand)
                grew = True
                break
        if grew:
            continue
        if len(path) > 2:                    # dead end: back off one cell
            used.discard(path.pop())
    return path


def borders(cells):
    """Map (x,y) -> digit of sides not shared with another snake cell."""
    s = set(cells)
    out = {}
    for (x, y) in cells:
        n = 0
        for dx, dy in STEP:
            if (x + dx, y + dy) not in s:
                n += 1
        out[(x, y)] = n
    return out


def clues_from_loop(W, H, loop):
    """Clue per cell = how many of the loop's edges touch that cell.

    Every cell must be measured, not just the snake's own cells: a concave notch in the loop runs
    along the sides of cells that are not part of the snake, and those cells genuinely see lines
    (a 0 there would make the stored loop disagree with its own clues — the board would be
    unwinnable).
    """
    hrow = loop[:(H + 1) * W]
    vrow = loop[(H + 1) * W:]
    out = []
    for y in range(H):
        for x in range(W):
            n = (1 if hrow[y * W + x] == '1' else 0) + (1 if hrow[(y + 1) * W + x] == '1' else 0) + \
                (1 if vrow[y * (W + 1) + x] == '1' else 0) + (1 if vrow[y * (W + 1) + x + 1] == '1' else 0)
            out.append(str(n))
    return ''.join(out)


def edges_of(W, H, cells):
    """Canonical edge bits: H row-major (H+1 rows x W), then V row-major (H rows x W+1)."""
    s = set(cells)
    bits = []
    for y in range(H + 1):
        for x in range(W):
            bits.append('1' if ((x, y) in s) != ((x, y - 1) in s) else '0')
    for y in range(H):
        for x in range(W + 1):
            bits.append('1' if ((x, y) in s) != ((x - 1, y) in s) else '0')
    return ''.join(bits)


def check(W, H, cells, loop):
    """Degree-2 everywhere, one cycle, no clue of 4."""
    s = set(cells)
    deg = {}
    def bump(a):
        deg[a] = deg.get(a, 0) + 1
    i = 0
    for y in range(H + 1):
        for x in range(W):
            if loop[i] == '1':
                bump((x, y)); bump((x + 1, y))
            i += 1
    for y in range(H):
        for x in range(W + 1):
            if loop[i] == '1':
                bump((x, y)); bump((x, y + 1))
            i += 1
    assert i == len(loop)
    assert all(d == 2 for d in deg.values()), deg
    # one cycle: union-find over drawn edges
    parent = {}
    def find(a):
        parent.setdefault(a, a)
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    n = 0
    i = 0
    for y in range(H + 1):
        for x in range(W):
            if loop[i] == '1':
                parent[find((x, y))] = find((x + 1, y)); n += 1
            i += 1
    for y in range(H):
        for x in range(W + 1):
            if loop[i] == '1':
                parent[find((x, y))] = find((x, y + 1)); n += 1
            i += 1
    roots = {find(k) for k in deg}
    assert len(roots) == 1 and n > 0, (roots, n)
    cl = borders(cells)
    assert max(cl.values()) <= 3, cl
    return True


def board(W, H, seed, target, blank_every=0):
    rng = random.Random(seed)
    for attempt in range(60):
        cells = snake(W, H, rng, target)
        if len(cells) < max(4, target // 2):
            continue
        cells = cells[:]
        loop = edges_of(W, H, cells)
        try:
            check(W, H, cells, loop)
        except AssertionError:
            continue
        cl = clues_from_loop(W, H, loop)
        clues = list(cl)
        if blank_every:
            # blank a deterministic slice of clue cells (never the ends-of-snake 3s only)
            for k in range(len(clues)):
                if k % blank_every == 3:
                    clues[k] = '.'
        return {'w': W, 'h': H, 'clues': ''.join(clues), 'loop': loop, 'cells': cells}
    raise SystemExit(f'no valid snake for {W}x{H} seed {seed}')


if __name__ == '__main__':
    a = [int(x) for x in sys.argv[1:]]
    W, H = (a + [4, 4])[:2]
    seed = (a + [7])[2] if len(a) > 2 else 7
    target = (a + [0])[3] if len(a) > 3 else max(4, (W * H) // 2)
    blank = (a + [0])[4] if len(a) > 4 else 0
    print(board(W, H, seed, target, blank))
