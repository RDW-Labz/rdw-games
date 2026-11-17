#!/usr/bin/env python3
"""tools/art-audit.py — which titles actually draw the vendored donors?

The collection's claim is "real upstream art and numbers". That claim is only true per
title, and only if the title's JS names a path that exists in the vendor payload — a
catalog tagline saying "Endless Sky hulls" proves nothing. This tool answers, per game:

  * every `vendor/<source>/...` path its JS references, grouped by donor
  * how many of those paths are real files AND declared in vendor/MANIFEST.json
  * a verdict: `draws` (aliases real donor bytes) or `MISSING` (procedural only)

Usage:
    python3 tools/art-audit.py            # table
    python3 tools/art-audit.py --check    # exit 1 when any title draws nothing
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
GAMES = ROOT / "games"

PATH_RE = re.compile(r"vendor/[A-Za-z0-9_.-]+/[A-Za-z0-9_./{}-]*[A-Za-z0-9_}*]")


def js_files(game: Path) -> list[Path]:
    return sorted((game / "js").glob("*.js"))


def referenced(game: Path) -> dict[str, set[str]]:
    """donor -> set of literal vendor paths named in this game's JS."""
    out: dict[str, set[str]] = {}
    for f in js_files(game):
        text = f.read_text(encoding="utf-8", errors="replace")
        for m in PATH_RE.finditer(text):
            p = m.group(0).rstrip(".,;:)'\"")
            if "{" in p:          # a glob/prefix expression, not a literal path
                p = p.split("{")[0]
            parts = p.split("/")
            donor = parts[1]
            out.setdefault(donor, set()).add(p)
    return out


def main() -> int:
    manifest = json.loads((VENDOR / "MANIFEST.json").read_text(encoding="utf-8"))
    declared = {e["path"] for e in manifest["files"]}          # relative to vendor/
    on_disk = {str(p.relative_to(VENDOR)) for p in VENDOR.rglob("*") if p.is_file()}
    dirs = {str(p.relative_to(VENDOR)) for p in VENDOR.rglob("*") if p.is_dir()}
    existing = on_disk | dirs          # a donor base dir ("vendor/suroi/guns") counts too

    check = "--check" in sys.argv
    starved: list[str] = []
    rows: list[tuple[str, int, int, str, str]] = []

    for game in sorted(p for p in GAMES.iterdir() if p.is_dir()):
        refs = referenced(game)
        literal = {p for paths in refs.values() for p in paths}
        if not literal:
            starved.append(game.name)
            rows.append((game.name, 0, 0, "-", "MISSING"))
            continue
        rel = {p[len("vendor/"):] for p in literal}
        declared_hits = len(rel & declared)
        disk_hits = len(rel & existing)
        donors = ",".join(sorted(refs))
        verdict = "draws" if disk_hits else "MISSING (paths do not exist)"
        if not disk_hits:
            starved.append(game.name)
        rows.append((game.name, len(literal), min(declared_hits, disk_hits), donors, verdict))

    print(f"{'title':14}{'paths':>6}{'valid':>7}  {'donors':32}verdict")
    for name, total, valid, donors, verdict in rows:
        print(f"{name:14}{total:6d}{valid:7d}  {donors:32}{verdict}")

    draws = [r for r in rows if r[4] == "draws"]
    print(f"\n{len(draws)}/{len(rows)} titles name at least one real vendored path.")
    if starved:
        print("draw nothing:", ", ".join(starved))
    if check and starved:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
