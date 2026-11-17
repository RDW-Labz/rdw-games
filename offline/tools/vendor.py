#!/usr/bin/env python3
"""Import real content out of the cloned game repos into this collection.

This is the honest version of "use the clone": it copies actual sprites, audio and
game data out of pinned upstream checkouts, converts them to something a browser can
load, and records for every single output file where it came from — source path,
upstream commit, licence, byte size and SHA-256.

    python3 tools/vendor.py sync     # rebuild vendor/ from the clones
    python3 tools/vendor.py --check  # verify vendor/ still matches the manifest

`--check` runs in `npm test`, so a vendored file can never drift, get hand-edited or
go missing without the suite going red.

Every source is optional: if a clone is not on this machine, that source is skipped
and the games fall back to their authored content. Nothing here reaches the network.

Licences (read from the upstream trees, not assumed):
    endless-sky                GPL-3.0    ships, commodity data, ship sprites
    shattered-pixel-dungeon    GPL-3.0    monster/item sprites, sfx, music
    unciv                      MPL-2.0    tech / building / unit tables
    cataclysm-dda              CC-BY-SA 3.0   item, monster and recipe tables
    stk-assets                 GPL-2.0+ / CC-BY-SA   music and sfx (see licenses.txt)
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "vendor")
MANIFEST = os.path.join(VENDOR, "MANIFEST.json")

HOME = os.path.expanduser("~")
CLONES = os.path.join(HOME, "cloned-free-games", "games")
CRG = os.path.join(HOME, "crg", "games")

SOURCES = {
    "endless-sky": {
        "path": os.path.join(CRG, "endless-sky"),
        "license": "GPL-3.0",
        "url": "https://github.com/endless-sky/endless-sky",
        "license_file": "license.txt",
        "credit": "Endless Sky contributors (ships, commodity data, ship sprites)",
    },
    "shattered-pixel-dungeon": {
        "path": os.path.join(CLONES, "shattered-pixel-dungeon"),
        "license": "GPL-3.0",
        "url": "https://github.com/00-Evan/shattered-pixel-dungeon",
        "license_file": "LICENSE.txt",
        "credit": "Shattered Pixel Dungeon / Evan Debenham and Pixel Dungeon contributors",
    },
    "unciv": {
        "path": os.path.join(CLONES, "Unciv"),
        "license": "MPL-2.0",
        "url": "https://github.com/yairm210/Unciv",
        "license_file": "LICENSE",
        "credit": "Unciv contributors (tech, building and unit tables, Civ V rule set)",
    },
    "cataclysm-dda": {
        "path": os.path.join(CLONES, "Cataclysm-DDA"),
        "license": "CC-BY-SA-3.0",
        "url": "https://github.com/CleverRaven/Cataclysm-DDA",
        "license_file": "LICENSE.txt",
        "credit": "Cataclysm: Dark Days Ahead contributors (item, monster and recipe data)",
    },
    "three": {
        "path": os.path.join(CRG, "three"),
        "license": "MIT",
        "url": "https://www.npmjs.com/package/three",
        "license_file": "LICENSE",
        "credit": "three.js / mrdoob and contributors (WebGL renderer used by Stormforge)",
    },
    "mindustry": {
        "path": os.path.join(CLONES, "Mindustry"),
        "license": "GPL-3.0",
        "url": "https://github.com/Anuken/Mindustry",
        "license_file": "LICENSE",
        "credit": "Mindustry / Anuken and contributors (item icons, conveyor, drill and turret sprites)",
    },
    "luanti": {
        "path": os.path.join(CLONES, "luanti"),
        "license": "LGPL-2.1-or-later AND CC-BY-SA-3.0",
        "url": "https://github.com/luanti-org/luanti",
        "license_file": "LICENSE.txt",
        "credit": "Luanti contributors (node material textures from the devtest basenodes mod)",
    },
    "stk-assets": {
        "path": os.path.join(CLONES, "stk-assets"),
        "license": "GPL-2.0-or-later AND CC-BY-SA-3.0",
        "url": "https://github.com/supertuxkart/stk-assets",
        "license_file": "licenses.txt",
        "credit": "SuperTuxKart art and audio contributors",
    },
    "flare-game": {
        "path": os.path.join(CLONES, "flare-game"),
        "license": "GPL-3.0 AND CC-BY-SA-3.0",
        "url": "https://github.com/flareteam/flare-game",
        "license_file": "LICENSE.txt",
        "credit": "Flare game / Clint Bellanger and the Flare team (painted art, item records)",
    },
    "dcss": {
        "path": os.path.join(CLONES, "crawl"),
        "license": "CC0-1.0 AND GPL-2.0-or-later",
        "url": "https://github.com/crawl/crawl",
        "license_file": "LICENSE",
        "credit": "Dungeon Crawl Stone Soup contributors (vault geometry, 32 px tiles)",
    },
    "wesnoth": {
        "path": os.path.join(CLONES, "wesnoth"),
        "license": "GPL-2.0-or-later AND CC-BY-SA-4.0",
        "url": "https://github.com/wesnoth/wesnoth",
        "license_file": "COPYING",
        "credit": "Battle for Wesnoth contributors (unit rules, sprites, portraits, music)",
    },
    "suroi": {
        "path": os.path.join(CLONES, "suroi"),
        "license": "GPL-3.0",
        "url": "https://github.com/HasangerGames/suroi",
        "license_file": "LICENSE",
        "credit": "Suroi contributors / HasangerGames (weapon art, battle-royale ballistics and gear tables, sounds)",
    },
}

# ---------------------------------------------------------------- helpers


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def head_commit(repo: str) -> str:
    try:
        return subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"],
                              capture_output=True, text=True, timeout=20).stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def rel_repo_path(repo: str, path: str) -> str:
    return os.path.relpath(path, repo).replace(os.sep, "/")


class Collector:
    """Accumulates vendored files and their provenance."""

    def __init__(self, source: str, repo: str, commit: str, license_id: str):
        self.source, self.repo, self.commit, self.license = source, repo, commit, license_id
        self.files = []

    def copy(self, src: str, dst_rel: str, note: str = "") -> str:
        dst = os.path.join(VENDOR, dst_rel)
        # Two import rules can legitimately name the same upstream file (a ship sprite that is
        # both "every hull in the table" and "this class's art"). Copy it once so the manifest
        # does not double-count and the service worker's asset list has no duplicate entries.
        if any(f["path"] == dst_rel for f in self.files):
            return dst
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        self.files.append({
            "path": dst_rel,
            "source_path": rel_repo_path(self.repo, src),
            "source_repo": self.source,
            "commit": self.commit,
            "license": self.license,
            "bytes": os.path.getsize(dst),
            "sha256": sha256(dst),
            "note": note,
        })
        return dst

    def emit(self, src: str, dst_rel: str, note: str = "") -> str:
        """Register a file this tool wrote itself (converted art, re-encoded audio).

        The bytes are already on disk; only the provenance row is added, pointing back at
        the upstream file the conversion started from.
        """
        dst = os.path.join(VENDOR, dst_rel)
        if any(f["path"] == dst_rel for f in self.files):
            return dst
        self.files.append({
            "path": dst_rel,
            "source_path": rel_repo_path(self.repo, src),
            "source_repo": self.source,
            "commit": self.commit,
            "license": self.license,
            "bytes": os.path.getsize(dst),
            "sha256": sha256(dst),
            "note": note,
        })
        return dst

    def write_json(self, obj, dst_rel: str, note: str = "") -> str:
        dst = os.path.join(VENDOR, dst_rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=1, ensure_ascii=False, sort_keys=False)
            f.write("\n")
        self.files.append({
            "path": dst_rel,
            "source_path": "derived",
            "source_repo": self.source,
            "commit": self.commit,
            "license": self.license,
            "bytes": os.path.getsize(dst),
            "sha256": sha256(dst),
            "note": note or "derived table",
        })
        return dst


def tokens(line: str):
    """Split an Endless Sky data line into ['key', 'value', ...] honouring quotes."""
    return re.findall(r'"([^"]*)"|(\S+)', line) and [
        a if a else b for a, b in re.findall(r'"([^"]*)"|(\S+)', line)
    ]


def num(s, default=0.0):
    try:
        return float(str(s).replace(",", ""))
    except Exception:
        return default


def pilot_downscale(src: str, dst: str, max_px: int) -> None:
    from PIL import Image
    lanczos = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
    im = Image.open(src).convert("RGBA")
    if max(im.size) > max_px:
        im.thumbnail((max_px, max_px), lanczos)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im.save(dst, "PNG", optimize=True)


def audio_to_opus(src: str, dst: str, kbps: int = 48) -> bool:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
                        "-ac", "1", "-b:a", f"{kbps}k", "-c:a", "libopus", dst],
                       capture_output=True)
    return r.returncode == 0 and os.path.getsize(dst) > 0


def audio_trim(src: str, dst: str, seconds: int = 90, kbps: int = 48) -> bool:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-t", str(seconds),
                        "-ac", "1", "-b:a", f"{kbps}k", "-c:a", "libopus", dst], capture_output=True)
    return r.returncode == 0 and os.path.getsize(dst) > 0


def strip_json_comments(raw: str) -> str:
    """Remove // and /* */ comments without touching string literals."""
    out, i, n, instr = [], 0, len(raw), False
    while i < n:
        ch = raw[i]
        if instr:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(raw[i + 1])
                i += 2
                continue
            if ch == '"':
                instr = False
            i += 1
            continue
        if ch == '"':
            instr = True
            out.append(ch)
            i += 1
            continue
        if raw.startswith("//", i):
            j = raw.find("\n", i)
            i = n if j < 0 else j
            continue
        if raw.startswith("/*", i):
            j = raw.find("*/", i)
            i = n if j < 0 else j + 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def tolerant_json(path: str):
    """Unciv ships JSON with // and /* */ comments plus trailing commas."""
    raw = strip_json_comments(open(path, encoding="utf-8").read())
    raw = re.sub(r",(\s*[}\]])", r"\1", raw)
    return json.loads(raw)


# ---------------------------------------------------------------- endless sky

ES_KEYS = {
    "category": ("attributes", "category"),
    "cost": ("attributes", "cost"),
    "shields": ("attributes", "shields"),
    "hull": ("attributes", "hull"),
    "mass": ("attributes", "mass"),
    "drag": ("attributes", "drag"),
    "thrust": ("attributes", "thrust"),
    "turn": ("attributes", "turn"),
    "fuel": ("attributes", "fuel capacity"),
    "cargo": ("attributes", "cargo space"),
    "crew": ("attributes", "required crew"),
    "bunks": ("attributes", "bunks"),
    "engine_capacity": ("attributes", "engine capacity"),
}


def parse_es_ship_block(lines, start):
    """Return (ship dict, next index). Nested blocks are flattened by path."""
    flat, stack = {}, [(0, [])]
    i = start
    while i < len(lines):
        raw = lines[i]
        if raw and not raw[0].isspace():
            break
        i += 1
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        depth = len(raw.expandtabs(4)) - len(raw.expandtabs(4).lstrip(" "))
        tk = tokens(s)
        if not tk:
            continue
        while len(stack) > 1 and depth <= stack[-1][0]:
            stack.pop()
        path = stack[-1][1] + [tk[0]]
        if len(tk) > 1:
            flat[".".join(path)] = " ".join(tk[1:])
        else:
            stack.append((depth, path))
    return flat, i


def import_endless_sky(limit_ships=120, max_px=192):
    cfg = SOURCES["endless-sky"]
    repo = cfg["path"]
    if not os.path.isdir(repo):
        return None, "clone not found"
    c = Collector("endless-sky", repo, head_commit(repo), cfg["license"])

    data_files = []
    for dirpath, _, files in os.walk(os.path.join(repo, "data")):
        if "_deprecated" in dirpath:
            continue
        for f in files:
            if f.endswith(".txt"):
                data_files.append(os.path.join(dirpath, f))

    ships, seen = [], set()
    for path in sorted(data_files):
        try:
            lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
        except Exception:
            continue
        for idx, line in enumerate(lines):
            m = re.match(r'^ship "([^"]+)"', line)
            if not m:
                continue
            name = m.group(1)
            if name in seen:
                continue
            flat, _ = parse_es_ship_block(lines, idx + 1)
            sprite = flat.get("sprite", "")
            if not sprite.startswith("ship/"):
                continue
            png = os.path.join(repo, "images", sprite + ".png")
            if not os.path.exists(png):
                continue
            rec = {"name": name, "sprite": sprite}
            for key, pathk in ES_KEYS.items():
                v = flat.get(".".join(pathk))
                rec[key] = v if v is None else (num(v) if re.fullmatch(r"[-+]?[\d.]+", v or "") else v)
            rec["shield_damage"] = num(flat.get("attributes.weapon.shield damage", 0))
            rec["hull_damage"] = num(flat.get("attributes.weapon.hull damage", 0))
            rec["speed"] = num(flat.get("attributes.max velocity", 0))
            rec["source_file"] = rel_repo_path(repo, path)
            # playable/enemy hulls only: a real ship has a price and a crew
            if not isinstance(rec.get("cost"), (int, float)) or not rec["cost"]:
                continue
            if not rec.get("hull"):
                continue
            seen.add(name)
            ships.append(rec)

    # prefer the cheapest, most distinct hulls so the roster is playable and the bundle small
    by_cat = {}
    for s in ships:
        by_cat.setdefault(str(s.get("category", "Unknown")), []).append(s)
    picked = []
    for cat, group in sorted(by_cat.items()):
        group.sort(key=lambda s: (s.get("cost") or 1e12))
        picked.append(group[0])
        if len(group) > 1:
            picked.append(group[len(group) // 2])
    picked.sort(key=lambda s: (s.get("cost") or 0))
    for s in ships:
        if len(picked) >= limit_ships:
            break
        if all(s["name"] != p["name"] for p in picked):
            picked.append(s)
    picked = picked[:limit_ships]
    picked.sort(key=lambda s: (s.get("cost") or 0))

    sprite_dir = os.path.join(repo, "images")
    for s in picked:
        src = os.path.join(sprite_dir, s["sprite"] + ".png")
        out_rel = "endless-sky/ships/" + s["sprite"].split("/", 1)[1].replace(" ", "_") + ".png"
        dst = os.path.join(VENDOR, out_rel)
        # two hulls can name the same sprite file (Marauder variants sharing a base image);
        # copy it once, but still point this hull at it
        if any(f["path"] == out_rel for f in c.files):
            s["image"] = "vendor/" + out_rel
            continue
        pilot_downscale(src, dst, max_px)
        c.files.append({
            "path": out_rel,
            "source_path": rel_repo_path(repo, src),
            "source_repo": "endless-sky",
            "commit": c.commit,
            "license": c.license,
            "bytes": os.path.getsize(dst),
            "sha256": sha256(dst),
            "note": f"sprite for {s['name']}, downscaled to <= {max_px}px",
        })
        s["image"] = "vendor/" + out_rel

    # commodities: trade block, "commodity "Name" price capacity"
    commod = []
    cf = os.path.join(repo, "data", "commodities.txt")
    if os.path.exists(cf):
        for line in open(cf, encoding="utf-8", errors="replace"):
            m = re.match(r'\s*commodity "([^"]+)"\s+(\d+)\s+(\d+)', line)
            if m:
                commod.append({"name": m.group(1), "price": int(m.group(2)),
                               "capacity": int(m.group(3))})

    c.write_json(picked, "endless-sky/ships.json",
                 f"{len(picked)} ships parsed from {len(data_files)} upstream data files")
    c.write_json(commod, "endless-sky/commodities.json", f"{len(commod)} commodities")
    return c, None


# ---------------------------------------------------------------- shattered pixel dungeon

SPD_SOUNDS_ALWAYS = {"hit", "miss", "slam", "potion", "read", "eat", "throw", "descend",
                     "levelup", "boss", "grunt", "curse", "shield", "splash", "step"}
SPD_MUSIC = {"caves_1.ogg": "audio/vault.opus", "caves_tense.ogg": "audio/tense.opus"}


def import_spd():
    cfg = SOURCES["shattered-pixel-dungeon"]
    repo = cfg["path"]
    if not os.path.isdir(repo):
        return None, "clone not found"
    c = Collector("shattered-pixel-dungeon", repo, head_commit(repo), cfg["license"])
    assets = os.path.join(repo, "core", "src", "main", "assets")

    # sprites: every one the clone ships, they are tiny pixel art (16x16 to 32x32)
    sprite_meta = []
    sdir = os.path.join(assets, "sprites")
    if os.path.isdir(sdir):
        for fn in sorted(os.listdir(sdir)):
            if not fn.endswith(".png"):
                continue
            stem = os.path.splitext(fn)[0]
            rel = f"shattered-pixel-dungeon/sprites/{fn}"
            c.copy(os.path.join(sdir, fn), rel, f"sprite '{stem}'")
            sprite_meta.append({"name": stem, "image": "vendor/" + rel})

    # sounds: mp3 upstream, re-encoded to opus so the bundle stays small
    sfx_meta = []
    snd = os.path.join(assets, "sounds")
    if os.path.isdir(snd):
        for fn in sorted(os.listdir(snd)):
            stem = os.path.splitext(fn)[0]
            rel = f"shattered-pixel-dungeon/audio/{stem}.opus"
            dst = os.path.join(VENDOR, rel)
            if not audio_to_opus(os.path.join(snd, fn), dst, 40):
                continue
            c.files.append({
                "path": rel, "source_path": rel_repo_path(repo, os.path.join(snd, fn)),
                "source_repo": c.source, "commit": c.commit, "license": c.license,
                "bytes": os.path.getsize(dst), "sha256": sha256(dst),
                "note": "re-encoded mp3 -> opus 40k mono",
            })
            sfx_meta.append({"name": stem, "audio": "vendor/" + rel})

    music_meta = []
    mus = os.path.join(assets, "music")
    if os.path.isdir(mus):
        for fn, rel in SPD_MUSIC.items():
            src = os.path.join(mus, fn)
            if not os.path.exists(src):
                continue
            full = f"shattered-pixel-dungeon/{rel}"
            dst = os.path.join(VENDOR, full)
            if audio_trim(src, dst, 100, 48):
                c.files.append({
                    "path": full, "source_path": rel_repo_path(repo, src),
                    "source_repo": c.source, "commit": c.commit, "license": c.license,
                    "bytes": os.path.getsize(dst), "sha256": sha256(dst),
                    "note": "first 100s, opus 48k mono loop",
                })
                music_meta.append({"name": os.path.splitext(fn)[0], "audio": "vendor/" + full})

    # terrain atlases: 16x16 sheets of 16px dungeon tiles, one per region. Cell indices
    # come from SPD's own DungeonTileSheet.java (xy(x,y) = x-1 + 16*(y-1)):
    # FLOOR=0, FLOOR_ALT_1=6, FLOOR_ALT_2=12, FLAT_WALL=48, FLAT_WALL_ALT=52.
    terrain_meta = []
    tdir = os.path.join(assets, "environment")
    for fn, theme in (("tiles_sewers.png", "sewers"), ("tiles_prison.png", "prison"),
                      ("tiles_caves.png", "caves")):
        src = os.path.join(tdir, fn)
        if not os.path.exists(src):
            continue
        rel = f"shattered-pixel-dungeon/environment/{fn}"
        c.copy(src, rel, f"terrain atlas ({theme})")
        terrain_meta.append({"name": theme, "image": "vendor/" + rel})

    c.write_json({"sprites": sprite_meta, "sounds": sfx_meta, "music": music_meta,
                  "terrain": terrain_meta},
                 "shattered-pixel-dungeon/assets.json",
                 f"{len(sprite_meta)} sprites, {len(sfx_meta)} sfx, {len(music_meta)} tracks, "
                 f"{len(terrain_meta)} terrain atlases")
    return c, None


# ---------------------------------------------------------------- unciv

def import_unciv():
    cfg = SOURCES["unciv"]
    repo = cfg["path"]
    if not os.path.isdir(repo):
        return None, "clone not found"
    c = Collector("unciv", repo, head_commit(repo), cfg["license"])
    base = os.path.join(repo, "android", "assets", "jsons", "Civ V - Vanilla")
    if not os.path.isdir(base):
        return None, "rule set not found"

    def load(name, default=None):
        p = os.path.join(base, name)
        if not os.path.exists(p):
            return default if default is not None else []
        return tolerant_json(p)

    # Techs.json is the tech *tree*: 18 columns, each with an era, a techCost and its
    # technologies. Column position is the prerequisite chain, so it is kept.
    tech_out = []
    for col in load("Techs.json", []):
        if not isinstance(col, dict):
            continue
        for t in col.get("techs", []):
            tech_out.append({
                "name": t.get("name"),
                "column": col.get("columnNumber"),
                "row": t.get("row"),
                "era": col.get("era"),
                "cost": col.get("techCost"),
                "building_cost": col.get("buildingCost"),
                "quote": (t.get("quote") or "")[:200],
                "uniques": t.get("uniques", []),
            })

    bld_out = []
    for b in load("Buildings.json", []):
        if isinstance(b, dict) and b.get("name"):
            bld_out.append({
                "name": b["name"],
                "cost": b.get("cost"),
                "maintenance": b.get("maintenance"),
                "requiredTech": b.get("requiredTech"),
                "uniqueTo": b.get("uniqueTo"),
                "uniques": (b.get("uniques") or [])[:4],
            })

    unit_out = []
    for u in load("Units.json", []):
        if isinstance(u, dict) and u.get("name"):
            unit_out.append({
                "name": u["name"],
                "cost": u.get("cost"),
                "strength": u.get("strength"),
                "rangedStrength": u.get("rangedStrength"),
                "movement": u.get("movement"),
                "requiredTech": u.get("requiredTech"),
                "unitType": u.get("unitType"),
            })

    nat_out = [{"name": n.get("name"), "leaderName": n.get("leaderName")}
               for n in load("Nations.json", [])
               if isinstance(n, dict) and n.get("name")][:24]

    c.write_json(tech_out, "unciv/techs.json", f"{len(tech_out)} technologies over 18 columns")
    c.write_json(bld_out, "unciv/buildings.json", f"{len(bld_out)} buildings")
    c.write_json(unit_out, "unciv/units.json", f"{len(unit_out)} units")
    c.write_json(nat_out, "unciv/nations.json", f"{len(nat_out)} civilisations")
    return c, None


# ---------------------------------------------------------------- cataclysm dda

MASS_RE = re.compile(r"([\d.]+)\s*(kg|g|mg|lbs|lb|L|ml)", re.I)
UNIT = {"kg": 1000.0, "g": 1.0, "mg": 0.001, "lb": 453.592, "lbs": 453.592}


def up_quantity(v, kind):
    """C:DDA writes weights and volumes as '1.5 kg' / '300 ml' / sometimes a number."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = MASS_RE.search(str(v))
    if not m:
        return None
    unit = m.group(2).lower()
    amount = float(m.group(1))
    if kind == "mass":
        return round(amount * UNIT.get(unit, 1.0), 1)
    return round(amount * (1000.0 if unit.lower() == "l" else 1.0), 1)


def up_price(v):
    """Nowadays upstream stores cents as an int; older data uses '12 USD' strings."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return round(v / 100.0, 2) or None
    m = re.search(r"([\d.]+)\s*(USD|\$)?", str(v))
    return round(float(m.group(1)), 2) if m else None


def round_robin(buckets, limit):
    """Take one from each bucket in turn so the sample spans the whole catalogue."""
    out, keys = [], [k for k in buckets if buckets[k]]
    while len(out) < limit and any(buckets[k] for k in keys):
        for k in keys:
            if buckets[k] and len(out) < limit:
                out.append(buckets[k].pop(0))
    return out


def import_cataclysm(max_items=180, max_monsters=60, max_recipes=60):
    cfg = SOURCES["cataclysm-dda"]
    repo = cfg["path"]
    if not os.path.isdir(repo):
        return None, "clone not found"
    c = Collector("cataclysm-dda", repo, head_commit(repo), cfg["license"])
    root = os.path.join(repo, "data", "json")
    if not os.path.isdir(root):
        return None, "data/json not found"

    def name_of(n):
        if isinstance(n, str):
            return n
        if isinstance(n, dict):
            for k in ("str_sp", "str", "str_pl"):
                if isinstance(n.get(k), str):
                    return n[k]
        return ""

    item_bucket, mon_bucket, recipe_bucket = {}, {}, {}
    for dirpath, _, files in os.walk(root):
        if "/obsolete" in dirpath or "/mods" in dirpath or "/test_data" in dirpath:
            continue
        for fn in files:
            if not fn.endswith(".json"):
                continue
            p = os.path.join(dirpath, fn)
            try:
                data = json.load(open(p, encoding="utf-8"))
            except Exception:
                continue
            for ent in (data if isinstance(data, list) else [data]):
                if not isinstance(ent, dict):
                    continue
                typ = ent.get("type")
                if typ in ("ITEM", "GENERIC", "TOOL", "ARMOR", "GUN", "COMESTIBLE", "WEAPON", "AMMO", "BOOK"):
                    nm = name_of(ent.get("name"))
                    if not nm or ent.get("abstract"):
                        continue
                    price = up_price(ent.get("price"))
                    if not price:
                        continue
                    cat = ent.get("category") or "misc"
                    item_bucket.setdefault(cat, []).append({
                        "id": ent.get("id"),
                        "name": nm,
                        "category": cat,
                        "price_usd": price,
                        "weight_g": up_quantity(ent.get("weight"), "mass"),
                        "volume_ml": up_quantity(ent.get("volume"), "volume"),
                        "symbol": ent.get("symbol"),
                        "description": name_of(ent.get("description"))[:240],
                        "source_file": rel_repo_path(repo, p),
                    })
                elif typ == "MONSTER":
                    nm = name_of(ent.get("name"))
                    if not nm or ent.get("copy-from"):
                        continue
                    hp = ent.get("hp")
                    speed = ent.get("speed")
                    if not isinstance(hp, (int, float)) or not isinstance(speed, (int, float)):
                        continue
                    sym = ent.get("symbol") or "?"
                    mon_bucket.setdefault(sym, []).append({
                        "id": ent.get("id"),
                        "name": nm,
                        "hp": hp,
                        "speed": speed,
                        "melee_dice": ent.get("melee_dice"),
                        "melee_dice_sides": ent.get("melee_dice_sides"),
                        "symbol": sym,
                    })
                elif typ in ("recipe", "RECIPE"):
                    res = ent.get("result")
                    if not res or ent.get("obsolete"):
                        continue
                    comps = []
                    for comp in ent.get("components", [])[:4]:
                        opts = [o[0] for o in comp if isinstance(o, list) and o]
                        if opts:
                            comps.append({"any_of": opts[:3], "count": comp[1] if len(comp) > 1 else 1})
                    recipe_bucket.setdefault(ent.get("skill_used") or "none", []).append({
                        "result": res, "components": comps, "skill_used": ent.get("skill_used"),
                    })

    # ordinary dungeon fauna first — a game wants zombies and dogs before eigenspectres
    CLASSIC = ("zombie", "zombi", "skel", "dog", "rat", "wolf", "bear", "spider", "bandit",
               "cougar", "moose", "deer", "coyote", "snake", "giant", "ant", "wasp", "bee",
               "boomer", "brute", "hulk", "shrieker", "scorcher", "turret", "drone", "bot")
    for sym, group in mon_bucket.items():
        group.sort(key=lambda m: (0 if any(k in (m["name"] or "").lower() for k in CLASSIC) else 1))

    items = round_robin(item_bucket, max_items)
    # half the bestiary should be things a player recognises, half whatever else exists
    classic = [m for group in mon_bucket.values() for m in group
               if any(k in (m["name"] or "").lower() for k in CLASSIC)]
    classic.sort(key=lambda m: (len(m["name"] or ""), m["name"] or ""))
    monsters = classic[:max_monsters // 2]
    taken = {m["id"] for m in monsters}
    for sym in list(mon_bucket):
        mon_bucket[sym] = [m for m in mon_bucket[sym] if m["id"] not in taken]
    monsters += round_robin(mon_bucket, max_monsters - len(monsters))
    recipes = round_robin(recipe_bucket, max_recipes)
    c.write_json(items, "cataclysm-dda/items.json",
                 f"{len(items)} items across {len(item_bucket)} categories")
    c.write_json(monsters, "cataclysm-dda/monsters.json",
                 f"{len(monsters)} monsters across {len(mon_bucket)} symbols")
    c.write_json(recipes, "cataclysm-dda/recipes.json",
                 f"{len(recipes)} recipes across {len(recipe_bucket)} skills")
    return c, None


# ---------------------------------------------------------------- stk asset audio

STK_MUSIC = ["Boom_boom_boom.ogg", "Alien_signal.ogg", "Chip_Disco.ogg", "Snow_is_Coming.ogg"]
STK_SFX = ["crash.ogg", "anvil.ogg", "break.ogg", "boing.ogg", "clock.ogg",
           "bubblegum_explode.ogg", "crystal.ogg", "explosion.ogg"]


def import_stk():
    cfg = SOURCES["stk-assets"]
    repo = cfg["path"]
    if not os.path.isdir(repo):
        return None, "clone not found"
    c = Collector("stk-assets", repo, head_commit(repo), cfg["license"])
    meta = {"music": [], "sounds": []}

    mus_dir = os.path.join(repo, "music")
    if os.path.isdir(mus_dir):
        have = {f.lower(): f for f in os.listdir(mus_dir)}
        for want in STK_MUSIC:
            fn = have.get(want.lower())
            if not fn:
                continue
            rel = f"stk-assets/audio/{os.path.splitext(fn)[0].lower()}.opus"
            dst = os.path.join(VENDOR, rel)
            if audio_trim(os.path.join(mus_dir, fn), dst, 90, 48):
                c.files.append({
                    "path": rel, "source_path": rel_repo_path(repo, os.path.join(mus_dir, fn)),
                    "source_repo": c.source, "commit": c.commit, "license": c.license,
                    "bytes": os.path.getsize(dst), "sha256": sha256(dst),
                    "note": "first 90s, opus 48k mono",
                })
                meta["music"].append({"name": os.path.splitext(fn)[0], "audio": "vendor/" + rel})

    sfx_dir = os.path.join(repo, "sfx")
    if os.path.isdir(sfx_dir):
        index = {}
        for dirpath, _, files in os.walk(sfx_dir):
            for f in files:
                if f.lower().endswith(".ogg"):
                    index.setdefault(f.lower(), os.path.join(dirpath, f))
        for want in STK_SFX:
            src = index.get(want.lower())
            if not src:
                continue
            rel = f"stk-assets/audio/sfx_{os.path.splitext(want)[0].lower()}.opus"
            dst = os.path.join(VENDOR, rel)
            if audio_to_opus(src, dst, 40):
                c.files.append({
                    "path": rel, "source_path": rel_repo_path(repo, src),
                    "source_repo": c.source, "commit": c.commit, "license": c.license,
                    "bytes": os.path.getsize(dst), "sha256": sha256(dst),
                    "note": "re-encoded ogg -> opus 40k mono",
                })
                meta["sounds"].append({"name": os.path.splitext(want)[0], "audio": "vendor/" + rel})

    c.write_json(meta, "stk-assets/audio.json",
                 f"{len(meta['music'])} tracks, {len(meta['sounds'])} sfx")
    return c, None


MINDUSTRY_BLOCKS = {
    "drills": ["mechanical-drill", "pneumatic-drill", "laser-drill", "blast-drill", "water-extractor"],
    "distribution/conveyors": ["conveyor", "titanium-conveyor", "plastanium-conveyor", "armored-conveyor"],
    "distribution": ["junction", "router", "sorter", "overflow-gate", "distributor"],
    "turrets": ["duo", "scatter", "hail", "wave", "lancer", "arc", "cyclone", "ripple", "fuse"],
    "walls": ["copper-wall", "titanium-wall", "thorium-wall", "plastanium-wall", "phase-wall", "surge-wall"],
    "production": ["graphite-press", "silicon-smelter", "kiln", "pulverizer", "melter", "separator",
                   "disassembler", "incinerator", "cryofluid-mixer"],
    "power": ["combustion-generator", "solar-panel", "battery", "power-node"],
}


THREE_VERSION = "0.156.1"


def import_three():
    """three.js, taken from the published npm tarball rather than a git checkout.

    The collection has to run from file:// with no bundler, and ES modules do not load from
    file:// at all, so this pins the last UMD build (r156). The tarball's hash is recorded in
    the manifest commit string, which is what makes the vendored bytes reproducible.
    """
    import tarfile
    cfg = SOURCES["three"]
    repo = cfg["path"]
    os.makedirs(repo, exist_ok=True)
    tgz = os.path.join(repo, f"three-{THREE_VERSION}.tgz")
    if not os.path.exists(tgz):
        r = subprocess.run(["npm", "pack", f"three@{THREE_VERSION}", "--pack-destination", repo],
                           capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            return None, "npm pack failed: " + (r.stderr or "").strip()[:120]
    if not os.path.exists(tgz):
        return None, "tarball missing after npm pack"
    commit = f"npm three@{THREE_VERSION} tarball sha256:{sha256(tgz)[:32]}"

    unpack = os.path.join(repo, "unpacked")
    if not os.path.exists(os.path.join(unpack, "package/build/three.min.js")):
        os.makedirs(unpack, exist_ok=True)
        with tarfile.open(tgz) as tf:
            for member in tf.getmembers():
                if member.name in ("package/build/three.min.js", "package/LICENSE"):
                    tf.extract(member, unpack, filter="data")
    pkg = os.path.join(unpack, "package")
    c = Collector("three", pkg, commit, cfg["license"])
    c.copy(os.path.join(pkg, "build/three.min.js"), "three/three.min.js",
          "three.js r156 UMD build, loaded as a classic script so file:// works")
    c.copy(os.path.join(pkg, "LICENSE"), "three/LICENSE", "three.js MIT licence text")
    c.write_json({"package": "three", "version": THREE_VERSION, "tarball_sha256": sha256(tgz),
                  "build": "build/three.min.js", "note": "UMD build; r156 is the last one"},
                 "three/version.json", "which three.js build is vendored and why")
    return c, None


def import_mindustry():
    """Item icons and the three block sprites a conveyor-and-turret game needs.

    Only art is taken: the game logic that makes belts and drills interesting is written
    from scratch in games/siegehaus. Sprites are copied byte-for-byte (they are already
    small, and Mindustry draws them at 32 px in a 32 px cell).
    """
    cfg = SOURCES["mindustry"]
    repo = cfg["path"]
    if not os.path.isdir(repo):
        return None, "clone not found"
    sprites = os.path.join(repo, "core", "assets-raw", "sprites")
    if not os.path.isdir(sprites):
        return None, "sprites not found"
    c = Collector("mindustry", repo, head_commit(repo), cfg["license"])
    meta = {"items": [], "belt": [], "belt_anim": [], "drill": [], "turret": []}

    item_dir = os.path.join(sprites, "items")
    for fn in sorted(os.listdir(item_dir)):
        # item-* are the solid materials; liquid-* are barrels we have no system for
        if not fn.startswith("item-") or not fn.endswith(".png"):
            continue
        name = fn[len("item-"):-4]
        rel = f"mindustry/items/{name}.png"
        c.copy(os.path.join(item_dir, fn), rel, "Mindustry item icon")
        meta["items"].append({"name": name, "image": "vendor/" + rel})

    conv = os.path.join(sprites, "blocks", "distribution", "conveyors")
    for d in range(4):  # four orientation masks, frame 0
        fn = f"conveyor-0-{d}.png"
        src = os.path.join(conv, fn)
        if os.path.exists(src):
            rel = f"mindustry/belt/{fn}"
            c.copy(src, rel, "Mindustry conveyor, orientation variant")
            meta["belt"].append("vendor/" + rel)
    for fr in range(1, 5):  # animation frames for the default orientation
        fn = f"conveyor-{fr}-0.png"
        src = os.path.join(conv, fn)
        if os.path.exists(src):
            rel = f"mindustry/belt/{fn}"
            c.copy(src, rel, "Mindustry conveyor, animation frame")
            meta["belt_anim"].append("vendor/" + rel)

    for fn in ("blast-drill-top.png", "blast-drill.png"):
        src = os.path.join(sprites, "blocks", "drills", fn)
        if os.path.exists(src):
            rel = f"mindustry/blocks/{fn}"
            c.copy(src, rel, "Mindustry drill sprite")
            meta["drill"].append("vendor/" + rel)

    for fn in ("duo.png", "duo-barrel-l.png", "duo-barrel-r.png"):
        src = os.path.join(sprites, "blocks", "turrets", "duo", fn)
        if os.path.exists(src):
            rel = f"mindustry/blocks/{fn}"
            c.copy(src, rel, "Mindustry turret sprite")
            meta["turret"].append("vendor/" + rel)

    # The rest of the block set a build economy needs: drills that feed conveyors, conveyors
    # that feed smelters, smelters that feed turrets, walls that buy time. Each block keeps its
    # `-top` / `-heat` / `-rotator` overlay because those are separate draw layers upstream.
    meta.setdefault("blocks", [])
    for cat, names in MINDUSTRY_BLOCKS.items():
        cdir = os.path.join(sprites, "blocks", cat)
        if not os.path.isdir(cdir):
            continue
        for name in names:
            rels = []
            for suffix in ("", "-top", "-rotator", "-heat", "-glow", "-large"):
                src = os.path.join(cdir, name + suffix + ".png")
                if os.path.exists(src):
                    rel = f"mindustry/blocks/{cat.replace('/', '-')}/{name}/{name}{suffix}.png"
                    c.copy(src, rel, f"Mindustry {cat} block: {name}")
                    rels.append("vendor/" + rel)
            ndir = os.path.join(cdir, name)
            if os.path.isdir(ndir):
                for f in sorted(os.listdir(ndir)):
                    if not f.endswith(".png"):
                        continue
                    rel = f"mindustry/blocks/{cat.replace('/', '-')}/{name}/{f}"
                    c.copy(os.path.join(ndir, f), rel, f"Mindustry {cat} block: {name}")
                    rels.append("vendor/" + rel)
            if rels:
                meta["blocks"].append({"category": cat, "name": name, "sprites": rels})

    c.write_json(meta, "mindustry/assets.json",
                 f"{len(meta['items'])} item icons, {len(meta['belt']) + len(meta['belt_anim'])} "
                 f"conveyor frames, {len(meta['drill']) + len(meta['turret'])} block sprites")
    return c, None


LUANTI_MATERIALS = [
    # (upstream file stem, the material name the game asks for)
    ("default_stone", "stone"),
    ("default_cobble", "cobble"),
    ("default_mossycobble", "mossy-cobble"),
    ("default_dirt", "dirt"),
    ("default_grass", "grass"),
    ("default_leaves", "leaves"),
    ("default_tree", "bark"),
    ("default_sand", "sand"),
    ("default_desert_sand", "red-sand"),
    ("default_snow", "snow"),
    ("default_ice", "ice"),
    ("default_river_water", "water"),
    ("default_gravel", "gravel"),
    ("default_lava", "lava"),
]


def import_luanti():
    """Node material textures — isotropic 16 px tiles with no perspective.

    Deliberately these, not a tileset: an isometric or flat-top *tile* carries an implied
    viewing angle, which is why Unciv's hex art could not be dropped into a pointy-top map.
    A seamless material texture has no up or down, so it can be clipped into any polygon.
    """
    cfg = SOURCES["luanti"]
    repo = cfg["path"]
    if not os.path.isdir(repo):
        return None, "clone not found"
    tex = os.path.join(repo, "games", "devtest", "mods", "basenodes", "textures")
    if not os.path.isdir(tex):
        return None, "basenodes textures not found"
    c = Collector("luanti", repo, head_commit(repo), cfg["license"])
    meta = {"materials": []}
    for stem, name in LUANTI_MATERIALS:
        src = os.path.join(tex, stem + ".png")
        if not os.path.exists(src):
            continue
        rel = f"luanti/textures/{name}.png"
        c.copy(src, rel, "Luanti node texture")
        meta["materials"].append({"name": name, "image": "vendor/" + rel})
    c.write_json(meta, "luanti/materials.json", f"{len(meta['materials'])} node material textures")
    return c, None


# ---------------------------------------------------------------- flare-game / dcss / wesnoth
#
# Two more hybrids ship on these three donors, and each one takes a different kind of
# thing: Flare gives painted art and its item records, Wesnoth gives unit rules and
# sprites, DCSS gives hand-authored room geometry. Nothing above is reused.


def _ini_blocks(path: str, tag: str = "item"):
    """Parse Flare's INI-flavoured data files into one dict per [tag] block.

    Repeat keys are kept as lists, because Flare itself relies on that (`loot_animation`
    appears three times on the same item, `INCLUDE` chains a base definition in).
    """
    out, cur = [], None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s == f"[{tag}]":
                cur = {}
                out.append(cur)
                continue
            if cur is None or "=" not in s:
                continue
            k, v = s.split("=", 1)
            cur.setdefault(k.strip(), []).append(v.strip())
    return out


def import_flare_game(max_tileset_px=1200, max_monster_px=256, max_portrait_px=160,
                      max_items=140, max_monsters=36, music_tracks=3):
    """Flare's painted art, its real item records, and its music.

    Flare is the only donor in the pool with 2D art rendered from 3D models: boss sheets
    up to 6144 px, isometric tilesets to 2485x3865. Art is downscaled — a phone cannot use
    that resolution — but the item numbers are upstream's own (`dmg=melee,10,10`,
    `stat=absorb_max,12`), not invented balance.
    """
    cfg = SOURCES["flare-game"]
    repo = cfg["path"]
    if not os.path.isdir(repo):
        return None, "clone not found"
    mods_dir = os.path.join(repo, "mods")
    if not os.path.isdir(mods_dir):
        return None, "mods/ not found"
    mods = sorted(d for d in os.listdir(mods_dir) if os.path.isdir(os.path.join(mods_dir, d)))
    c = Collector("flare-game", repo, head_commit(repo), cfg["license"])
    meta = {"tilesets": [], "monsters": [], "portraits": [], "ui": [], "icons": [],
            "music": [], "items": []}

    # ---- item records, INCLUDEs resolved (the numbers live in the included block)
    seen = set()
    for m in mods:
        items_dir = os.path.join(mods_dir, m, "items")
        if not os.path.isdir(items_dir):
            continue
        for root_, _dirs, files in os.walk(items_dir):
            for fn in sorted(files):
                if not fn.endswith(".txt"):
                    continue
                for it in _ini_blocks(os.path.join(root_, fn)):
                    name = (it.get("name") or [""])[0]
                    if not name or name in seen:
                        continue
                    stats = {k: list(v) for k, v in it.items()}
                    for inc in it.get("INCLUDE", []):
                        # Flare resolves INCLUDE against the whole load order, not just the
                        # mod that wrote it: empyrean_campaign items include fantasycore base
                        # definitions, which is where the armour numbers live.
                        rel_inc = inc.replace("\\", "/").lstrip("./")
                        cands = [os.path.join(mods_dir, mod, rel_inc) for mod in mods]
                        cands.append(os.path.join(mods_dir, m, rel_inc))
                        for p in cands:
                            if not os.path.exists(p):
                                continue
                            for sub in _ini_blocks(p):
                                for k, vs in sub.items():
                                    stats.setdefault(k, []).extend(vs)
                            break
                    rec = {"name": name, "source_mod": m}
                    level = num((it.get("level") or [None])[0], 1)
                    rec["level"] = int(level) if level else 1
                    rec["price"] = int(num((it.get("price") or [None])[0]))
                    dmg = (it.get("dmg") or stats.get("dmg") or [None])[0]
                    if dmg:
                        parts = [p.strip() for p in dmg.split(",")]
                        if len(parts) >= 3:
                            rec["damage"] = {"kind": parts[0], "min": int(num(parts[1])),
                                             "max": int(num(parts[2]))}
                    bonus = {}
                    for key in ("bonus", "stat"):
                        for v in stats.get(key, []):
                            parts = [x.strip() for x in v.split(",")]
                            if len(parts) == 2:
                                val = num(parts[1])
                                if val:
                                    bonus[parts[0]] = bonus.get(parts[0], 0) + int(val)
                    if bonus:
                        rec["bonus"] = bonus
                    # Flare writes a lot of armour as bonus=defense,N and some as
                    # stat=absorb_max,N; both are upstream numbers, so both are kept.
                    absorb = bonus.get("absorb_max") or bonus.get("defense")
                    if absorb:
                        rec["armour"] = int(absorb)
                    slot = (it.get("item_type") or stats.get("item_type") or [None])[0]
                    if slot:
                        rec["slot"] = slot
                    if "damage" not in rec and "armour" not in rec and not rec["price"]:
                        continue
                    seen.add(name)
                    meta["items"].append(rec)
    meta["items"].sort(key=lambda r: (r["level"], r["name"]))
    meta["items"] = meta["items"][:max_items]

    # ---- art: the whole point of this donor
    def take_pngs(pattern_dirs, limit, prefix, rel_dir, note, max_px):
        picked = []
        for m in mods:
            d = os.path.join(mods_dir, m, "images", pattern_dirs)
            if not os.path.isdir(d):
                continue
            for root_, _dirs, files in os.walk(d):
                for fn in files:
                    if fn.endswith(".png"):
                        picked.append((os.path.getsize(os.path.join(root_, fn)),
                                       os.path.join(root_, fn)))
        picked.sort(reverse=True)
        out = []
        for _sz, src in picked:
            if len(out) >= limit:
                break
            base = os.path.basename(src)
            rel = f"flare-game/{rel_dir}/{re.sub(r'[^A-Za-z0-9_.-]', '_', base)}"
            if any(f["path"] == rel for f in c.files):
                continue
            pilot_downscale(src, os.path.join(VENDOR, rel), max_px)
            c.files.append({
                "path": rel, "source_path": rel_repo_path(repo, src),
                "source_repo": "flare-game", "commit": c.commit, "license": c.license,
                "bytes": os.path.getsize(os.path.join(VENDOR, rel)),
                "sha256": sha256(os.path.join(VENDOR, rel)), "note": note,
            })
            out.append("vendor/" + rel)
        return out

    meta["tilesets"] = take_pngs("tilesets", 4, "tile", "tilesets",
                                "Flare isometric tileset, downscaled", max_tileset_px)
    meta["monsters"] = take_pngs("enemies", max_monsters, "mon", "monsters",
                                "Flare monster/boss sprite sheet, downscaled", max_monster_px)
    meta["portraits"] = take_pngs("portraits", 12, "por", "portraits",
                                  "Flare portrait, downscaled", max_portrait_px)
    meta["ui"] = take_pngs("menus", 6, "ui", "ui", "Flare menu panel, downscaled", 512)
    meta["icons"] = take_pngs("icons", 5, "ico", "icons", "Flare icon sheet, downscaled",
                              max_tileset_px)

    # ---- music
    for m in mods:
        d = os.path.join(mods_dir, m, "music")
        if not os.path.isdir(d):
            continue
        tracks = sorted(os.listdir(d))
        for fn in tracks:
            if len(meta["music"]) >= music_tracks:
                break
            if not fn.endswith(".ogg"):
                continue
            rel = "flare-game/music/" + re.sub(r"[^A-Za-z0-9_.-]", "_", fn[:-4]) + ".opus"
            if any(f["path"] == rel for f in c.files):
                continue
            if audio_trim(os.path.join(d, fn), os.path.join(VENDOR, rel), seconds=90):
                c.files.append({
                    "path": rel, "source_path": rel_repo_path(repo, os.path.join(d, fn)),
                    "source_repo": "flare-game", "commit": c.commit, "license": c.license,
                    "bytes": os.path.getsize(os.path.join(VENDOR, rel)),
                    "sha256": sha256(os.path.join(VENDOR, rel)),
                    "note": "Flare music, first 90 s, Opus 48 kbps mono",
                })
                meta["music"].append("vendor/" + rel)

    c.write_json(meta, "flare-game/assets.json",
                 f"{len(meta['items'])} item records, {len(meta['monsters'])} monster sheets, "
                 f"{len(meta['tilesets'])} tilesets, {len(meta['music'])} music tracks")
    return c, None


DES_HEADER_RE = re.compile(r"^(NAME|DEPTH|TAGS|WEIGHT|ORIENT):\s*(.+)$")

# DCSS's map language uses a letter per feature, and those letters mean whatever the
# vault's own SUBST/KFEAT lines say. For a room's *shape* only four classes matter, so the
# grids are normalised to: '#' wall, '.' floor, '+' door, '>' stairs down, ' ' void.
# Anything else in a .des grid is placed content (a monster, an item, an altar) — it sits
# on floor, so it normalises to floor. The interpreter is not taken.
_DES_WALL = set("#xX-=W%*")
_DES_VOID = set(" ")


def _des_normalise(row: str) -> str:
    out = []
    for ch in row:
        if ch in _DES_WALL:
            out.append("#")
        elif ch in _DES_VOID:
            out.append(" ")
        elif ch in "+'":
            out.append("+")
        elif ch == ">":
            out.append(">")
        else:
            out.append(".")
    return "".join(out)


def import_dcss(max_vaults=420, min_side=6, max_side=26, item_tiles=60, mon_tiles=40):
    """DCSS's hand-authored room geometry, plus its 32 px tiles as UI icons.

    A `.des` file is DCSS's map language. What is taken is the part that is pure design
    work: the `MAP ... ENDMAP` grids — 6,127 of them across 144 files — with their depth
    bands and tags. The interpreter is not taken; this repo maps the grid characters onto
    its own tiles, and says so.
    """
    cfg = SOURCES["dcss"]
    repo = cfg["path"]
    if not os.path.isdir(repo):
        return None, "clone not found"
    des_dir = os.path.join(repo, "crawl-ref", "source", "dat", "des")
    if not os.path.isdir(des_dir):
        return None, "des/ not found"
    c = Collector("dcss", repo, head_commit(repo), cfg["license"])
    vaults = []
    for root_, _dirs, files in os.walk(des_dir):
        for fn in sorted(files):
            if not fn.endswith(".des"):
                continue
            cur, rows, inmap = None, [], False
            for line in open(os.path.join(root_, fn), encoding="utf-8", errors="replace"):
                s = line.rstrip("\n")
                if inmap:
                    if s.strip() == "ENDMAP":
                        inmap = False
                        if cur:
                            h, w = len(rows), max((len(r) for r in rows), default=0)
                            if min_side <= h <= max_side and min_side <= w <= max_side:
                                cur.update({"h": h, "w": w,
                                            "grid": [_des_normalise(r) for r in rows]})
                                cur["file"] = rel_repo_path(repo, os.path.join(root_, fn))
                                vaults.append(cur)
                        rows = []
                    else:
                        rows.append(s)
                    continue
                if s.strip() == "MAP":
                    inmap = True
                    continue
                m = DES_HEADER_RE.match(s)
                if not m:
                    continue
                k, v = m.group(1), m.group(2).strip()
                if k == "NAME":
                    cur = {"id": v, "depth": None, "tags": [], "weight": None}
                elif cur is not None:
                    if k == "DEPTH":
                        cur["depth"] = v
                    elif k == "TAGS":
                        cur["tags"] = v.split()
                    elif k == "WEIGHT":
                        cur["weight"] = v
    # spread the sample across depth bands instead of shipping the first 420 alphabetically
    vaults.sort(key=lambda v: (v.get("depth") or "zz", v["id"]))
    if len(vaults) > max_vaults:
        step = len(vaults) / max_vaults
        vaults = [vaults[int(i * step)] for i in range(max_vaults)]
    c.write_json({"vaults": vaults}, "dcss/vaults.json",
                 f"{len(vaults)} DCSS MAP-grid vaults with depth bands and tags")

    tiles = {"items": [], "monsters": []}
    for sub, key, limit, note in (
        (os.path.join("rltiles", "item"), "items", item_tiles, "DCSS tile, 32 px"),
        (os.path.join("rltiles", "mon"), "monsters", mon_tiles, "DCSS monster tile, 32 px"),
    ):
        d = os.path.join(repo, "crawl-ref", "source", sub)
        if not os.path.isdir(d):
            continue
        picked = []
        for root_, _dirs, files in os.walk(d):
            for fn in sorted(files):
                if fn.endswith(".png"):
                    picked.append(os.path.join(root_, fn))
        picked.sort()
        if len(picked) > limit:
            step = len(picked) / limit
            picked = [picked[int(i * step)] for i in range(limit)]
        for src in picked:
            rel = f"dcss/tiles/{key}/" + re.sub(r"[^A-Za-z0-9_.-]", "_",
                                               os.path.basename(src))
            c.copy(src, rel, note)
            tiles[key].append("vendor/" + rel)
    c.write_json(tiles, "dcss/tiles.json",
                 f"{len(tiles['items'])} item tiles, {len(tiles['monsters'])} monster tiles")
    return c, None


UNIT_FIELD_MAX = 22


def _wml_field(block: str, key: str):
    m = re.search(r"^\s*" + re.escape(key) + r"\s*=\s*_?\s*\"?([^\"\n]*)\"?", block, re.M)
    return m.group(1).strip() if m else None


def import_wesnoth(max_units=UNIT_FIELD_MAX, max_terrain=14, music_tracks=2):
    """Wesnoth's unit rules, its unit art and its music.

    Hit points, movement, cost, level, alignment and every attack's damage/number/type are
    read out of Wesnoth's own `.cfg` unit definitions; the sprites are the units those
    records describe. The WML engine and the campaigns are not taken.
    """
    cfg = SOURCES["wesnoth"]
    repo = cfg["path"]
    if not os.path.isdir(repo):
        return None, "clone not found"
    units_dir = os.path.join(repo, "data", "core", "units")
    img_dir = os.path.join(repo, "data", "core", "images")
    if not os.path.isdir(units_dir) or not os.path.isdir(img_dir):
        return None, "units/ or images/ not found"
    c = Collector("wesnoth", repo, head_commit(repo), cfg["license"])
    meta = {"units": [], "terrain": [], "music": []}

    cands = []
    for root_, _dirs, files in os.walk(units_dir):
        for fn in sorted(files):
            if not fn.endswith(".cfg"):
                continue
            p = os.path.join(root_, fn)
            txt = open(p, encoding="utf-8", errors="replace").read()
            if "[unit_type]" not in txt:
                continue
            hp = num(_wml_field(txt, "hitpoints"))
            lvl = num(_wml_field(txt, "level"), 1)
            image = _wml_field(txt, "image") or ""
            if not hp or not image or "[" in image or "{" in image:
                continue  # animated/variadic image specs have no single base file
            if lvl > 2:
                continue
            ipath = os.path.join(img_dir, image)
            if not os.path.exists(ipath):
                continue
            attacks = []
            for ab in re.findall(r"\[attack\](.*?)\[/attack\]", txt, re.S):
                dmg = num(_wml_field(ab, "damage"))
                n = num(_wml_field(ab, "number"))
                if dmg and n:
                    attacks.append({"name": _wml_field(ab, "name") or "attack",
                                    "type": _wml_field(ab, "type") or "blade",
                                    "range": _wml_field(ab, "range") or "melee",
                                    "damage": int(dmg), "number": int(n)})
            if not attacks:
                continue
            cands.append({
                "id": _wml_field(txt, "id") or os.path.basename(p)[:-4],
                "name": (_wml_field(txt, "name") or "").replace("_", "").strip() or
                        os.path.basename(p)[:-4],
                "race": _wml_field(txt, "race") or "unknown",
                "level": int(lvl), "hp": int(hp),
                "movement": int(num(_wml_field(txt, "movement"), 5)),
                "cost": int(num(_wml_field(txt, "cost"))),
                "alignment": _wml_field(txt, "alignment") or "neutral",
                "attacks": attacks,
                "_image": ipath, "_portrait": _wml_field(txt, "profile"),
            })
    # A skirmish roster wants soldiers, not scenery: bats, cats, falcons, ships and horses
    # are real Wesnoth units but they make a poor army. Prefer factions that fight on foot
    # and have a recruit cost, then fall back to anything with an attack.
    PLAYABLE = ("human", "orc", "undead", "elf", "dwarf", "troll", "goblin", "drake",
                "merman", "naga", "ogre", "lizard", "mechanical")
    cands.sort(key=lambda u: (0 if u["race"] in PLAYABLE and u["cost"] > 0 else 1,
                              u["level"], u["race"], u["id"]))
    if len(cands) > max_units:
        # Round-robin across factions so a 22-unit roster is an army, not 22 dwarves and
        # a drake. Each faction's cheapest unit goes first, then its next, and so on.
        buckets = {}
        for u in cands:
            buckets.setdefault(u["race"], []).append(u)
        order = sorted(buckets, key=lambda r: (0 if r in PLAYABLE else 1, r))
        picked, i = [], 0
        while len(picked) < max_units and any(len(buckets[r]) > i for r in order):
            for r in order:
                if len(buckets[r]) > i and len(picked) < max_units:
                    picked.append(buckets[r][i])
            i += 1
        cands = picked

    for u in cands:
        ipath = u.pop("_image")
        portrait = u.pop("_portrait")
        rel = "wesnoth/units/" + re.sub(r"[^A-Za-z0-9_.-]", "_", u["id"]) + ".png"
        pilot_downscale(ipath, os.path.join(VENDOR, rel), 96)
        c.files.append({
            "path": rel, "source_path": rel_repo_path(repo, ipath),
            "source_repo": "wesnoth", "commit": c.commit, "license": c.license,
            "bytes": os.path.getsize(os.path.join(VENDOR, rel)),
            "sha256": sha256(os.path.join(VENDOR, rel)),
            "note": "Wesnoth unit base sprite, downscaled to <=96 px",
        })
        u["image"] = "vendor/" + rel
        if portrait:
            ppath = os.path.join(img_dir, portrait)
            if os.path.exists(ppath):
                prel = "wesnoth/portraits/" + re.sub(r"[^A-Za-z0-9_.-]", "_",
                                                     u["id"]) + ".png"
                try:
                    from PIL import Image
                    im = Image.open(ppath).convert("RGBA")
                    im.thumbnail((160, 160), getattr(getattr(Image, "Resampling", Image),
                                                    "LANCZOS"))
                    os.makedirs(os.path.dirname(os.path.join(VENDOR, prel)), exist_ok=True)
                    im.save(os.path.join(VENDOR, prel), "PNG", optimize=True)
                    c.files.append({
                        "path": prel, "source_path": rel_repo_path(repo, ppath),
                        "source_repo": "wesnoth", "commit": c.commit, "license": c.license,
                        "bytes": os.path.getsize(os.path.join(VENDOR, prel)),
                        "sha256": sha256(os.path.join(VENDOR, prel)),
                        "note": "Wesnoth unit portrait, downscaled to <=160 px",
                    })
                    u["portrait"] = "vendor/" + prel
                except Exception:
                    pass
        meta["units"].append(u)

    terrain_dir = os.path.join(img_dir, "terrain")
    if os.path.isdir(terrain_dir):
        picked = []
        for root_, _dirs, files in os.walk(terrain_dir):
            for fn in sorted(files):
                if fn.endswith(".png"):
                    picked.append(os.path.join(root_, fn))
        picked.sort()
        if len(picked) > max_terrain:
            step = len(picked) / max_terrain
            picked = [picked[int(i * step)] for i in range(max_terrain)]
        for src in picked:
            rel = "wesnoth/terrain/" + re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.basename(src))
            pilot_downscale(src, os.path.join(VENDOR, rel), 96)
            c.files.append({
                "path": rel, "source_path": rel_repo_path(repo, src),
                "source_repo": "wesnoth", "commit": c.commit, "license": c.license,
                "bytes": os.path.getsize(os.path.join(VENDOR, rel)),
                "sha256": sha256(os.path.join(VENDOR, rel)),
                "note": "Wesnoth terrain tile, downscaled to <=96 px",
            })
            meta["terrain"].append("vendor/" + rel)

    music_dir = os.path.join(repo, "data", "core", "music")
    if os.path.isdir(music_dir):
        tracks = [(os.path.getsize(os.path.join(music_dir, f)), f)
                  for f in sorted(os.listdir(music_dir)) if f.endswith(".ogg")]
        tracks.sort(reverse=True)
        for _sz, fn in tracks:
            if len(meta["music"]) >= music_tracks:
                break
            rel = "wesnoth/music/" + re.sub(r"[^A-Za-z0-9_.-]", "_", fn[:-4]) + ".opus"
            if audio_trim(os.path.join(music_dir, fn), os.path.join(VENDOR, rel), seconds=90):
                c.files.append({
                    "path": rel, "source_path": rel_repo_path(repo, os.path.join(music_dir, fn)),
                    "source_repo": "wesnoth", "commit": c.commit, "license": c.license,
                    "bytes": os.path.getsize(os.path.join(VENDOR, rel)),
                    "sha256": sha256(os.path.join(VENDOR, rel)),
                    "note": "Wesnoth music, first 90 s, Opus 48 kbps mono",
                })
                meta["music"].append("vendor/" + rel)

    c.write_json(meta, "wesnoth/assets.json",
                 f"{len(meta['units'])} unit records with rule stats, "
                 f"{len(meta['terrain'])} terrain tiles, {len(meta['music'])} music tracks")
    return c, None


# ---------------------------------------------------------------- suroi

# Seasonal reskins of the same asset (winter/fall/halloween/hunted/infection) are dropped:
# one copy of each sprite keeps the payload bounded without losing anything the game uses.
SEASONAL = re.compile(r"_(winter|fall|halloween|hunted|infection)(?:_|\.|$)")

# Whole structures, by upstream directory name, in the order they are tried. Anything not
# present is skipped, so a future upstream rename shrinks the payload instead of breaking it.
SUROI_POIS = [
    "blue_house", "barn", "warehouse", "container", "construction_site", "police_station",
    "hospital", "armory", "mansion", "bank", "gas_station", "fire_house", "lodge", "cabin",
]

# Lootable / breakable props. Fortnite-style fights are cover fights, so walls, doors, crates
# and vehicles matter more than scenery; trees and bushes come along for the ground texture.
SUROI_PROP_WORDS = (
    "wall", "door", "crate", "barrel", "safe", "vault", "sandbag", "fence", "counter",
    "table", "shed", "tent", "car", "wreck", "rock", "tree", "bush",
)

# The sounds a battle royale actually mixes: gunfire by class, impacts, footsteps, pickups,
# heals, shields, explosions and doors. Music is one trimmed track for the drop screen.
SUROI_SFX_DIRS = ["weapons", "bullet", "hits", "footsteps", "healing", "pickup", "shield",
                  "explosions", "door", "swings", "throwables"]


def _svg_png(src: str, dst: str, width: int) -> bool:
    """Rasterise an SVG to PNG at a given width, keeping aspect and alpha."""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    r = subprocess.run(["rsvg-convert", "-w", str(int(width)), "-o", dst, src],
                       capture_output=True)
    return r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 0


def _suroi_blocks(raw: str, key: str = "idString") -> list:
    """Split a definitions file into one text block per definition.

    Suroi's definition files are TypeScript object literals, not JSON: every entry opens with
    `idString: "<id>"`. Slicing between those markers is stable against formatting and lets
    each field be read with a plain regex.
    """
    starts = [(m.start(), m.group(1)) for m in re.finditer(rf'{key}:\s*"([a-z0-9_]+)"', raw)]
    out = []
    for i, (pos, ident) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(raw)
        out.append((ident, raw[pos:end]))
    return out


def _num_in(block: str, key: str):
    m = re.search(rf'\b{key}:\s*(-?\d+(?:\.\d+)?)', block)
    return float(m.group(1)) if m else None


def _str_in(block: str, key: str):
    m = re.search(rf'\b{key}:\s*"([^"]+)"', block)
    return m.group(1) if m else None


def import_suroi(max_props=150, gun_px=176, loot_px=112, prop_px=128,
                 building_px=512, fx_px=72, max_sfx=320):
    """Suroi: a GPL-3.0 2D battle royale. Its guns carry real ballistics numbers and its art
    is vector, so it renders crisp at any size on a phone."""
    cfg = SOURCES["suroi"]
    repo = cfg["path"]
    if not os.path.isdir(repo):
        return None, "clone not found"
    commit = head_commit(repo)
    c = Collector("suroi", repo, commit, cfg["license"])

    art = os.path.join(repo, "client/public/img/game")
    defs = os.path.join(repo, "common/src/definitions")
    if not os.path.isdir(art) or not os.path.isdir(defs):
        return None, "clone has no client art / definitions tree"

    # ---- data: guns (with ballistics), armour, healing -------------------------------
    guns_raw = open(os.path.join(defs, "items/guns.ts"), encoding="utf-8").read()
    guns = []
    for gid, blk in _suroi_blocks(guns_raw):
        tier = re.search(r"\btier:\s*Tier\.([A-Z])", blk)
        mode = re.search(r"\bfireMode:\s*FireMode\.(\w+)", blk)
        damage = speed = rng = None
        b = re.search(r"ballistics:\s*\{", blk)
        if b:
            tail = blk[b.end():]
            close = tail.find("}")
            ball = tail[:close] if close > 0 else tail
            damage = _num_in(ball, "damage")
            speed = _num_in(ball, "speed")
            rng = _num_in(ball, "range")
        guns.append({
            "id": gid,
            "name": _str_in(blk, "name") or gid,
            "tier": tier.group(1) if tier else "?",
            "ammo": _str_in(blk, "ammoType"),
            "ammo_spawn": _num_in(blk, "ammoSpawnAmount"),
            "fire_delay": _num_in(blk, "fireDelay"),
            "switch_delay": _num_in(blk, "switchDelay"),
            "recoil": _num_in(blk, "recoilMultiplier"),
            "recoil_ms": _num_in(blk, "recoilDuration"),
            "mode": mode.group(1) if mode else "Single",
            "spread": _num_in(blk, "shotSpread"),
            "move_spread": _num_in(blk, "moveSpread"),
            "capacity": _num_in(blk, "capacity"),
            "reload": _num_in(blk, "reloadTime"),
            "damage": damage,
            "bullet_speed": speed,
            "range": rng,
        })
    c.write_json({"gun_count": len(guns), "guns": guns}, "suroi/guns.json",
                 f"{len(guns)} guns with upstream ballistics (damage, spread, fire delay, tier)")

    armor_raw = open(os.path.join(defs, "items/armors.ts"), encoding="utf-8").read()
    armors = []
    for aid, blk in _suroi_blocks(armor_raw):
        kind = re.search(r"armorType:\s*ArmorType\.(\w+)", blk)
        armors.append({
            "id": aid,
            "name": _str_in(blk, "name") or aid,
            "type": (kind.group(1) if kind else "Vest").lower(),
            "level": _num_in(blk, "level"),
            "reduction": _num_in(blk, "damageReduction"),
        })
    heal_raw = open(os.path.join(defs, "items/healingItems.ts"), encoding="utf-8").read()
    heals = []
    for hid, blk in _suroi_blocks(heal_raw):
        kind = re.search(r"healType:\s*HealType\.(\w+)", blk)
        heals.append({
            "id": hid,
            "name": _str_in(blk, "name") or hid,
            "type": (kind.group(1) if kind else "Health").lower(),
            "restore": _num_in(blk, "restoreAmount"),
            "use_time": _num_in(blk, "useTime"),
        })
    c.write_json({"armors": armors, "healing": heals}, "suroi/gear.json",
                 f"{len(armors)} armour pieces and {len(heals)} healing items, upstream numbers")

    # Keep the source form of those tables next to the derived JSON: the licence's
    # "preferred form for modification" for a parsed table is the file it was parsed from.
    for rel in ("items/guns.ts", "items/armors.ts", "items/healingItems.ts", "bullets.ts"):
        src = os.path.join(defs, rel)
        if os.path.exists(src):
            c.copy(src, "suroi/definitions/" + os.path.basename(rel),
                   "upstream definition source, kept as the source form of the parsed tables")

    # ---- art -----------------------------------------------------------------------
    def png(src, dst_rel, width, note):
        dst = os.path.join(VENDOR, dst_rel)
        if _svg_png(src, dst, width):
            c.emit(src, dst_rel, note)

    wdir = os.path.join(art, "weapons")
    for f in sorted(os.listdir(wdir)):
        if not f.endswith(".svg") or SEASONAL.search(f):
            continue
        base = f[:-4]
        world = base.endswith("_world")
        png(os.path.join(wdir, f), f"suroi/guns/{base}.png",
            int(gun_px * 0.55) if world else gun_px,
            "gun world sprite" if world else "gun loot sprite")

    ldir = os.path.join(art, "loot")
    if os.path.isdir(ldir):
        for f in sorted(os.listdir(ldir)):
            if f.endswith(".svg") and not SEASONAL.search(f):
                png(os.path.join(ldir, f), f"suroi/loot/{f[:-4]}.png", loot_px, "loot icon")

    bdir = os.path.join(art, "buildings")
    used_pois = []
    if os.path.isdir(bdir):
        have = set(os.listdir(bdir))
        for poi in SUROI_POIS:
            if poi not in have:
                continue
            pdir = os.path.join(bdir, poi)
            if not os.path.isdir(pdir):
                continue
            n = 0
            for root, _, files in os.walk(pdir):
                for f in sorted(files):
                    if not f.endswith(".svg") or SEASONAL.search(f):
                        continue
                    rel = os.path.relpath(os.path.join(root, f), bdir).replace(os.sep, "/")
                    png(os.path.join(root, f), "suroi/buildings/" + rel[:-4] + ".png",
                        building_px, f"structure art ({poi})")
                    n += 1
            if n:
                used_pois.append({"id": poi, "files": n})

    odir = os.path.join(art, "obstacles")
    props = []
    if os.path.isdir(odir):
        # One directory per prop; each holds a couple of state sprites (intact / broken / open).
        dirs = sorted(d for d in os.listdir(odir)
                      if os.path.isdir(os.path.join(odir, d)) and not SEASONAL.search(d)
                      and any(w in d for w in SUROI_PROP_WORDS))
        for name in dirs[:max_props]:
            pdir = os.path.join(odir, name)
            svgs = sorted(f for f in os.listdir(pdir)
                          if f.endswith(".svg") and not SEASONAL.search(f))
            broken = [s for s in svgs if "broken" in s or "open" in s][:1]
            keep = [s for s in svgs if s not in broken][:2] + broken
            for f in keep:
                png(os.path.join(pdir, f), f"suroi/props/{name}/{f[:-4]}.png",
                    prop_px, "prop / cover sprite")
            props.append(name)

    fdirs = [("particles", fx_px), ("projectiles", fx_px), ("player", fx_px),
             ("indicators", fx_px), ("airdrop", max(fx_px, 96))]
    for sub, width in fdirs:
        sdir = os.path.join(art, sub)
        if not os.path.isdir(sdir):
            continue
        for root, _, files in os.walk(sdir):
            for f in sorted(files):
                if not f.endswith(".svg") or SEASONAL.search(f):
                    continue
                rel = os.path.relpath(os.path.join(root, f), art).replace(os.sep, "/")
                png(os.path.join(root, f), "suroi/" + rel[:-4] + ".png", width, f"{sub} art")

    # ---- audio ---------------------------------------------------------------------
    gaudio = os.path.join(repo, "client/public/audio/game/shared")
    sfx = 0
    if os.path.isdir(gaudio):
        picked = []
        # Weapon sounds first: every gun's fire / reload / switch sample is kept, so the
        # ballistics tables and the audio come from the same 69-gun set.
        wdir = os.path.join(gaudio, "weapons")
        if os.path.isdir(wdir):
            for f in sorted(os.listdir(wdir)):
                if f.endswith(".mp3") and not SEASONAL.search(f):
                    picked.append(os.path.join(wdir, f))
        for sub in SUROI_SFX_DIRS:
            if sub == "weapons":
                continue
            sdir = os.path.join(gaudio, sub)
            if os.path.isdir(sdir):
                for f in sorted(os.listdir(sdir)):
                    if f.endswith(".mp3") and not SEASONAL.search(f):
                        picked.append(os.path.join(sdir, f))
            elif os.path.exists(os.path.join(gaudio, sub + ".mp3")):
                picked.append(os.path.join(gaudio, sub + ".mp3"))
        for src in picked[:max_sfx]:
            name = os.path.splitext(os.path.basename(src))[0]
            dst_rel = f"suroi/sfx/{name}.opus"
            if audio_to_opus(src, os.path.join(VENDOR, dst_rel)):
                c.emit(src, dst_rel, "sound effect, re-encoded to Opus")
                sfx += 1
    music_dir = os.path.join(repo, "client/public/audio/music")
    if os.path.isdir(music_dir) and os.path.exists(os.path.join(music_dir, "menu_music.mp3")):
        src = os.path.join(music_dir, "menu_music.mp3")
        dst_rel = "suroi/audio/menu_music.opus"
        if audio_trim(src, os.path.join(VENDOR, dst_rel), seconds=75):
            c.emit(src, dst_rel, "menu music, first 75 s, re-encoded to Opus")

    c.write_json({
        "pois": used_pois,
        "props": props,
        "sfx": sfx,
        "note": "index of the structure art, cover props and sounds imported for Stormforge",
    }, "suroi/index.json", "manifest of the structure/prop/sound art shipped for this title")
    return c, None


IMPORTERS = [
    ("three", import_three),
    ("suroi", import_suroi),
    ("endless-sky", import_endless_sky),
    ("mindustry", import_mindustry),
    ("luanti", import_luanti),
    ("shattered-pixel-dungeon", import_spd),
    ("unciv", import_unciv),
    ("cataclysm-dda", import_cataclysm),
    ("stk-assets", import_stk),
    ("flare-game", import_flare_game),
    ("dcss", import_dcss),
    ("wesnoth", import_wesnoth),
]


# ---------------------------------------------------------------- sync / check

def sync():
    """Rebuild vendor/ from the donor trees, carrying forward sources that are not here.

    Importers write into a staging tree first. If a donor's mirror is missing (they live
    outside this repo and can be re-cloned anywhere), that source's previously vendored
    files are carried forward untouched instead of vanishing from the bundle — a rebuild
    must never silently drop a payload that shipped yesterday.
    """
    global VENDOR
    real = VENDOR
    prev = {"sources": {}, "files": []}
    if os.path.exists(MANIFEST):
        try:
            prev = json.load(open(MANIFEST, encoding="utf-8"))
        except Exception:
            pass
    stage = real + ".new"
    shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(stage, exist_ok=True)
    VENDOR = stage

    manifest = {"generated_by": "tools/vendor.py", "sources": {}, "files": []}
    skipped = []
    try:
        for name, fn in IMPORTERS:
            cfg = SOURCES[name]
            collector, err = fn()
            if collector is None:
                print(f"  {name}: skipped ({err})")
                skipped.append(name)
                continue
            manifest["files"].extend(collector.files)
            src_dir = os.path.join(VENDOR, name)
            os.makedirs(src_dir, exist_ok=True)

            lf = os.path.join(cfg["path"], cfg["license_file"])
            if os.path.exists(lf):
                dst = os.path.join(src_dir, "LICENSE-" + os.path.basename(cfg["license_file"]))
                shutil.copyfile(lf, dst)
                manifest["files"].append({
                    "path": os.path.relpath(dst, VENDOR), "source_path": cfg["license_file"],
                    "source_repo": name, "commit": collector.commit, "license": cfg["license"],
                    "bytes": os.path.getsize(dst), "sha256": sha256(dst),
                    "note": "upstream licence text",
                })

            with open(os.path.join(src_dir, "ATTRIBUTION.md"), "w", encoding="utf-8") as f:
                f.write(f"# {name}\n\n")
                f.write(f"- Upstream: {cfg['url']}\n")
                f.write(f"- Pinned commit: `{collector.commit}`\n")
                f.write(f"- Licence: {cfg['license']}\n")
                f.write(f"- Credit: {cfg['credit']}\n")
                f.write(f"- Files imported: {len(collector.files)}\n\n")
                f.write("Everything in this directory is upstream work, redistributed under the licence\n")
                f.write("above. The collection's own code is MIT; see `docs/LICENSING.md` for how the two\n")
                f.write("licences coexist and what that means if you redistribute.\n")
                f.write("\nFull per-file provenance is in `vendor/MANIFEST.json`.\n")

            manifest["sources"][name] = {
                "commit": collector.commit,
                "license": cfg["license"],
                "url": cfg["url"],
                "files": len(collector.files),
                "bytes": sum(f["bytes"] for f in collector.files),
            }
            print(f"  {name}: {len(collector.files)} files, "
                  f"{sum(f['bytes'] for f in collector.files) / 1e6:.1f} MB @ {collector.commit[:10]}")
    finally:
        VENDOR = real

    for name in skipped:
        src_dir = os.path.join(real, name)
        if not os.path.isdir(src_dir):
            print(f"  {name}: skipped and never vendored before — nothing to carry")
            continue
        shutil.copytree(src_dir, os.path.join(stage, name), dirs_exist_ok=True)
        carried = [f for f in prev.get("files", []) if f["path"].split("/")[0] == name]
        manifest["files"].extend(carried)
        if name in prev.get("sources", {}):
            manifest["sources"][name] = prev["sources"][name]
        print(f"  {name}: carried forward {len(carried)} files from the previous build")

    # One classic-script bundle: the games run from file://, where fetch() of a local
    # JSON file is blocked, so every table ships as JS and the service worker can
    # importScripts() it to learn the asset list.
    tables, assets = {}, []
    for f in manifest["files"]:
        rel = f["path"]
        full = os.path.join(stage, rel)
        if not os.path.exists(full):
            continue
        if rel.endswith(".json"):
            try:
                tables[rel[:-5]] = json.load(open(full, encoding="utf-8"))
            except Exception:
                pass
        elif rel.endswith((".png", ".opus")):
            assets.append("vendor/" + rel)

    bundle = {"sources": manifest["sources"], "assets": sorted(assets), "data": tables}
    js_path = os.path.join(stage, "vendor.js")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("/* Generated by tools/vendor.py — do not edit.\n")
        f.write(" * Upstream work, vendored with provenance; see vendor/MANIFEST.json and\n")
        f.write(" * docs/LICENSING.md. Each table carries its source's licence. */\n")
        f.write("(function (g) {\n  g.AOMG_VENDOR = ")
        json.dump(bundle, f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n})(typeof window !== 'undefined' ? window : self);\n")
    manifest["files"].append({
        "path": "vendor.js", "source_path": "generated from the tables above",
        "source_repo": "generated", "commit": "-", "license": "mixed — see docs/LICENSING.md",
        "bytes": os.path.getsize(js_path), "sha256": sha256(js_path),
        "note": f"{len(tables)} tables, {len(assets)} asset paths",
    })
    print(f"vendor/vendor.js: {len(tables)} tables, {len(assets)} assets, "
          f"{os.path.getsize(js_path) / 1e3:.0f} KB")

    # swap the staging tree in
    shutil.rmtree(real, ignore_errors=True)
    shutil.move(stage, real)

    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    total = sum(f["bytes"] for f in manifest["files"])
    print(f"\nvendor/: {len(manifest['files'])} files, {total / 1e6:.1f} MB, "
          f"{len(manifest['sources'])} sources")


def check() -> int:
    if not os.path.exists(MANIFEST):
        print("FAIL: vendor/MANIFEST.json missing — run python3 tools/vendor.py sync")
        return 1
    man = json.load(open(MANIFEST))
    bad, missing = [], []
    for f in man["files"]:
        p = os.path.join(VENDOR, f["path"])
        if not os.path.exists(p):
            missing.append(f["path"])
            continue
        if os.path.getsize(p) != f["bytes"] or sha256(p) != f["sha256"]:
            bad.append(f["path"])

    on_disk = set()
    for dirpath, _, files in os.walk(VENDOR):
        for fn in files:
            on_disk.add(os.path.relpath(os.path.join(dirpath, fn), VENDOR))
    tracked = {f["path"] for f in man["files"]} | {"MANIFEST.json"}
    extra = sorted(p for p in on_disk - tracked if not p.endswith("ATTRIBUTION.md"))

    print(f"vendored sources: {', '.join(sorted(man['sources']))}")
    for name, s in sorted(man["sources"].items()):
        print(f"  {name:26s} {s['files']:4d} files  {s['bytes'] / 1e6:6.2f} MB  {s['license']}")
    print(f"  {'TOTAL':26s} {len(man['files']):4d} files  "
          f"{sum(f['bytes'] for f in man['files']) / 1e6:6.2f} MB")

    for label, lst in (("tampered", bad), ("missing", missing)):
        for p in lst:
            print(f"FAIL: {label}: {p}")
    for p in extra:
        print(f"FAIL: untracked file in vendor/: {p}")
    if bad or missing or extra:
        return 1
    print(f"vendor in sync ({len(man['files'])} files verified by size + sha256)")
    return 0


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(check())
    sync()
