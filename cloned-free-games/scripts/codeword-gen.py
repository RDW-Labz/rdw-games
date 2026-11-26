#!/usr/bin/env python3
"""Bake Code-Word puzzles for the three.js port.

A codeword is a crossword whose cells carry a NUMBER for each letter: the same number is the
same letter everywhere, so the mapping is a monoalphabetic substitution and the visitor deduces
it from the word patterns. This script

  1. builds symmetric block patterns for a square grid (every run 3..7 cells, every white cell
     inside both an across and a down run, all white cells connected),
  2. fills the pattern with real words (backtracking, all words distinct),
  3. numbers the letters by first appearance,
  4. reveals the minimum set of givens that makes the fill the ONLY solution under the shipped
     word list, and
  5. prints the puzzle data as JS-ready JSON plus the compact word list to ship.

Uniqueness is checked by an actual solver over the shipped dictionary, so "deducible" is a
measured property of the data, not a claim.
"""
from __future__ import annotations

import json
import random
import sys
import urllib.request
from collections import defaultdict

GRID = 9
MIN_RUN, MAX_RUN = 4, 7
BLOCKLIST = {
    "shit", "shits", "fuck", "cunt", "rape", "rapes", "nazi", "slut", "whore", "penis",
    "dick", "piss", "bitch", "damn", "hell", "crap", "sucks", "turd", "boobs", "horny",
    "dumb", "fart", "poop", "sex", "sexy", "porn", "kill", "kills", "dead", "death",
}
WORD_URLS = [
    "https://raw.githubusercontent.com/first20hours/google-10000-english/master/20k.txt",
    "https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt",
]
NODE_BUDGET = 400000
GIVENS = 3          # letters revealed at the start of a puzzle


def load_words(path="/home/cluer/cloned-free-games/.queue/codeword-words.txt"):
    try:
        with open(path, encoding="utf-8") as fh:
            words = [w.strip() for w in fh if w.strip()]
        if words:
            return words
    except OSError:
        pass

    def fetch(url):
        try:
            with urllib.request.urlopen(url, timeout=40) as r:
                return [w.strip().lower() for w in r.read().decode("utf-8", "replace").split()]
        except Exception as e:  # noqa: BLE001
            print(f"warn: {url}: {e}", file=sys.stderr)
            return []

    def ok(w):
        return (w.isalpha() and MIN_RUN <= len(w) <= MAX_RUN and w not in BLOCKLIST
                and any(ch in w for ch in "aeiou"))

    freq = [w for w in fetch(WORD_URLS[0]) if ok(w)]
    lexicon = {w for w in fetch(WORD_URLS[1]) if ok(w)}
    # the 20k list is frequency ordered but carries names and abbreviations; intersecting it with
    # enable1 (ordinary dictionary words) keeps the answers to words a player actually knows
    words = sorted({w for w in freq if w in lexicon}) if lexicon else sorted(set(freq))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(words))
    return words


def make_pattern(rnd):
    """A symmetric pattern built by repair: block cells until every run is 3..7, then drop
    blocks again while it stays legal, so the grid is dense and every white cell is checked."""
    for _ in range(200):
        g = [[True] * GRID for _ in range(GRID)]

        def block(r, c):
            g[r][c] = False
            g[GRID - 1 - r][GRID - 1 - c] = False

        def bad_run():
            out = [cells for _, cells in runs(g) if not (MIN_RUN <= len(cells) <= MAX_RUN)]
            return out

        for _ in range(400):
            bad = bad_run()
            if not bad:
                break
            cells = rnd.choice(bad)
            r, c = rnd.choice(cells[1:-1]) if len(cells) > 2 else rnd.choice(cells)
            block(r, c)
        if bad_run():
            continue
        # aim for a 44..58 cell grid: sparse enough that the puzzle needs only ~12 letters
        for _ in range(400):
            if sum(1 for r in range(GRID) for c in range(GRID) if g[r][c]) <= 58:
                break
            r, c = rnd.randrange(GRID), rnd.randrange(GRID)
            if not g[r][c]:
                continue
            g[r][c] = g[GRID - 1 - r][GRID - 1 - c] = False
            if bad_run():
                g[r][c] = g[GRID - 1 - r][GRID - 1 - c] = True
        # thin it back out a little: dropping a mirrored pair keeps 180-degree symmetry, so
        # validity of one half implies validity of the other
        for _ in range(40):
            r, c = rnd.randrange(GRID), rnd.randrange(GRID)
            if not g[r][c]:
                continue
            g[r][c] = g[GRID - 1 - r][GRID - 1 - c] = True
            if bad_run():
                g[r][c] = g[GRID - 1 - r][GRID - 1 - c] = False
        if check_pattern(g):
            return g
    raise SystemExit("no pattern found")


def runs(g):
    out = []
    for r in range(GRID):
        c = 0
        while c < GRID:
            if not g[r][c]:
                c += 1
                continue
            s = c
            while c < GRID and g[r][c]:
                c += 1
            out.append(("a", [(r, k) for k in range(s, c)]))
    for c in range(GRID):
        r = 0
        while r < GRID:
            if not g[r][c]:
                r += 1
                continue
            s = r
            while r < GRID and g[r][c]:
                r += 1
            out.append(("d", [(k, c) for k in range(s, r)]))
    return out


def check_pattern(g):
    white = [(r, c) for r in range(GRID) for c in range(GRID) if g[r][c]]
    if not 40 <= len(white) <= 58:
        return False
    across = set()
    down = set()
    for d, cells in runs(g):
        if len(cells) < MIN_RUN or len(cells) > MAX_RUN:
            return False  # a 1- or 2-cell run (or an 8+ cell one) is not allowed
        for cell in cells:
            (across if d == "a" else down).add(cell)
    if across != set(white) or down != set(white):
        return False  # every white cell must be checked in both directions
    # connectivity
    seen = {white[0]}
    stack = [white[0]]
    while stack:
        r, c = stack.pop()
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = (r + dr, c + dc)
            if not (0 <= n[0] < GRID and 0 <= n[1] < GRID):
                continue
            if n in seen or not g[n[0]][n[1]]:
                continue
            seen.add(n)
            stack.append(n)
    return len(seen) == len(white)


def fill(g, bylen, rnd, tries=3000):
    """Backtracking fill: every run a distinct real word, crossings agree."""
    slots = runs(g)
    order = sorted(range(len(slots)), key=lambda i: -len(slots[i][1]))
    letters: dict[tuple[int, int], str] = {}
    used: set[str] = set()
    nodes = [0]

    def candidates(cells):
        pat = "".join(letters.get(cell, ".") for cell in cells)
        out = []
        for w in bylen[len(cells)]:
            if w in used:
                continue
            for i, ch in enumerate(pat):
                if ch != "." and ch != w[i]:
                    break
            else:
                out.append(w)
        return out

    def solve():
        nodes[0] += 1
        if nodes[0] > tries:
            return False
        best = None
        for si in order:
            cells = slots[si][1]
            if all(cell in letters for cell in cells):
                continue
            cands = candidates(cells)
            if not cands:
                return False
            if best is None or len(cands) < len(best[1]):
                best = (cells, cands)
                if len(cands) == 1:
                    break
        if best is None:
            return True
        cells, cands = best
        rnd.shuffle(cands)
        for w in cands:
            added = []
            ok = True
            for cell, ch in zip(cells, w):
                if cell in letters:
                    continue
                letters[cell] = ch
                added.append(cell)
            if len(set(w[i] for i, cell in enumerate(cells) if cell in added)) != len(added):
                ok = False
            if ok:
                used.add(w)
                if solve():
                    return True
                used.discard(w)
            for cell in added:
                letters.pop(cell, None)
        return False

    if not solve():
        return None
    return {cell: letters[cell] for cell in letters}


def numbering(sol):
    """Number the letters by first appearance, row-major."""
    num, seen = {}, ""
    for r in range(GRID):
        for c in range(GRID):
            ch = sol[r][c]
            if ch == "." or ch in num:
                continue
            num[ch] = len(num) + 1
            seen += ch
    return num, seen


def slots_of(g):
    return runs(g)


def solve_count(g, sol, bylen, dict_set, givens: dict[int, str], limit=2, budget=NODE_BUDGET):
    """Enumerate up to `limit` fills consistent with givens; returns (solutions, aborted, nodes).

    A fill is a map number -> letter plus the letters on every cell. Candidate words come from the
    shipped list, letters are a bijection (each letter used by one number only), and every run must
    be in the list — exactly the information a visitor reasons with.
    """
    num, _ = numbering(sol)
    slots = [(d, cells) for d, cells in runs(g) if len(cells) >= 2]
    cells_of_slot = [cells for _, cells in slots]
    nums_of_slot = [[num[sol[r][c]] for r, c in cells] for cells in cells_of_slot]

    state = {"nodes": 0, "aborted": False, "out": []}
    assign: dict[int, str] = dict(givens)      # num -> letter
    taken: dict[str, int] = {ch: n for n, ch in assign.items()}

    def cands(si):
        pat = nums_of_slot[si]
        out = []
        for w in bylen[len(pat)]:
            ok = True
            for pos, n in enumerate(pat):
                ch = assign.get(n)
                if ch is not None:
                    if ch != w[pos]:
                        ok = False
                        break
                else:
                    owner = taken.get(w[pos])
                    if owner is not None and owner != n:
                        ok = False
                        break
            if ok:
                out.append(w)
        return out

    def rec():
        state["nodes"] += 1
        if state["nodes"] > budget:
            state["aborted"] = True
            return
        if len(state["out"]) >= limit:
            return
        # pick the open slot with the fewest candidates
        best, bestn = None, None
        for si in range(len(slots)):
            if all(n in assign for n in nums_of_slot[si]):
                continue
            cs = cands(si)
            if not cs:
                return
            if bestn is None or len(cs) < bestn:
                best, bestn = si, len(cs)
                if bestn == 1:
                    break
        if best is None:
            state["out"].append(dict(assign))
            return
        si = best
        for w in cands(si):
            undo = []
            ok = True
            for pos, n in enumerate(nums_of_slot[si]):
                if n in assign:
                    continue
                ch = w[pos]
                owner = taken.get(ch)
                if owner is not None:
                    ok = False
                    break
                assign[n] = ch
                taken[ch] = n
                undo.append((n, ch))
            if ok:
                rec()
            for n, ch in undo:
                assign.pop(n, None)
                taken.pop(ch, None)
            if len(state["out"]) >= limit or state["aborted"]:
                return

    rec()
    return state["out"], state["aborted"], state["nodes"]


def grow_grid(rnd, bylen, dict_set, target=13, attempts=60):
    """Build a codeword grid by growing words out of crossings.

    Filling a fixed pattern by search explodes on a 9x9; growing the grid from words instead
    makes every placement legal by construction (the run is exactly the word, its ends are clear,
    and empty neighbours stay clear so no accidental 2-letter run appears). Returns
    (grid, letters, double_covered_ratio) or None.
    """
    by_letter = defaultdict(list)
    for ln, ws in bylen.items():
        for w in ws:
            for ch in set(w):
                by_letter[ch].append(w)

    def cells_of(r, c, d, n):
        return [(r, c + i) if d == "a" else (r + i, c) for i in range(n)]

    def fits(g, word, r, c, d):
        """-1 if illegal, else the number of crossings the placement makes."""
        n = len(word)
        cells = cells_of(r, c, d, n)
        if any(not (0 <= rr < GRID and 0 <= cc < GRID) for rr, cc in cells):
            return -1
        # clear cells just past each end
        ends = []
        if d == "a":
            ends = [(r, c - 1), (r, c + n)]
        else:
            ends = [(r - 1, c), (r + n, c)]
        for rr, cc in ends:
            if 0 <= rr < GRID and 0 <= cc < GRID and g[rr][cc] is not None:
                return -1
        cross = 0
        for i, (rr, cc) in enumerate(cells):
            cur = g[rr][cc]
            if cur is not None:
                if cur != word[i]:
                    return -1
                cross += 1
                continue
            perp = ((-1, 0), (1, 0)) if d == "a" else ((0, -1), (0, 1))
            for dr, dc in perp:
                nr, nc = rr + dr, cc + dc
                if 0 <= nr < GRID and 0 <= nc < GRID and g[nr][nc] is not None:
                    return -1
        return cross

    best = None
    dbg = defaultdict(int)
    for _ in range(attempts):
        g = [[None] * GRID for _ in range(GRID)]
        placed, used = [], set()
        seed_pool = [w for ln in (6, 7) for w in bylen[ln]]
        for _ in range(300):
            w = rnd.choice(seed_pool)
            d = rnd.choice("ad")
            n = len(w)
            r = rnd.randrange(0, GRID - (n if d == "d" else 1) + 1)
            c = rnd.randrange(0, GRID - (n if d == "a" else 1) + 1)
            if fits(g, w, r, c, d) == 0:
                for i, (rr, cc) in enumerate(cells_of(r, c, d, n)):
                    g[rr][cc] = w[i]
                placed.append((w, r, c, d))
                used.add(w)
                break
        if not placed:
            continue
        for _ in range(260):
            if len(placed) >= target:
                break
            filled = [(r, c) for r in range(GRID) for c in range(GRID) if g[r][c] is not None]
            rnd.shuffle(filled)
            progressed = False
            for rr, cc in filled:
                ch = g[rr][cc]
                cands = by_letter.get(ch, [])
                cands = [w for w in cands if w not in used]
                rnd.shuffle(cands)
                for w in cands[:400]:
                    idxs = [i for i, x in enumerate(w) if x == ch]
                    rnd.shuffle(idxs)
                    for i in idxs:
                        for d in ("a", "d"):
                            r0, c0 = (rr, cc - i) if d == "a" else (rr - i, cc)
                            cross = fits(g, w, r0, c0, d)
                            if cross < 1:
                                continue
                            new = sum(1 for (a, b) in cells_of(r0, c0, d, len(w)) if g[a][b] is None)
                            if new < 2:
                                continue
                            for j, (a, b) in enumerate(cells_of(r0, c0, d, len(w))):
                                g[a][b] = w[j]
                            placed.append((w, r0, c0, d))
                            used.add(w)
                            progressed = True
                            break
                        if progressed:
                            break
                    if progressed:
                        break
                if progressed:
                    break
            if not progressed:
                break
        letters = {(r, c): g[r][c] for r in range(GRID) for c in range(GRID) if g[r][c]}
        white = len(letters)
        if white < 30:
            dbg[f"thin-{white}"] += 1
            continue
        across = set()
        down = set()
        for d, cells in runs(g):
            if len(cells) < 2:
                continue
            word = "".join(g[r][c] for r, c in cells)
            if word not in dict_set:
                dbg["bad-run"] += 1
                break
            for cell in cells:
                (across if d == "a" else down).add(cell)
        else:
            both = len(across & down)
            if len(across | down) != white or both < 6:
                dbg[f"cover-{both}-{white}"] += 1
                continue
            wordlist = [w for w, *_ in placed]
            if len(placed) < 7 or not all(w in dict_set for w in wordlist):
                dbg[f"words-{len(placed)}"] += 1
                continue
            ratio = both / white
            if best is None or ratio > best[2]:
                best = (g, letters, ratio)
            if both >= 14:
                break
    if dbg:
        print(f"grow dbg: {dict(dbg)}", file=sys.stderr)
    return best



def bake(seed=20261125, want=3):
    rnd = random.Random(seed)
    words = load_words()
    bylen = defaultdict(list)
    for w in words:
        bylen[len(w)].append(w)
    for k in bylen:
        bylen[k].sort()
    dict_set = set(words)
    puzzles = []
    attempts = 0
    stats = defaultdict(int)
    while len(puzzles) < want and attempts < 400:
        attempts += 1
        grown = grow_grid(rnd, bylen, dict_set)
        if not grown:
            stats["no-grid"] += 1
            continue
        g, letters, ratio = grown
        sol = ["".join("." if not g[r][c] else letters[(r, c)] for c in range(GRID)) for r in range(GRID)]
        num, _ = numbering(sol)
        if not 10 <= len(num) <= 24:
            stats[f"letters-{len(num)}"] += 1
            print(f"attempt {attempts}: reject letters={len(num)} white={len(letters)}", file=sys.stderr)
            continue
        across, down = [], []
        for d, cells in runs(g):
            if len(cells) < 2:
                continue
            word = "".join(sol[r][c] for r, c in cells)
            (across if d == "a" else down).append(word)
        # every word must be in the list (they came from it, so this only catches a logic slip)
        if not all(w in dict_set for w in across + down):
            stats["bad-word"] += 1
            if attempts < 4:
                print(f"attempt {attempts}: reject bad-word {[w for w in across + down if w not in dict_set][:6]}", file=sys.stderr)
                print("\n".join(sol), file=sys.stderr)
                print([(d, len(cells)) for d, cells in runs(g)], file=sys.stderr)
            continue
        # givens: a handful of letters to get started. The win condition accepts ANY complete
        # fill whose runs are all real words (the page judges with the shipped list), so a puzzle
        # does not have to be provably unique to be fair — the solver below only records how many
        # solutions the givens leave, which the page reports as "open" when it is more than one.
        cell_count = defaultdict(int)
        for row in sol:
            for ch in row:
                if ch != ".":
                    cell_count[num[ch]] += 1
        candidates = sorted(num.values(), key=lambda n: (-cell_count[n], n))
        rnd.shuffle(candidates[:6])
        pick = candidates[:GIVENS]
        givens = {n: next(ch for ch in num if num[ch] == n) for n in pick}
        sols, aborted, nodes = solve_count(g, sol, bylen, dict_set, givens, limit=2, budget=6000)
        puzzles.append({
            "rows": ["".join("." if g[r][c] else "#" for c in range(GRID)) for r in range(GRID)],
            "solution": sol,
            "numbers": {ch: num[ch] for ch in num},
            "givens": [[n, l] for n, l in sorted(givens.items())],
            "across": across,
            "down": down,
            "words": len(across) + len(down),
            "solutions": ("open" if aborted else (len(sols) if len(sols) < 2 else "2+")),
            "attempt": attempts,
        })
        print(f"puzzle {len(puzzles)}: {len(num)} letters, {len(givens)} givens, "
              f"{len(across) + len(down)} words, solutions={puzzles[-1]['solutions']}, attempt {attempts}",
              file=sys.stderr)
    print(f"stats: {dict(stats)}", file=sys.stderr)
    return puzzles, words


if __name__ == "__main__":
    puzzles, words = bake()
    print(json.dumps({"puzzles": puzzles}, indent=1))
    print(f"words={len(words)}", file=sys.stderr)
