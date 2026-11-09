#!/usr/bin/env python3
"""Render the free-phone-games catalog into a static site (single self-contained page).

Reads the repo's own artifacts — GAMES.queue (what we swept) and CATALOG.md (what a
desk/emulator judge scored) — and emits:

  <out>/index.html   self-contained: inline JSON + styles + JS, no network calls
  <out>/games.json   the same data, for anything that wants it programmatically

No filters or scoring happen here. Whatever build-queue.py decided is in the queue is
in the page; whatever CATALOG.md scored is a judged entry. This script only renders.

Usage:
  scripts/make-catalog-site.py [--out DIR] [--src DIR]
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from concurrent import futures
from typing import Any
from datetime import datetime, timezone
from pathlib import Path

QUEUE_FILE = "GAMES.queue"
CATALOG_FILE = "CATALOG.md"

# Sources the queue can carry. "github" rows may be suffixed +github when they also
# matched a curated list; normalise that away for grouping.
SOURCE_LABEL = {
    "fdroid": "F-Droid",
    "github": "GitHub sweep",
    "curated": "Curated",
}


def norm(s: str) -> str:
    """Loose key for matching a judged display name to a queue slug."""
    s = re.sub(r"\([^)]*\)", " ", s)          # drop parentheticals: "Luanti (Minetest)"
    s = re.sub(r"[^a-z0-9]+", "", s.lower())
    return s


def tokens(s: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", s.lower()) if t}


def git_remote(path: Path) -> str:
    """Upstream URL of a local clone, if it has one. Never raises."""
    import subprocess

    try:
        r = subprocess.run(
            ["git", "-C", str(path), "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        url = (r.stdout or "").strip()
    except (OSError, subprocess.SubprocessError):
        return ""
    if not url:
        return ""
    url = re.sub(r"\.git$", "", url)
    # git@github.com:owner/repo -> https://github.com/owner/repo
    m = re.match(r"git@([^:]+):(.+)$", url)
    if m:
        url = f"https://{m.group(1)}/{m.group(2)}"
    return url


def clone_dirs(src: Path) -> dict[str, Path]:
    """Every cloned game under games/ — the judges' working copies."""
    d = src / "games"
    out = {}
    if not d.is_dir():
        return out
    for p in d.iterdir():
        if p.is_dir() and not p.name.startswith("_"):
            out[p.name] = p
    return out


def resolve_clone(display: str, slug: str, dirs: dict[str, Path]) -> str:
    """Best local clone directory for a judged row, or ''.

    Judges write the display name and often no slug, so match on: exact slug, exact
    normalised name, then token containment. Anything ambiguous stays unmatched —
    a wrong link is worse than no link.
    """
    if slug and slug in dirs:
        return slug
    nd = norm(display or slug)
    if not nd:
        return ""
    for name in dirs:
        if norm(name) == nd:
            return name
    dt = tokens(display or slug)
    best, best_score = "", 0.0
    for name in dirs:
        nt = tokens(name)
        if not nt:
            continue
        inter = len(dt & nt)
        if not inter:
            continue
        score = inter / len(nt | dt)
        if len(nt) <= len(dt) and nt <= dt:
            score += 0.25
        if score > best_score:
            best, best_score = name, score
    # Require a real overlap; a single shared word is not an identification.
    if best_score >= 0.6 and len(tokens(best) & dt) >= 1 and (
        len(tokens(best)) > 1 or len(tokens(best)) == len(dt)
    ):
        return best
    return ""


def read_queue(src: Path) -> list[dict]:
    p = src / QUEUE_FILE
    if not p.exists():
        sys.exit(f"missing {p}")
    rows = []
    with p.open(encoding="utf-8") as fh:
        header = fh.readline()
        cols = header.lstrip("# ").rstrip("\n").split("\t")
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 6:
                continue
            rec = dict(zip(cols, parts))
            src_tag = (rec.get("source") or "").replace("+github", "").strip()
            try:
                stars = int(rec.get("stars") or 0)
            except ValueError:
                stars = 0
            try:
                size_kb = int(rec.get("est_size_kb") or 0)
            except ValueError:
                size_kb = 0
            rows.append(
                {
                    "slug": rec.get("name", "").strip(),
                    "url": (rec.get("url") or "").strip(),
                    "stars": stars,
                    "license": (rec.get("license") or "").strip(),
                    "size_kb": size_kb,
                    "source": src_tag,
                    "summary": (rec.get("summary") or "").strip(),
                }
            )
    return rows


def read_catalog(src: Path) -> list[dict]:
    p = src / CATALOG_FILE
    if not p.exists():
        sys.exit(f"missing {p}")
    out = []
    row_re = re.compile(r"^\|\s*(\d+)\s*\|")
    for line in p.read_text(encoding="utf-8").splitlines():
        if not row_re.match(line):
            continue
        # Split on pipes, but the content may contain escaped pipes; CATALOG.md rows
        # never do, so a plain split is faithful to the source.
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 6:
            continue
        num, name, typ, score, platforms, status = cells[:6]
        name = name.replace("**", "").strip()
        # Judged names are "Display (slug)" or "Display (`slug`)" or plain display.
        m = re.search(r"\(`?([A-Za-z0-9._-]+)`?\)\s*$", name)
        slug = m.group(1) if m else ""
        display = re.sub(r"\s*\(`?[A-Za-z0-9._-]+`?\)\s*$", "", name).strip()
        score_num = None
        sm = re.search(r"\*{0,2}(\d+(?:\.\d+)?)\*{0,2}", score.replace("_desk_", ""))
        if sm:
            try:
                score_num = float(sm.group(1))
            except ValueError:
                score_num = None
        out.append(
            {
                "row": int(num),
                "display": display,
                "slug": slug,
                "type": typ.replace("**", "").strip(),
                "score": score_num,
                "score_raw": score,
                "desk_only": "_desk_" in score or "desk audit" in status.lower(),
                "platforms": platforms,
                "status": status,
            }
        )
    return out


def icon_map(src: Path) -> dict[str, str]:
    """Map many spellings of a game to its F-Droid icon URL.

    F-Droid icons are the actual game art, so they win over avatars. Judged rows in
    CATALOG.md are keyed by display name alone, so register the repo slug, the F-Droid
    display name and the package id under the same loose key.
    """
    out: dict[str, str] = {}
    p = src / ".queue" / "fdroid-games.json"
    if p.exists():
        try:
            for slug, v in json.loads(p.read_text(encoding="utf-8")).items():
                pid = (v or {}).get("pid")
                if not pid:
                    continue
                url = f"https://f-droid.org/repo/{pid}/en-US/icon.png"
                for k in (slug, (v or {}).get("name", ""), pid):
                    if k:
                        out.setdefault(norm(k), url)
        except (ValueError, OSError):
            pass
    return out


def repo_key(url: str) -> str:
    m = re.match(r"https?://(?:www\.)?[^/]+/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+?)(?:\.git)?/?$", url or "")
    return norm(f"{m.group(1)}/{m.group(2)}") if m else ""


def avatar(url: str) -> str:
    m = re.match(r"https?://(?:www\.)?github\.com/([A-Za-z0-9._-]+)/", url or "")
    return f"https://github.com/{m.group(1)}.png?size=160" if m else ""


def pick_icon(icons: dict[str, str], *keys: str) -> str:
    for k in keys:
        if k and (ic := icons.get(norm(k))):
            return ic
    return ""


def load_play_links(src: Path) -> dict[str, Any]:
    """`.queue/play-links.json` from collect-play-links.py, plus the hand-checked overrides.

    Absent files simply mean no play CTA — the page still renders, just without the buttons.
    """
    out: dict[str, Any] = {"byUrl": {}, "byName": {}}
    path = src / ".queue" / "play-links.json"
    if path.exists():
        try:
            out.update(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            pass
    overrides = src / "scripts" / "play-overrides.json"
    if overrides.exists():
        try:
            extra = {k: v for k, v in json.loads(overrides.read_text(encoding="utf-8")).items()
                     if not k.startswith("_")}
            out["byName"].update({norm_game_name(k): v for k, v in extra.items()})
        except (OSError, json.JSONDecodeError, AttributeError):
            pass
    return out


def attach_play(entries: list[dict], links: dict[str, Any]) -> dict[str, int]:
    """Give each entry its play destination. Nothing is invented — no match means no link.

    Lookup order: the upstream URL, then the game's normalised *name* (which is how the judged
    CATALOG.md rows — no URL, clone long gone — still get a real install page).
    """
    by_url = links.get("byUrl") or {}
    by_name = links.get("byName") or {}
    counts: dict[str, int] = {}
    for e in entries:
        hit = by_url.get(norm_url(e.get("url") or "")) or by_name.get(norm_game_name(e["name"]))
        if hit:
            e["play"] = hit["play"]
            e["play_kind"] = hit.get("kind", "web")
            e["play_label"] = hit.get("label", "Open")
            counts[e["play_kind"]] = counts.get(e["play_kind"], 0) + 1
    return counts


def load_playables(src: Path) -> list[dict]:
    """Everything we can hand the visitor to actually play, in the browser, right now.

    Two lanes: `arcade/arcade.json` is our own three.js ports (shipped from the site repo,
    one file per game), `.queue/playable.json` is the allow-listed mirrors of upstream
    static builds (written by promote-web-games.py). Neither is inferred from a README —
    a game is listed here only after it has been opened in a real browser and played.
    """
    items: list[dict] = []
    man = src / "arcade" / "arcade.json"
    if man.is_file():
        try:
            for g in json.loads(man.read_text()).get("games", []):
                keys = {strict_name(g.get("name", ""))}
                keys |= {strict_name(m) for m in g.get("match", [])}
                keys |= {strict_name(g.get("slug", ""))}
                items.append({
                    "keys": {k for k in keys if k},
                    "name": g.get("name", ""),
                    "slug": g.get("slug", ""),
                    "url": g["entry"],
                    "tier": "first-party",
                    "blurb": g.get("blurb", ""),
                })
        except (OSError, ValueError, KeyError) as e:
            print(f"  ! arcade manifest unreadable: {e}", file=sys.stderr)
    mirrored = src / ".queue" / "playable.json"
    if mirrored.is_file():
        try:
            for it in json.loads(mirrored.read_text()).get("items", []):
                items.append({
                    "keys": {strict_name(it.get("name", "")), strict_name(it.get("slug", ""))} - {""},
                    "name": it.get("name", ""),
                    "slug": it.get("slug", ""),
                    "url": it["entry"],
                    "tier": "mirrored",
                    "blurb": "",
                })
        except (OSError, ValueError, KeyError) as e:
            print(f"  ! playable manifest unreadable: {e}", file=sys.stderr)
    return items


def strict_name(name: str) -> str:
    """Whole-title key: keeps parentheticals so lookalike apps stay distinct."""
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def pretty_name(name: str) -> str:
    """Card title for a build whose repo name is a slug ("Tessel-A-tile-game"). Only used for
    synthesised cards — a real title from the queue or the catalog always wins."""
    name = (name or "").strip()
    if not name or name != re.sub(r"\s+", " ", name) or " " in name:
        return name
    parts = re.split(r"[-_]+", name)
    if len(parts) < 2:
        return name[:1].upper() + name[1:]
    return " ".join(p[:1].upper() + p[1:] for p in parts if p)


def attach_playable(entries: list[dict], playables: list[dict]) -> dict[str, int]:
    """Tag the queue rows that have an in-browser build, so the grid can rank them first.

    Match on normalised name and slug only: a card must never claim "playable" because a
    fuzzy score liked the title. Unmatched titles keep their external play link and sit lower.
    """
    index: dict[str, dict] = {}
    for it in playables:
        for k in it["keys"]:
            index.setdefault(k, it)
    counts = {"playable": 0, "first_party": 0, "mirrored": 0, "added": 0}
    used: set[int] = set()
    for e in entries:
        # Strict key: the full title, parentheticals included, so "2048 (Privacy Friendly)"
        # never inherits our 2048 port. Slug is the fallback for renamed judge rows.
        hit = index.get(strict_name(e.get("name", "")))
        if hit is None and e.get("slug"):
            hit = index.get(strict_name(e["slug"]))
        if hit is None:
            continue
        e["playable"] = {"url": hit["url"], "tier": hit["tier"], "blurb": hit["blurb"]}
        used.add(id(hit))
        counts["playable"] += 1
        counts["first_party" if hit["tier"] == "first-party" else "mirrored"] += 1

    # A game we can hand someone today must not be invisible just because no judge ever
    # scored it: clones that never made the queue get their own row.
    for it in playables:
        if id(it) in used:
            continue
        counts["added"] += 1
        counts["playable"] += 1
        counts["first_party" if it["tier"] == "first-party" else "mirrored"] += 1
        entries.append({
            "name": pretty_name(it["name"]),
            "slug": it.get("slug") or strict_name(it["name"]),
            "judged": False,
            "score": None,
            "score_raw": "",
            "type": "browser · three.js" if it["tier"] == "first-party" else "browser build",
            "platforms": "web",
            "summary": it["blurb"] or "Runs in the browser — no install, no emulator.",
            "license": "",
            "stars": 0,
            "size_kb": 0,
            "icon": "",
            "status": "",
            "url": it.get("url_src", ""),
            "play": None,
            "play_kind": None,
            "play_label": None,
            "desk_only": False,
            "row": None,
            "source": "curated",
            "playable": {"url": it["url"], "tier": it["tier"], "blurb": it["blurb"]},
        })
    return counts


def norm_game_name(name: str) -> str:
    s = re.sub(r"\([^)]*\)", " ", name or "").split("—")[0]
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def norm_url(url: str) -> str:
    u = (url or "").strip().rstrip("/")
    if u.endswith(".git"):
        u = u[:-4]
    p = urlsplit(u)
    if not p.netloc:
        return u.lower()
    host = p.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    return f"{host}{p.path.rstrip('/')}".lower()


def materialize_icons(entries: list[dict], cache: Path, thumbs: Path) -> dict[str, int]:
    """Copy each remote thumbnail into the site as /thumbs/<hash>.<ext>.

    Two reasons this beats hotlinking: the gate's Content-Security-Policy only allows
    `img-src 'self'` (so a hotlinked icon is a CSP violation the day report mode becomes
    enforce), and the page then renders at full speed with no dependency on f-droid.org or
    github.com being reachable from whoever is looking. Downloads are cached by URL hash, so
    a daily run only fetches what is new.
    """
    def sniff(b: bytes) -> str:
        if b[:8] == b"\x89PNG\r\n\x1a\n":
            return ".png"
        if b[:3] == b"\xff\xd8\xff":
            return ".jpg"
        if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
            return ".webp"
        if b[:6] in (b"GIF87a", b"GIF89a"):
            return ".gif"
        if b[:5] == b"<?xml" or b"<svg" in b[:400]:
            return ".svg"
        return ".png"

    def fetch(url: str) -> tuple[str, bytes]:
        req = urllib.request.Request(url, headers={"User-Agent": "rdw-games-site/1"})
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return url, r.read()
        except (urllib.error.URLError, TimeoutError, OSError):
            return url, b""

    cache.mkdir(parents=True, exist_ok=True)
    thumbs.mkdir(parents=True, exist_ok=True)
    remote = sorted({e["icon"] for e in entries if (e["icon"] or "").startswith("http")})
    name_of: dict[str, str] = {}
    fetched = cached = failed = 0

    def name_for(url: str) -> str:
        return hashlib.sha256(url.encode()).hexdigest()[:16]

    with futures.ThreadPoolExecutor(max_workers=16) as ex:
        for url, blob in ex.map(fetch, remote):
            if not blob:
                failed += 1
                continue
            dest = cache / (name_for(url) + sniff(blob))
            if dest.exists() and dest.stat().st_size == len(blob):
                cached += 1
            else:
                dest.write_bytes(blob)
                fetched += 1
            name_of[url] = dest.name

    for e in entries:
        icon = e["icon"] or ""
        if icon in name_of:
            e["icon"] = "/thumbs/" + name_of[icon]
    scaled = 0
    for name in set(name_of.values()):
        src = cache / name
        dest = thumbs / name
        if name.endswith((".png", ".jpg", ".webp")):
            try:
                from PIL import Image
                with Image.open(src) as im:
                    im.load()
                    # 128px is 2x the 64px tile, so it stays crisp on a hidpi screen and the
                    # whole set ships in a few MB instead of 40.
                    im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
                    im.thumbnail((128, 128), Image.LANCZOS)
                    im.save(dest, optimize=True)
                scaled += 1
                continue
            except Exception:  # noqa: BLE001 - any decode failure just ships the original
                pass
        shutil.copy2(src, dest)
    return {"remote": len(remote), "fetched": fetched, "cached": cached, "failed": failed,
            "scaled": scaled, "local": sum(1 for e in entries if (e["icon"] or "").startswith("/thumbs/"))}


def verify_icons(entries: list[dict], workers: int = 16) -> dict[str, int]:
    """Drop F-Droid icon URLs that 404 so the card falls back to an avatar or letter tile.

    About a fifth of F-Droid package ids no longer serve `en-US/icon.png` (archived or
    never had artwork); an unverified `<img>` there renders as a broken-image glyph in the
    browser, which is exactly what we are getting rid of. Only hard 404/410 downgrades —
    a network error leaves the URL alone so a flaky run doesn't blank the page.
    """
    def head(url: str) -> int:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "rdw-games-site/1"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code
        except (urllib.error.URLError, TimeoutError, OSError):
            return 0

    todo = sorted({e["icon"] for e in entries if "f-droid.org" in (e["icon"] or "")})
    if not todo:
        return {"checked": 0, "dropped": 0}
    dead: set[str] = set()
    with futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for url, code in zip(todo, ex.map(head, todo)):
            if code in (404, 410):
                dead.add(url)
    dropped = 0
    for e in entries:
        if e["icon"] in dead:
            e["icon"] = avatar(e["url"])
            dropped += 1
    return {"checked": len(todo), "dropped": dropped}


def merge(queue: list[dict], catalog: list[dict], dirs: dict[str, Path], icons: dict[str, str]) -> tuple[list[dict], int]:
    # CATALOG.md can carry two rows for one game (OpenTTD has both a curated row and a
    # queue-derived row). One game is one card, so keep the best-rated row per slug and
    # let the header count report what was folded.
    best_row: dict[str, dict] = {}
    for c in catalog:
        key = norm(c["slug"] or c["display"])
        prev = best_row.get(key)
        if prev is None or (c["score"] or -1) > (prev["score"] or -1):
            best_row[key] = c
    merged_catalog = list(best_row.values())
    superseded = len(catalog) - len(merged_catalog)
    catalog = merged_catalog

    by_key: dict[str, dict] = {}
    for q in queue:
        by_key.setdefault(norm(q["slug"]), q)

    entries = []
    used = set()
    for c in catalog:
        keys = [norm(c["slug"] or c["display"]), norm(c["display"])]
        clone = resolve_clone(c["display"], c["slug"], dirs)
        if clone:
            keys.append(norm(clone))
        q = next((by_key[k] for k in keys if k in by_key), None)
        if q:
            used.add(id(q))
        url = q["url"] if q else ""
        if not url and clone:
            url = git_remote(dirs[clone])
        slug = c["slug"] or (q["slug"] if q else (clone or ""))
        entries.append(
            {
                "name": c["display"],
                "slug": slug,
                "url": url,
                "icon": pick_icon(icons, slug, c["display"], repo_key(url)) or avatar(url),
                "stars": q["stars"] if q else 0,
                "license": q["license"] if q else "",
                "size_kb": q["size_kb"] if q else 0,
                "source": q["source"] if q else "",
                "summary": q["summary"] if q else "",
                "judged": True,
                "score": c["score"],
                "score_raw": c["score_raw"],
                "type": c["type"],
                "platforms": c["platforms"],
                "status": c["status"],
                "desk_only": c["desk_only"],
                "row": c["row"],
            }
        )
    for q in queue:
        if id(q) in used:
            continue
        entries.append(
            {
                "name": q["slug"],
                "slug": q["slug"],
                "url": q["url"],
                "icon": pick_icon(icons, q["slug"], repo_key(q["url"])) or avatar(q["url"]),
                "stars": q["stars"],
                "license": q["license"],
                "size_kb": q["size_kb"],
                "source": q["source"],
                "summary": q["summary"],
                "judged": False,
                "score": None,
                "score_raw": "",
                "type": "",
                "platforms": "",
                "status": "",
                "desk_only": False,
                "row": None,
            }
        )
    entries.sort(key=rank_key)
    return entries, superseded


def rank_key(e: dict) -> tuple:
    """Playable first — a game you can start right now beats a score. Then judged
    (highest score first), then the rest by stars."""
    p = e.get("playable") or {}
    return (
        0 if p.get("tier") == "first-party" else (1 if p else 2),
        0 if e["judged"] else 1,
        -(e["score"] or 0),
        -e["stars"],
        e["name"].lower(),
    )


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Free phone games — catalog</title>
<style>
:root{
  --bg:#0b0e14; --card:#141a24; --line:#243044; --ink:#e9f1ff; --dim:#8b9bb4;
  --accent:#7cf5d0; --gold:#ffd479;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;z-index:5;background:linear-gradient(180deg,rgba(11,14,20,.98),rgba(11,14,20,.92));border-bottom:1px solid var(--line);padding:14px 18px}
h1{margin:0;font-size:18px;letter-spacing:.2px}
h1 b{color:var(--accent)}
.tagline{margin:4px 0 0;color:#9fb0c8;font-size:12.5px;max-width:72ch}
.stats{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;color:var(--dim);font-size:13px}
.stats b{color:var(--ink)}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
input[type=search]{flex:1 1 260px;min-width:200px;background:#0f1520;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px 11px;font:inherit}
input[type=search]:focus{outline:2px solid rgba(124,245,208,.35);border-color:var(--accent)}
select,button{background:#0f1520;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px 11px;font:inherit;cursor:pointer}
button.on{border-color:var(--accent);color:var(--accent)}
main{padding:14px 18px 60px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(370px,1fr));gap:14px}
.card{position:relative;background:linear-gradient(180deg,#161d29,#121821);border:1px solid var(--line);border-radius:16px;padding:14px;display:grid;grid-template-columns:76px 1fr;gap:13px;align-items:start;transition:border-color .15s,transform .12s,box-shadow .15s}
.card:hover{border-color:#3a5a80}
.card.clickable:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(0,0,0,.38);border-color:#3f648f}
.card.clickable:hover h3 .n{color:var(--accent)}
.card.clickable:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px rgba(124,245,208,.22)}
.hit{position:absolute;inset:0;z-index:1;border-radius:16px}
.acts{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:7px;position:relative;z-index:2}
.cta{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;padding:6px 13px;border-radius:10px;text-decoration:none;border:1px solid transparent;letter-spacing:.2px;box-shadow:0 1px 0 rgba(255,255,255,.18) inset}
.cta.web{background:linear-gradient(180deg,#8fffdc,#4fdcb4);color:#062019}
.cta.store{background:linear-gradient(180deg,#8cc4ff,#5b9ff5);color:#06152b}
.cta.releases{background:transparent;border-color:rgba(255,212,121,.5);color:var(--gold);box-shadow:none}
.cta:hover{filter:brightness(1.08)}
.src{color:var(--dim);font-size:11.5px;text-decoration:none;border-bottom:1px dotted var(--line)}
.src:hover{color:var(--accent);border-color:var(--accent)}
.thumb-wrap{position:relative;width:76px;height:76px;border-radius:17px;overflow:hidden;background:#0d1219;border:1px solid var(--line);flex:0 0 auto;box-shadow:0 2px 10px rgba(0,0,0,.35)}
.thumb{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;transition:transform .18s}
.card.clickable:hover .thumb{transform:scale(1.06)}
.thumb.letter{display:flex;align-items:center;justify-content:center;font-weight:800;font-size:23px;letter-spacing:.4px;color:#08121a;background:linear-gradient(145deg,hsl(var(--h,265) 72% 70%),hsl(var(--h,265) 62% 50%))}
.body{min-width:0;display:flex;flex-direction:column;gap:5px}
.card h3{margin:0;font-size:15.5px;line-height:1.25;display:flex;gap:8px;align-items:flex-start;justify-content:space-between}
.card h3 .n{min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;transition:color .15s}
.card h3 a{color:inherit;text-decoration:none}
.card h3 a:hover{color:var(--accent)}
.score{flex:0 0 auto;font-size:13px;font-weight:800;color:var(--gold);white-space:nowrap;border:1px solid rgba(255,212,121,.35);background:rgba(255,212,121,.12);border-radius:9px;padding:1px 8px;font-variant-numeric:tabular-nums}
.score.mid{color:var(--accent);border-color:rgba(124,245,208,.35);background:rgba(124,245,208,.1)}
.score.lo{color:#a9b8cd;border-color:var(--line);background:none}
.score.norate{font-size:11px;font-weight:600;color:var(--dim);border-color:var(--line);background:none;padding:1px 7px}
.pill.play{color:#06211a;border-color:transparent;background:linear-gradient(180deg,#8fffdc,#4fdcb4);font-weight:800;letter-spacing:.3px}
.card.first{box-shadow:0 0 0 1px rgba(124,245,208,.35),0 18px 40px -24px rgba(124,245,208,.45)}
.cta.browser{background:linear-gradient(180deg,#8fffdc,#4fdcb4);color:#04211a;border-color:transparent;font-weight:800}
.cta.browser:hover{filter:brightness(1.06)}
.blurb{color:var(--accent);font-size:12px;margin:0 0 6px}
.meta{color:var(--dim);font-size:12px;display:flex;gap:6px;flex-wrap:wrap}
.pill{border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:11px;color:#a3b2c9;line-height:18px}
.pill.j{color:var(--accent);border-color:rgba(124,245,208,.4)}
.sum{color:#b9c7dc;font-size:13px;margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.type{color:#c3d2e6;font-size:12.5px;margin:0;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.more{background:none;border:1px solid var(--line);color:var(--dim);padding:2px 9px;border-radius:9px;font-size:11.5px;text-align:left;cursor:pointer}
.more:hover{color:var(--accent)}
.status{display:none;color:#a9b8cd;font-size:12px;border-top:1px dashed var(--line);padding-top:6px;white-space:pre-wrap;max-height:200px;overflow:auto}
.status.open{display:block}
.empty{color:var(--dim);padding:40px 0;text-align:center}
footer{color:var(--dim);font-size:12px;padding:0 18px 40px}
@media (prefers-color-scheme:light){
  :root{--bg:#f6f8fc;--card:#fff;--line:#dde5f0;--ink:#101826;--dim:#5b6a80;--accent:#0d8f74;--gold:#a57300}
  .sum{color:#33415a}.type{color:#2a3850}.status{color:#33415a}
}
</style>
</head>
<body>
<header>
  <h1>Free phone games <b>catalog</b></h1>
  <p class="tagline">Games you can start in the browser come first — our own three.js ports at the top, then verified static builds. Everything below opens the game itself: its own site, the F-Droid install page, or its releases. No dead links, no broken tiles.</p>
  <div class="stats" id="stats"></div>
  <div class="controls">
    <input id="q" type="search" placeholder="Search name, type, summary, license…" autocomplete="off" autofocus>
    <select id="src">
      <option value="">All sources</option>
      <option value="fdroid">F-Droid</option>
      <option value="github">GitHub sweep</option>
      <option value="curated">Curated</option>
    </select>
    <button id="judged" class="on">Judged only</button>
    <button id="sort">Sort: score</button>
  </div>
</header>
<main><div class="grid" id="grid"></div><div class="empty" id="empty" hidden>Nothing matches.</div></main>
<footer id="foot"></footer>
<script id="data" type="application/json">__DATA__</script>
<script>
const DATA = JSON.parse(document.getElementById('data').textContent);
const SRC = {fdroid:'F-Droid', github:'GitHub sweep', curated:'Curated'};
const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const stats = document.getElementById('stats');
const qEl = document.getElementById('q');
const srcEl = document.getElementById('src');
const judgedBtn = document.getElementById('judged');
judgedBtn.classList.remove('on');
judgedBtn.textContent = 'Everything';
const sortBtn = document.getElementById('sort');
let judgedOnly = false, sortMode = 'score';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtSize = kb => !kb ? '' : kb >= 1024 ? (kb/1024).toFixed(kb >= 10240 ? 0 : 1) + ' MB' : kb + ' KB';

stats.innerHTML = `<span><b>${DATA.total}</b> titles in the queue</span>
  <span><b>${DATA.judged}</b> judged</span>
  <span><b>${(DATA.playable && DATA.playable.playable) || 0}</b> play in browser</span>
  <span><b>${DATA.bySource.fdroid || 0}</b> F-Droid</span>
  <span><b>${DATA.bySource.github || 0}</b> GitHub sweep</span>
  <span><b>${DATA.bySource.curated || 0}</b> curated</span>
  <span>${DATA.playLinks && (DATA.playLinks.web||0)+(DATA.playLinks.store||0)+(DATA.playLinks.releases||0)} open the game</span>
  <span>built ${esc(DATA.built)}</span>`;

function rows(){
  const q = qEl.value.trim().toLowerCase();
  const src = srcEl.value;
  let r = DATA.entries.filter(e => {
    if (judgedOnly && !e.judged) return false;
    if (src && e.source !== src) return false;
    if (!q) return true;
    return (e.name + ' ' + e.type + ' ' + e.summary + ' ' + e.license + ' ' + e.slug).toLowerCase().includes(q);
  });
  if (sortMode === 'score') r.sort((a,b) => tier(a)-tier(b) || (b.score||0)-(a.score||0) || (b.stars||0)-(a.stars||0) || a.name.localeCompare(b.name));
  else if (sortMode === 'stars') r.sort((a,b) => (b.stars||0)-(a.stars||0) || a.name.localeCompare(b.name));
  else r.sort((a,b) => a.name.localeCompare(b.name));
  return r;
}

function tier(e){return e.playable ? (e.playable.tier === 'first-party' ? 0 : 1) : 2;}

function render(){
  const r = rows();
  empty.hidden = r.length > 0;
  // Every interpolated field below passes through esc() before it reaches the markup;
  // the only raw HTML here is this file's own template. 400+ cards is fine, but cap it anyway.
  grid.innerHTML = r.slice(0, 600).map((e,i) => {
    // The card opens the GAME, not the repo: `play` is the project site, the F-Droid install
    // page, or its release downloads, resolved by collect-play-links.py. The repo is demoted to
    // a small "source" link so it stays reachable without being the main action. A row with no
    // resolved play target and nothing but a forge URL stays unclickable — a card that dumps the
    // reader on GitHub is the bug this replaced, so don't reintroduce it as a fallback.
    const FORGES = ['github.com','gitlab.com','codeberg.org','git.sr.ht','bitbucket.org','sourceforge.net'];
    const onForge = !!e.url && FORGES.some(h => e.url.includes(h));
    const target = e.play || (e.url && !onForge ? e.url : '');
    const title = esc(e.name);
    const pills = [
      e.playable ? `<span class="pill play">${e.playable.tier === 'first-party' ? 'play · three.js' : 'play in browser'}</span>` : '',
      e.judged ? '<span class="pill j">judged</span>' : '<span class="pill">queued</span>',
      e.source ? `<span class="pill">${esc(SRC[e.source] || e.source)}</span>` : '',
      e.stars ? `<span class="pill">★ ${e.stars.toLocaleString()}</span>` : '',
      e.license ? `<span class="pill">${esc(e.license)}</span>` : '',
      e.size_kb ? `<span class="pill">${fmtSize(e.size_kb)}</span>` : ''
    ].join('');
    const sval = e.score != null ? Number(e.score) : null;
    const sclass = sval == null ? '' : sval >= 9 ? '' : sval >= 8 ? ' mid' : ' lo';
    const score = e.score != null ? `<span class="score${sclass}">${e.score}</span>`
      : (e.judged && e.score_raw ? `<span class="score norate">${esc(e.score_raw.replace(/[*_]/g,'').trim())}</span>` : '');
    // Thumbnail: real F-Droid art or the forge owner's avatar, with a letter tile underneath
    // so a dead image URL still shows something on-brand instead of a broken-image glyph.
    const initials = (e.name.replace(/[^A-Za-z0-9 ]/g,'').trim().split(' ').filter(Boolean).slice(0,2).map(w=>w[0]).join('') || e.name.slice(0,2)).toUpperCase();
    let hue = 0; for (const ch of e.name) hue = (hue*31 + ch.charCodeAt(0)) % 360;
    const thumb = `<div class="thumb-wrap"><span class="thumb letter" style="--h:${hue}">${esc(initials)}</span>`
      + (e.icon ? `<img class="thumb" src="${esc(e.icon)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '')
      + `</div>`;
    const desk = e.desk_only ? '<span class="pill">desk</span>' : '';
    const hit = target ? `<a class="hit" href="${esc(target)}" rel="noreferrer" aria-label="${esc(e.name)}${e.play_label ? ' — ' + esc(e.play_label) : ''}"></a>` : '';
    const icon = e.play_kind === 'web' ? '▶' : e.play_kind === 'store' ? '⤓' : '⤓';
    const cta = e.playable
      ? `<a class="cta browser" href="${esc(e.playable.url)}" rel="noreferrer">▶ Play</a>`
      : (e.play ? `<a class="cta ${esc(e.play_kind || 'web')}" href="${esc(e.play)}" rel="noreferrer">${icon} ${esc(e.play_label || 'Open')}</a>` : '');
    const srcLink = e.url && e.play ? `<a class="src" href="${esc(e.url)}" target="_blank" rel="noreferrer noopener">source</a>` : '';
    return `<article class="card${target ? ' clickable' : ''}${e.playable ? ' first' : ''}">${hit}${thumb}
      <div class="body">
        <h3><span class="n">${title}</span>${score}</h3>
        <div class="meta">${pills}${desk}</div>
        ${e.playable && e.playable.blurb ? `<p class="blurb">${esc(e.playable.blurb)}</p>` : ''}
        ${e.type ? `<p class="type">${esc(e.type)}</p>` : ''}
        ${e.summary ? `<p class="sum">${esc(e.summary.slice(0, 220))}${e.summary.length > 220 ? '…' : ''}</p>` : ''}
        <div class="acts">${cta}${srcLink}${e.status ? `<button class="more" data-i="${i}">evidence</button>` : ''}</div>
        ${e.status ? `<div class="status" id="s${i}">${esc(e.status)}</div>` : ''}
      </div>
    </article>`;
  }).join('');
  if (r.length > 600) grid.insertAdjacentHTML('beforeend', `<p class="sum">…and ${r.length - 600} more — narrow the search.</p>`);
  grid.querySelectorAll('button.more').forEach(b => b.onclick = () => {
    const el = document.getElementById('s' + b.dataset.i);
    el.classList.toggle('open');
    b.textContent = el.classList.contains('open') ? 'hide evidence' : 'evidence';
  });
}

qEl.oninput = render;
srcEl.onchange = render;
judgedBtn.onclick = () => { judgedOnly = !judgedOnly; judgedBtn.classList.toggle('on', judgedOnly); judgedBtn.textContent = judgedOnly ? 'Judged only' : 'Everything'; render(); };
sortBtn.onclick = () => { sortMode = sortMode === 'score' ? 'stars' : sortMode === 'stars' ? 'name' : 'score'; sortBtn.textContent = 'Sort: ' + sortMode; render(); };
document.getElementById('foot').textContent = 'Playable rows come from arcade/arcade.json (our three.js ports) and .queue/playable.json (allow-listed static mirrors, each opened and played in a real browser before shipping). Scores come from the repo artifacts (GAMES.queue / CATALOG.md); "source" is the upstream repo.';
render();
</script>
</body>
</html>
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site-out", help="output directory")
    ap.add_argument("--src", default=".", help="repo root holding GAMES.queue + CATALOG.md")
    ap.add_argument("--no-verify-icons", dest="verify_icons", action="store_false",
                    help="skip the F-Droid icon HEAD check (offline builds keep whatever the map says)")
    ap.add_argument("--icon-cache", default="", help="directory caching downloaded thumbnails by URL hash")
    args = ap.parse_args()

    src = Path(args.src).resolve()
    out = Path(args.out).resolve()
    queue = read_queue(src)
    catalog = read_catalog(src)
    dirs = clone_dirs(src)
    entries, superseded = merge(queue, catalog, dirs, icon_map(src))
    play_counts = attach_play(entries, load_play_links(src))
    playable_counts = attach_playable(entries, load_playables(src))
    entries.sort(key=rank_key)
    icons_checked: dict[str, Any] = verify_icons(entries) if args.verify_icons else {"checked": 0, "dropped": 0}
    if args.icon_cache:
        icons_checked["materialized"] = materialize_icons(
            entries, Path(args.icon_cache).expanduser(), out / "thumbs")

    judged = [e for e in entries if e["judged"]]
    by_source: dict[str, int] = {}
    for q in queue:
        by_source[q["source"]] = by_source.get(q["source"], 0) + 1

    payload = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "total": len(queue),
        "judged": len(judged),
        "unrated": sum(1 for e in judged if e["score"] is None),
        "supersededRows": superseded,
        "catalogRows": len(catalog),
        "bySource": by_source,
        "icons": icons_checked,
        "playLinks": play_counts,
        "playable": playable_counts,
        "entries": entries,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "games.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    # The JSON goes inside a <script type="application/json">, so escape the sequence
    # that would close it early.
    blob = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    (out / "index.html").write_text(PAGE.replace("__DATA__", blob), encoding="utf-8")
    print(f"wrote {out/'index.html'} + games.json — {len(queue)} queued, {len(judged)} judged"
          f"{f' ({superseded} duplicate catalog row(s) folded)' if superseded else ''}, {len(entries)} entries")


if __name__ == "__main__":
    main()
