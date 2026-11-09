#!/usr/bin/env python3
"""Decide, per cloned game, how it can become something you play in the browser.

The arcade is three.js, so the question for every clone is: what would it take to hand
someone a URL? This script answers that with evidence from the tree alone (no network,
no build) and writes `.queue/port-plan.json`.

Lanes, in order of what ships soonest:

  web-ready     A static build already runs from the repo as-is (index.html, all assets
                local, no build step). detect-web-games.py proved it; promote-web-games.py
                mirrors it to /play/<slug>/. Nothing to convert.
  web-buildable JS/TS sources with a package.json build script and no committed build.
                Convertible by running the project's own build once, offline, then mirroring
                the dist/ output. Needs a per-game check, so it is queued, not automatic.
  asset-donor   A real game whose code is native (C/C++, Java, Godot, Unity) but which has
                usable art/audio/sound. These are the sources our three.js ports are built
                from: lift the sprites, rebuild the rules on kit.js.
  native-only   Native game with no reusable assets — an emulator/install story, not a port.
  not-a-game    Docs, servers, libraries, tooling.

Usage: scripts/port-plan.py [--src .] [--json path] [--limit N]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

SKIP_PARTS = {
    ".git", "node_modules", "__pycache__", ".github", ".vscode", ".idea", "vendor",
    "third_party", "third-party", "doc", "docs", "documentation", "test", "tests",
    "spec", "specs", "examples", "samples",
}
CODE_EXT = {
    ".js": "js", ".mjs": "js", ".jsx": "js", ".ts": "ts", ".tsx": "ts",
    ".c": "c", ".h": "c", ".cc": "c", ".cpp": "c", ".hpp": "c",
    ".cs": "cs", ".java": "java", ".kt": "kotlin", ".gd": "gdscript",
    ".py": "python", ".rs": "rust", ".go": "go", ".lua": "lua",
}
ASSET_EXT = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image",
    ".svg": "image", ".bmp": "image",
    ".wav": "audio", ".ogg": "audio", ".mp3": "audio", ".flac": "audio",
    ".glb": "model", ".gltf": "model", ".obj": "model", ".fbx": "model",
    ".ttf": "font", ".otf": "font", ".woff": "font", ".woff2": "font",
}
WEB_ENGINE_DEPS = ("three", "pixi.js", "phaser", "excalibur", "babylonjs", "@babylonjs/core",
                   "melonjs", "kaboom", "kontra", "p5", "playcanvas")
MAX_FILES = 40_000


def scan(root: Path) -> dict:
    """Walk once, count what actually exists. Bounded so a huge clone can't stall a cron run."""
    counts: Counter = Counter()
    files = 0
    has = {k: False for k in (
        "package_json", "build_script", "index_html", "wasm", "flutter", "godot",
        "unity", "readme")}
    build_script = ""
    deps: list[str] = []

    pkg = root / "package.json"
    if pkg.is_file():
        has["package_json"] = True
        try:
            data = json.loads(pkg.read_text(encoding="utf-8", errors="replace"))
            scripts = data.get("scripts") or {}
            for name in ("build", "dist", "prod", "production", "bundle"):
                if name in scripts:
                    build_script = name
                    break
            has["build_script"] = bool(build_script)
            alldeps = {}
            for key in ("dependencies", "devDependencies", "peerDependencies"):
                alldeps.update(data.get(key) or {})
            deps = sorted(k for k in alldeps if k in WEB_ENGINE_DEPS)
        except (OSError, ValueError):
            pass

    for path in root.rglob("*"):
        if files >= MAX_FILES:
            break
        try:
            rel = path.relative_to(root)
        except ValueError:
            continue
        if any(part in SKIP_PARTS for part in rel.parts[:-1]):
            continue
        if path.is_dir():
            if path.name.lower() in ("build", "dist", "out") and (path / "index.html").is_file():
                has["index_html"] = True
            continue
        files += 1
        name = path.name.lower()
        if name == "index.html":
            has["index_html"] = True
        if name == "flutter_bootstrap.js":
            has["flutter"] = True
        if name == "project.godot":
            has["godot"] = True
        if name.endswith(".uproject") or name == "unityengine.dll":
            has["unity"] = True
        if name.startswith("readme"):
            has["readme"] = True
        suffix = path.suffix.lower()
        try:
            counts["total_bytes"] += path.stat().st_size
        except OSError:
            pass
        if suffix in CODE_EXT:
            counts[CODE_EXT[suffix]] += 1
        elif suffix in ASSET_EXT:
            counts[ASSET_EXT[suffix]] += 1
            try:
                counts["asset_bytes"] += path.stat().st_size
            except OSError:
                pass
        elif suffix in (".wasm", ".wat"):
            counts["wasm"] += 1
            has["wasm"] = True
        elif suffix in (".html", ".htm"):
            counts["html"] += 1
    counts["files"] = files
    return {"counts": dict(counts), "has": has, "build_script": build_script, "engine_deps": deps}


def lane_for(info: dict, web_ready: bool) -> tuple[str, str]:
    """Return (lane, why). The order matters: cheapest path to a URL wins."""
    c, h = info["counts"], info["has"]
    if web_ready:
        return "web-ready", "static build runs as-is — mirrored to /play/<slug>/"
    if h["flutter"]:
        return "native-only", "Flutter build — needs the toolchain, cannot ship as static files"
    if h["godot"] and not h["wasm"]:
        return "native-only", "Godot project with no HTML5 export — needs an export build"
    if h["unity"]:
        return "native-only", "Unity project — needs the editor to build a web target"
    jsish = c.get("js", 0) + c.get("ts", 0)
    nativeish = c.get("c", 0) + c.get("java", 0) + c.get("cs", 0) + c.get("gdscript", 0) + c.get("rust", 0) + c.get("lua", 0) + c.get("go", 0)
    if h["package_json"] and h["build_script"] and jsish >= 20:
        engines = ", ".join(info["engine_deps"]) or "vanilla js"
        return "web-buildable", f"`npm run {info['build_script']}` then mirror dist/ ({engines})"
    if h["index_html"] and jsish >= 5 and nativeish == 0 and not h["wasm"]:
        return "web-buildable", "has index.html + JS but the asset check failed — inspect by hand"
    if c.get("image", 0) + c.get("audio", 0) + c.get("model", 0) >= 20 and nativeish >= 20:
        art = f"{c.get('image',0)} img / {c.get('audio',0)} snd / {c.get('model',0)} 3d"
        return "asset-donor", f"native code, reusable art ({art}) — rebuild the rules on kit.js"
    if nativeish >= 50 and c.get("image", 0) < 10:
        return "native-only", "native game, little reusable art — install/emulator story, not a port"
    if jsish >= 10:
        return "web-buildable", "JS/JS source but no build manifest — wrap the entry by hand"
    return "not-a-game", "no game code or art found"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(Path(__file__).resolve().parent.parent))
    ap.add_argument("--json", default="")
    ap.add_argument("--limit", type=int, default=0, help="only scan the N newest clones")
    ap.add_argument("--budget-mb", type=int, default=12,
                    help="per-port vendoring budget: a port copies at most this much art")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    budget = args.budget_mb

    src = Path(args.src).resolve()
    games = src / "games"
    detected = src / ".queue" / "web-playable.json"
    ready: set[str] = set()
    if detected.is_file():
        try:
            ready = {i["slug"] for i in json.loads(detected.read_text()).get("items", [])}
        except (OSError, ValueError, KeyError) as e:
            print(f"! detector output unreadable: {e}", file=sys.stderr)

    dirs = [d for d in sorted(games.iterdir()) if d.is_dir() and not d.name.startswith("_")] if games.is_dir() else []
    if args.limit:
        dirs = sorted(dirs, key=lambda p: p.stat().st_mtime, reverse=True)[: args.limit]

    items = []
    for d in dirs:
        info = scan(d)
        lane, why = lane_for(info, d.name in ready)
        items.append({
            "slug": d.name,
            "lane": lane,
            "why": why,
            "files": info["counts"].get("files", 0),
            "code": {k: v for k, v in info["counts"].items() if k in CODE_EXT.values()},
            "assets": {k: info["counts"].get(k, 0) for k in ("image", "audio", "model")},
            "asset_mb": round(info["counts"].get("asset_bytes", 0) / (1024 * 1024), 1),
            "total_mb": round(info["counts"].get("total_bytes", 0) / (1024 * 1024), 1),
            "engine_deps": info["engine_deps"],
            "build_script": info["build_script"],
        })

    by_lane: Counter = Counter(i["lane"] for i in items)
    lane_mb: Counter = Counter()
    for i in items:
        lane_mb[i["lane"]] += i["total_mb"]

    # Disk accounting: clones are the permanent source of truth and are never pruned, so the
    # only number that can drift is what a port *vendors* into the shipped tree. Flag the
    # clones whose art is bigger than a port should copy, and report what is actually published.
    def dir_mb(path: Path) -> float:
        total = 0
        if not path.is_dir():
            return 0.0
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if d != ".git"]
            for f in files:
                try:
                    total += (Path(root) / f).stat().st_size
                except OSError:
                    pass
        return round(total / (1024 * 1024), 1)

    over = sorted(
        ({"slug": i["slug"], "asset_mb": i["asset_mb"], "lane": i["lane"]}
         for i in items if i["asset_mb"] > budget),
        key=lambda d: -d["asset_mb"],
    )
    free_gb = round(shutil.disk_usage(src).free / (1024 ** 3), 1)
    # Every number below is measured, not estimated. `scanned_mb` counts the files the lane
    # classifier actually reads (code + assets, node_modules/vendor/docs excluded), so the
    # real on-disk cost of games/ is reported separately by `du`.
    tries = subprocess.run(["du", "-sm", str(src / "games")], capture_output=True, text=True)
    du_mb = float(tries.stdout.split()[0]) if tries.returncode == 0 and tries.stdout.split() else 0.0
    disk = {
        "games_dir_mb": du_mb,
        "scanned_mb": round(sum(i["total_mb"] for i in items), 1),
        "asset_mb": round(sum(i["asset_mb"] for i in items), 1),
        "by_lane_mb": {k: round(v, 1) for k, v in lane_mb.most_common()},
        "published_mb": {"play": dir_mb(src / ".site-play"),
                         "thumbs": dir_mb(src / ".site-out" / "thumbs")},
        "built_mb": dir_mb(src / ".build"),
        "free_gb": free_gb,
        "budget_mb": budget,
        "over_budget": over[:25],
        "over_budget_count": len(over),
    }

    payload = {
        "games_scanned": len(items),
        "by_lane": dict(by_lane),
        "disk": disk,
        "next": [i["slug"] for i in items if i["lane"] in ("web-buildable", "asset-donor")][:20],
        "items": items,
    }
    out = Path(args.json) if args.json else src / ".queue" / "port-plan.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=1))
    tmp.replace(out)

    if not args.quiet:
        for lane, n in by_lane.most_common():
            print(f"  {lane:14s} {n:4d}  {disk['by_lane_mb'].get(lane, 0):>9.1f} MB")
        print(f"  games/ {disk['games_dir_mb'] / 1024:.1f} GB on disk "
              f"(scanned {disk['scanned_mb'] / 1024:.1f} GB, assets {disk['asset_mb'] / 1024:.1f} GB)"
              f" | published {disk['published_mb']['play']:.1f} MB play + "
              f"{disk['published_mb']['thumbs']:.1f} MB thumbs | {free_gb:.0f} GB free")
        print(f"  {len(over)} clone(s) hold more than the {budget} MB per-port vendoring budget")
        print(f"PLAN {len(items)} clones -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
