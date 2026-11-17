#!/usr/bin/env python3
"""tools/flare-frames.py — extract real animated frames from the Flare atlases.

Why this exists
---------------
Flare ships each creature as a *large* animation atlas. A goblin is a 1316x3185
PNG holding every frame of every animation at 128x128, with the feet anchor at
(64, 96) inside each cell. The first vendoring pass downscaled those atlases to
~100x256 so twelve engines' worth of art would fit in a byte budget, and at that
ratio a 128px frame lands on roughly eight pixels — which is why the shipped
creatures read as coloured mush instead of the painted art the GPL donor gave us.

This tool goes back to the pinned commit, reads each creature's animation
definition (``art_src/animation_defs/characters/<name>.txt``), and writes the
*individual frames* at their native 128x128. A frame is ~8 KB; a whole bestiary
of animated creatures is smaller than a single downscaled atlas, and the art is
usable at phone scale.

Output
------
    vendor/flare-game/frames/<creature>/<anim>-<n>.png
    vendor/flare-game/frames/index.json      # cells, anchor, fps, frame lists

Every written file is recorded in vendor/MANIFEST.json with its commit, licence
and sha256 so ``python3 tools/ports-provenance.py --check`` stays green.

Usage
-----
    python3 tools/flare-frames.py --list
    python3 tools/flare-frames.py goblin skeleton antlion
    python3 tools/flare-frames.py --all --force
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request

REPO = "flareteam/flare-game"
COMMIT = "af6eee6d339ac98011864bfe89da837fe7769c28"
LICENSE = "GPL-3.0 AND CC-BY-SA-3.0"
RAW = f"https://raw.githubusercontent.com/{REPO}/{COMMIT}/"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTDIR = os.path.join(ROOT, "vendor", "flare-game", "frames")
INDEX = os.path.join(OUTDIR, "index.json")
MANIFEST = os.path.join(ROOT, "vendor", "MANIFEST.json")

# creature → (image path, animation-definition path). Atlases live in
# images/enemies/<name>.png; multi-file creatures (minotaur, wyvern) ship one
# strip per animation under images/enemies/<name>/ and share a def file.
CREATURES = {
    "goblin": ("mods/fantasycore/images/enemies/goblin.png",
               "art_src/animation_defs/characters/goblin.txt"),
    "goblin_elite": ("mods/fantasycore/images/enemies/goblin_elite.png",
                     "art_src/animation_defs/characters/goblin.txt"),
    "skeleton": ("mods/fantasycore/images/enemies/skeleton.png",
                 "art_src/animation_defs/characters/skeleton.txt"),
    "skeleton_mage": ("mods/fantasycore/images/enemies/skeleton_mage.png",
                      "art_src/animation_defs/characters/skeleton.txt"),
    "antlion": ("mods/fantasycore/images/enemies/antlion.png",
                "art_src/animation_defs/characters/antlion.txt"),
    "antlion_small": ("mods/fantasycore/images/enemies/antlion_small.png",
                      "art_src/animation_defs/characters/antlion_small.txt"),
    "wyvern": ("mods/fantasycore/images/enemies/wyvern/",
               "art_src/animation_defs/characters/wyvern.txt"),
    "minotaur": ("mods/fantasycore/images/enemies/minotaur/",
                 "art_src/animation_defs/characters/minotaur.txt"),
    "zombie": ("mods/fantasycore/images/enemies/zombie.png",
               "art_src/animation_defs/characters/zombie.txt"),
    "cursed_grave": ("mods/fantasycore/images/enemies/cursed_grave.png",
                     "art_src/animation_defs/characters/cursed_grave.txt"),
}


def fetch(path: str) -> bytes:
    url = RAW + path
    req = urllib.request.Request(url, headers={"User-Agent": "aomg-flare-frames"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def parse_def(text: str) -> dict:
    """Read a Flare animation definition into cells + per-animation frame specs."""
    cell = (128, 128)
    anchor = (64, 96)
    anims: dict[str, dict] = {}
    cur = None
    for line in text.splitlines():
        line = line.split("#")[0].strip()
        if not line:
            continue
        if line.startswith("render_size="):
            w, h = line.split("=", 1)[1].split(",")
            cell = (int(w), int(h))
        elif line.startswith("render_offset="):
            x, y = line.split("=", 1)[1].split(",")
            anchor = (int(x), int(y))
        elif line.startswith("[") and line.endswith("]"):
            cur = line[1:-1].strip()
            anims[cur] = {"frames": 0, "position": 0, "ms": 500, "type": "looped"}
        elif cur and "=" in line:
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            a = anims[cur]
            if k == "frames":
                a["frames"] = int(v)
            elif k == "position":
                a["position"] = int(v)
            elif k == "duration":
                m = re.match(r"(\d+)", v)
                if m:
                    a["ms"] = int(m.group(1))
            elif k == "type":
                a["type"] = v
    return {"cell": list(cell), "anchor": list(anchor), "anims": anims}


def extract(name: str, force: bool = False) -> dict:
    from PIL import Image  # imported late so --list works without Pillow

    img_path, def_path = CREATURES[name]
    meta = parse_def(fetch(def_path).decode("utf-8", "replace"))
    cw, ch = meta["cell"]
    written: list[str] = []
    index = {"creature": name, "cell": meta["cell"], "anchor": meta["anchor"],
             "source": {"repo": REPO, "commit": COMMIT, "license": LICENSE,
                        "image": img_path, "def": def_path},
             "anims": {}}

    if img_path.endswith(".png"):
        atlas = Image.open(io.BytesIO(fetch(img_path))).convert("RGBA")
        cols = atlas.width // cw
        for anim, spec in meta["anims"].items():
            files = []
            for i in range(spec["frames"]):
                pos = spec["position"] + i
                x = (pos % cols) * cw
                y = (pos // cols) * ch
                if y + ch > atlas.height:
                    break
                frame = atlas.crop((x, y, x + cw, y + ch))
                files.append(None)  # filled with the relative path below
                rel = f"vendor/flare-game/frames/{name}/{anim}-{i}.png"
                dst = os.path.join(ROOT, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if force or not os.path.exists(dst):
                    frame.save(dst, optimize=True)
                files[-1] = rel
                written.append(rel)
            if files:
                index["anims"][anim] = {"files": files,
                                        "fps": round(1000 / max(1, spec["ms"] / max(1, len(files))), 2),
                                        "loop": spec["type"] != "play_once"}
    else:
        for anim, spec in meta["anims"].items():
            strip_path = f"{img_path}{name}_{anim}.png"
            try:
                strip = Image.open(io.BytesIO(fetch(strip_path))).convert("RGBA")
            except urllib.error.HTTPError:
                continue
            n = strip.width // cw
            files = []
            for i in range(n):
                frame = strip.crop((i * cw, 0, (i + 1) * cw, ch))
                rel = f"vendor/flare-game/frames/{name}/{anim}-{i}.png"
                dst = os.path.join(ROOT, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if force or not os.path.exists(dst):
                    frame.save(dst, optimize=True)
                files.append(rel)
                written.append(rel)
            index["anims"][anim] = {"files": files,
                                    "fps": round(1000 / max(1, spec["ms"] / max(1, n)), 2),
                                    "loop": spec["type"] != "play_once"}

    os.makedirs(os.path.dirname(INDEX), exist_ok=True)
    merged = {}
    if os.path.exists(INDEX):
        with open(INDEX, encoding="utf-8") as fh:
            merged = json.load(fh)
    merged[name] = index
    with open(INDEX, "w", encoding="utf-8") as fh:
        json.dump(merged, fh, indent=1, sort_keys=True)
    write_index_js(merged)
    return {"name": name, "files": written, "meta": index}


def write_index_js(merged: dict) -> None:
    """A classic-script mirror of index.json.

    The games load with plain <script> tags and must run from file://, where
    fetch() is blocked, so the frame index ships as `var FLARE_FRAMES = {...}`.
    """
    body = json.dumps(merged, sort_keys=True, separators=(",", ":"))
    js = ("/* generated by tools/flare-frames.py — do not edit */\n"
          "window.FLARE_FRAMES = " + body + ";\n")
    with open(os.path.join(OUTDIR, "index.js"), "w", encoding="utf-8") as fh:
        fh.write(js)


def update_manifest(records: list[dict]) -> None:
    with open(MANIFEST, encoding="utf-8") as fh:
        man = json.load(fh)
    # MANIFEST paths are relative to vendor/ (see tests/vendor.mjs); drop any
    # entry this tool previously wrote with the wrong prefix
    files = [e for e in man["files"] if not e["path"].startswith("vendor/")]
    by_path = {e["path"]: e for e in files}
    added = updated = 0
    for rec in records:
        meta = rec["meta"]["source"]
        for rel in rec["files"] + ["vendor/flare-game/frames/index.json",
                                   "vendor/flare-game/frames/index.js"]:
            abs_path = os.path.join(ROOT, rel)
            if not os.path.exists(abs_path):
                continue
            data = open(abs_path, "rb").read()
            entry = {
                "path": rel[len("vendor/"):] if rel.startswith("vendor/") else rel,
                "source_path": meta["image"] if meta["image"].endswith("/") else meta["image"],
                "source_repo": "flare-game",
                "commit": COMMIT,
                "license": LICENSE,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "note": f"Flare animation frame, native {rec['meta']['cell'][0]}px cell "
                        f"(extracted by tools/flare-frames.py)",
            }
            if rel.endswith("index.json") or rel.endswith("index.js"):
                entry["source_path"] = "art_src/animation_defs/characters/*.txt"
                entry["note"] = ("Generated frame index for vendor/flare-game/frames "
                                 "(paths, cell size, feet anchor, fps)")
            key = entry["path"]
            if key in by_path:
                by_path[key].update(entry)
                updated += 1
            else:
                files.append(entry)
                by_path[key] = entry
                added += 1
    files.sort(key=lambda e: e["path"])
    man["files"] = files
    man["sources"].setdefault("flare-game", {})
    man["sources"]["flare-game"]["frames"] = {
        "commit": COMMIT, "license": LICENSE,
        "note": "per-frame extraction of the native atlases (tools/flare-frames.py)",
    }
    with open(MANIFEST, "w", encoding="utf-8") as fh:
        json.dump(man, fh, indent=1, sort_keys=True)
    print(f"MANIFEST.json: +{added} new, {updated} updated")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    if a.list:
        for k, (i, d) in CREATURES.items():
            print(f"{k:16s} {i}")
        return 0
    names = list(CREATURES) if a.all else a.names
    if not names:
        ap.error("name at least one creature, or pass --all")
    records = []
    for n in names:
        if n not in CREATURES:
            print(f"unknown creature {n}", file=sys.stderr)
            return 2
        rec = extract(n, force=a.force)
        counts = ", ".join(f"{k}:{len(v['files'])}" for k, v in rec["meta"]["anims"].items())
        print(f"{n:16s} {len(rec['files']):3d} frames  ({counts})")
        records.append(rec)
    update_manifest(records)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
