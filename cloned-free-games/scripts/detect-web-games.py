#!/usr/bin/env python3
"""Find clones that already contain a *runnable static web build*.

A clone only counts if its HTML entry point can be opened with file:// and played
with no build step and no network: every referenced local asset must exist on disk
and no .wasm/.data binary may be missing. Flutter (flutter_bootstrap.js), Godot HTML5
exports with no .wasm, and emscripten packaging stubs all fail that test, which is
what keeps the "playable now" badge honest.

Writes .queue/web-playable.json — {generated, roots, count, items:[...]}.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_ROOTS = [
    REPO / "games",
    REPO / ".build" / "out",          # auto-build.py's validated output, one dir per slug
    Path("/mnt/models/cloned-free-games/games"),
    Path("/home/cluer/crg/repo/games"),
    Path("/home/cluer/freegames/work"),
    Path("/home/cluer/projects/cloned-free-games/repos"),
]

# Entry points that are documentation or packaging scaffolding, never the game.
SKIP_PARTS = {
    "docs", "doc", "documentation", "test", "tests", "spec", "specs", "examples",
    "emscripten", "packaging", "build-data", "node_modules", "vendor", "third_party",
    "legal", "changelog", "error", "util", "master", "piggyback",
}
MAX_BYTES = 160 * 1024 * 1024  # a playable web build bigger than this is not worth shipping

REF = re.compile(r"""(?:src|href)\s*=\s*["']([^"'#?]+)["']""", re.I)


def local_refs(html: str) -> list[str]:
    out = []
    for m in REF.finditer(html):
        u = m.group(1).strip()
        if not u or u.startswith(("http:", "https:", "//", "data:", "javascript:", "mailto:", "#")):
            continue
        out.append(u)
    return out


def dir_size(path: Path, cap: int = MAX_BYTES) -> int:
    total = 0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d != ".git"]
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                pass
            if total > cap:
                return total
    return total


def assess(entry: Path) -> tuple[bool, str, dict]:
    """Return (ok, reason, facts) for one candidate entry point."""
    base = entry.parent
    try:
        html = entry.read_text(errors="replace")
    except OSError as e:
        return False, f"unreadable: {e}", {}

    if len(html) < 400:
        return False, "stub/redirect page", {}
    if "flutter_bootstrap.js" in html or "flutter.js" in html:
        return False, "flutter shell (needs `flutter build web`)", {}
    if re.search(r"godot|engine\.wasm", html, re.I) and not list(base.rglob("*.wasm")):
        return False, "godot/emscripten export with no wasm payload", {}
    if "Assets/" in html and "UnityLoader" in html:
        return False, "unity export", {}

    refs = local_refs(html)
    missing, present = [], 0
    for u in refs:
        target = (base / u.lstrip("./")).resolve()
        try:
            if target.is_file():
                present += 1
            elif target.is_dir():
                pass  # directory href (e.g. "/") — ignore
            else:
                missing.append(u)
        except OSError:
            missing.append(u)
    # A page that points at .js/.css/.png that isn't there renders a blank screen.
    hard_missing = [m for m in missing if m.lower().endswith((".js", ".css", ".wasm", ".data", ".png", ".json", ".svg", ".mp3", ".ogg", ".wav"))]
    if hard_missing:
        return False, f"missing {len(hard_missing)} asset(s): {', '.join(hard_missing[:3])}", {}
    has_js = any(u.lower().endswith(".js") for u in refs) or "<script" in html.lower()
    has_canvas = "<canvas" in html.lower()
    if not has_js:
        return False, "no scripts (static article, not a game)", {}
    if not (has_js and present):
        return False, "no local assets next to the page", {}

    size = dir_size(base)
    if size > MAX_BYTES:
        return False, f"{size // 1024 // 1024} MB — too heavy to mirror", {}
    return True, "", {
        "entry": str(entry),
        "rel_entry": str(entry.relative_to(base.parent)) if entry.parent != base else entry.name,
        "base": str(base),
        "bytes": size,
        "canvas": has_canvas,
        "scripts": sum(1 for u in refs if u.lower().endswith(".js")),
        "wasm": bool(list(base.glob("*.wasm"))),
    }


def candidates(game_dir: Path):
    seen = set()
    for entry in sorted(game_dir.rglob("index.html")):
        rel = entry.relative_to(game_dir)
        if len(rel.parts) > 4:
            continue
        parts = {p.lower() for p in rel.parts[:-1]}
        if parts & SKIP_PARTS:
            continue
        # Skip anything inside a nested checkout of another project.
        if any(p in ("node_modules", ".git") for p in rel.parts):
            continue
        key = entry.parent
        if key in seen:
            continue
        seen.add(key)
        yield entry


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--roots", nargs="*", default=None)
    ap.add_argument("--out", default=str(REPO / ".queue" / "web-playable.json"))
    ap.add_argument("--min-bytes", type=int, default=20_000)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    roots = [Path(p) for p in args.roots] if args.roots else DEFAULT_ROOTS
    items: list[dict] = []
    rejected: list[dict] = []

    for root in roots:
        if not root.is_dir():
            continue
        for game_dir in sorted(root.iterdir()):
            if not game_dir.is_dir() or game_dir.name.startswith("."):
                continue
            best = None
            for entry in candidates(game_dir):
                ok, why, facts = assess(entry)
                if not ok:
                    if args.verbose:
                        rejected.append({"game": game_dir.name, "entry": str(entry.relative_to(game_dir)), "why": why})
                    continue
                if facts["bytes"] < args.min_bytes:
                    continue
                cand = {"name": game_dir.name, "slug": game_dir.name, **facts, "root": str(root)}
                # Prefer the shallowest entry point, then the one with a canvas.
                rank = (len(facts["rel_entry"].split("/")), 0 if facts["canvas"] else 1, -facts["bytes"])
                if best is None or rank < best[0]:
                    best = (rank, cand)
            if best:
                items.append(best[1])

    items.sort(key=lambda i: (0 if i["canvas"] else 1, -i["bytes"], i["name"].lower()))
    payload = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "roots": [str(r) for r in roots],
        "count": len(items),
        "items": items,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=1))
    tmp.replace(out)
    print(f"WEB-PLAYABLE {len(items)} candidates -> {out}")
    for i in items:
        print(f"  {i['name'][:38].ljust(38)} {i['bytes']//1024:>6} KB  {i['rel_entry']}")
    if rejected and args.verbose:
        print(f"REJECTED {len(rejected)} entry points")
    return 0


if __name__ == "__main__":
    sys.exit(main())
