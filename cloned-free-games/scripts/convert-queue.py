#!/usr/bin/env python3
"""Pick the next quarantine entries for the three.js conversion queue.

The library audit (.queue/library-audit.json) holds every catalog card that fails the
click-and-play rule, with why. This script turns that into a work queue: it drops titles
that are already converted (matched by arcade/arcade.json), blocked, or already logged as
converted, ranks what is left by how cheaply it converts to a three.js board game, and
prints the next few as JSON.

    scripts/convert-queue.py                 # top 5 candidates + queue stats
    scripts/convert-queue.py --next          # just the single next candidate
    scripts/convert-queue.py --claim <slug>  # mark it in-flight in .queue/conversion-log.json
    scripts/convert-queue.py --done <slug> --entry /games/arcade/x.html

Ranking is deliberately blunt: board/puzzle classics first (they map to a tile grid and a
tiny ruleset), then everything else. It is a hint, not a gate — the human or agent doing
the conversion can always pick a different title.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIT = os.path.join(SRC, ".queue", "library-audit.json")
LOG = os.path.join(SRC, ".queue", "conversion-log.json")
ARCADE = os.path.join(SRC, "arcade", "arcade.json")
BLOCK = os.path.join(SRC, "scripts", "playable-block.txt")

# Cheap conversions: a grid of tiles and a small ruleset. Everything else is "later".
EASY = re.compile(
    r"mine|sweep|2048|tetris|snake|breakout|brick|pong|invader|sudoku|solitaire|mahjong"
    r"|checkers|dame|reversi|othello|chess|go\b|gomoku|connect.?4|lights.?out|15.?puzzle"
    r"|sliding|nonogram|picross|kakuro|maze|labyrinth|tile.?match|memory|pairs|puzzle",
    re.I,
)
MEDIUM = re.compile(r"pinball|platform|runner|shooter|tower.?defen|rpg|rougelike|roguelike|strategy|sim", re.I)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--next", action="store_true", help="print only the next candidate")
    ap.add_argument("--limit", type=int, default=5)
    ap.add_argument("--claim", help="mark a slug in-flight")
    ap.add_argument("--done", help="mark a slug converted")
    ap.add_argument("--entry", default="", help="arcade entry path for --done")
    ap.add_argument("--skip", help="mark a slug not convertible (with --why)")
    ap.add_argument("--why", default="", help="reason recorded with --skip")
    args = ap.parse_args()

    log = load_json(LOG, {"converted": {}, "inflight": {}, "skipped": {}})
    log.setdefault("converted", {})
    log.setdefault("inflight", {})
    log.setdefault("skipped", {})
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    if args.claim:
        log["inflight"][args.claim] = {"at": now}
        with open(LOG, "w", encoding="utf-8") as fh:
            json.dump(log, fh, indent=1)
        print(f"claimed {args.claim}")
        return 0
    if args.done:
        log["converted"][args.done] = {"at": now, "entry": args.entry}
        log["inflight"].pop(args.done, None)
        with open(LOG, "w", encoding="utf-8") as fh:
            json.dump(log, fh, indent=1)
        print(f"converted {args.done} -> {args.entry or '(no entry)'}")
        return 0
    if args.skip:
        log["skipped"][args.skip] = {"at": now, "why": args.why}
        log["inflight"].pop(args.skip, None)
        with open(LOG, "w", encoding="utf-8") as fh:
            json.dump(log, fh, indent=1)
        print(f"skipped {args.skip}: {args.why or '(no reason)'}")
        return 0

    audit = load_json(AUDIT, None)
    if not audit:
        print("FAIL: no .queue/library-audit.json — run scripts/library-audit.py first")
        return 2

    arcade = load_json(ARCADE, {"games": []})
    have = set()
    for g in arcade.get("games", []):
        for m in [g.get("slug", "")] + list(g.get("match", [])):
            if m:
                have.add(m.lower())

    blocked = set()
    try:
        for line in open(BLOCK, encoding="utf-8"):
            slug = line.split("#", 1)[0].strip()
            if slug:
                blocked.add(slug.lower())
    except OSError:
        pass

    rows, stats = [], {"quarantine": 0, "converted": 0, "already": 0, "blocked": 0, "inflight": 0, "skipped": 0}
    for r in audit.get("entries_quarantine", []):
        stats["quarantine"] += 1
        name = (r.get("name") or "").strip()
        slug = (r.get("slug") or name).strip()
        key = slug.lower()
        if key in blocked:
            stats["blocked"] += 1
            continue
        if key in log["converted"] or key in have:
            stats["already"] += 1
            continue
        if key in log["inflight"]:
            stats["inflight"] += 1
            continue
        if key in log["skipped"]:
            stats["skipped"] += 1
            continue
        tier = 0 if EASY.search(name or slug) else (1 if MEDIUM.search(name or slug) else 2)
        rows.append({
            "slug": re.sub(r"[^a-z0-9]+", "-", key).strip("-"),
            "name": name,
            "source": r.get("launch", ""),
            "mode": r.get("failure_mode", ""),
            "detail": r.get("detail", ""),
            "convert_tier": tier,
            "stats": r.get("score"),
        })

    rows.sort(key=lambda x: (x["convert_tier"], -(x["stats"] or 0), x["name"]))
    out = {
        "generated": now,
        "queue": stats,
        "candidates": rows[: args.limit],
        "remaining": len(rows),
    }
    if args.next:
        print(json.dumps(rows[0] if rows else {}, indent=1))
    else:
        print(json.dumps(out, indent=1))
    return 0 if rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
