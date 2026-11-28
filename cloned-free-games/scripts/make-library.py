#!/usr/bin/env python3
"""Render the playable game library face from .queue/library-audit.json.

This is the page that replaces the link-out catalog at the site root. The rule it
encodes (Michael, 2026-11-14): a tile exists only if clicking it plays a game in
this browser. Anything that downloads, installs, opens an APK, or leaves the page
is not a tile — it is queue material, shown only as a non-clickable count.

Every tile's art is generated here (inline SVG data URI, no network): a per-title
palette, a plate monogram and a patterned ground. That is deliberate — the old
catalog borrowed f-droid/GitHub avatars, which meant tiles could not render
offline and looked like a list of repos rather than a shelf of games.

    scripts/make-library.py --audit .queue/library-audit.json --out /tmp/library

Writes index.html (self-contained: inline CSS/JS, zero external requests) and
library.json (same tile data, machine-readable).
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import urllib.parse

from originals import load_releases

TIER_LABEL = {
    "first-party": "arcade",
    "mirror": "in-browser",
    "external": "embedded",
}
TIER_NOTE = {
    "first-party": "three.js port, made here",
    "mirror": "upstream static build, self-hosted",
    "external": "third-party page, verified embeddable",
}

# The KAOS registry stores the same shelf in two shapes; these are the ones a visitor
# can actually open today. Titles map to the deployed path (staged at the site root by
# deploy.sh, so "games/action/colossus/" is served at /games/action/colossus/).
SHELF_BADGE = {
    "rpg": "rpg",
    "action": "action",
    "shooter": "shooter",
    "sports": "sports",
    "battle": "strategy",
    "arcade": "arcade",
}
# Shatter World is playable behind this site's gate but has an unresolved IP-clearance
# review (games/CLEARANCE-shatterworld.md). It is listed as a beta build, never as a
# public release, and its repo stays private.
BETA_SLUGS = {"shatterworld", "shatterworld-next", "shatterworld-v3", "outbreak-preview"}


def _git_show(site_repo: str, path: str) -> str:
    """Read a file from the site repo's HEAD (the ref the publisher stages from), falling
    back to the working tree for a repo that has no git metadata."""
    import subprocess
    try:
        r = subprocess.run(["git", "-C", site_repo, "show", "HEAD:" + path],
                           capture_output=True, text=True, timeout=30)
        if r.returncode == 0 and r.stdout:
            return r.stdout
    except Exception:
        pass
    try:
        with open(os.path.join(site_repo, path), encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def kaos_shelf(site_repo: str) -> list[dict]:
    """The live rows of the KAOS registry (games/catalog.json), as door cards.

    This is the shelf the site has always had at /shelf/ — the studio builds (Shatter
    World, COLOSSUS, SOULS64, WEBCRAFT, KAOS, BLOCKSHOT, PARKCRAFT, EMBER VAULT) plus the
    OUTBREAK colony preview. The library face is built from the *clone* catalogue, which
    knows nothing about them, which is why the front page had no way in.
    """
    try:
        data = json.loads(_git_show(site_repo, "games/catalog.json") or "{}")
    except Exception:
        return []
    out = []
    for g in data.get("games", []):
        if g.get("status") != "live":
            continue
        path = (g.get("path") or "").strip("/")
        if not path:
            continue
        cat = g.get("category") or ""
        out.append({
            "title": g.get("title") or g.get("slug") or "untitled",
            "slug": g.get("slug") or "",
            "category": cat,
            "kicker": SHELF_BADGE.get(cat, cat or "shelf"),
            "url": "/" + path + "/",
            "desc": (g.get("description") or "").strip(),
            "beta": (g.get("slug") in BETA_SLUGS),
            "bytes": g.get("bytes") or 0,
        })
    # the strongest titles first: Shatter World builds, then the rest by size
    out.sort(key=lambda d: (0 if d["slug"].startswith("shatterworld") else 1,
                            -1 * (d["bytes"] or 0), d["title"].lower()))
    return out


def door_html(cards: list[dict]) -> str:
    if not cards:
        return ""
    tiles = []
    for c in cards:
        badge = c["kicker"] + (f' · {c["version"]}' if "version" in c else "")
        if c.get("beta"):
            badge += " · beta"
        preview = ""
        if "preview" in c:
            preview = (f'<img src="{html.escape(c["preview"])}" alt="{html.escape(c["preview_alt"])}" '
                       'width="640" height="360">')
        tiles.append(
            f'<a class="doorcard" href="{html.escape(c["url"])}">'
            f'{preview}<span class="k">{html.escape(badge)}</span>'
            f'<strong>{html.escape(c["title"])}</strong>'
            f'<span class="d">{html.escape(c["desc"][:150])}</span>'
            f'<span class="go">Play ▸</span></a>'
        )
    return "\n".join(tiles)



def hue(name: str) -> int:
    h = int(hashlib.sha256(name.encode("utf-8")).hexdigest()[:8], 16)
    return h % 360


def monogram(name: str) -> str:
    words = [w for w in "".join(c if c.isalnum() or c.isspace() else " " for c in name).split() if w]
    if not words:
        return "?"
    if len(words) == 1:
        w = words[0]
        return (w[0] + (w[1] if len(w) > 1 and w[0].isdigit() else "")).upper()
    return (words[0][0] + words[1][0]).upper()


def art_svg(name: str) -> str:
    """Deterministic tile art: hue wash, grid ground, monogram plate."""
    h = hue(name)
    h2 = (h + 42) % 360
    mono = html.escape(monogram(name))
    svg = f"""<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 260'>
<defs>
<linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
<stop offset='0' stop-color='hsl({h} 62% 26%)'/>
<stop offset='0.55' stop-color='hsl({h2} 55% 16%)'/>
<stop offset='1' stop-color='hsl({(h + 200) % 360} 45% 10%)'/>
</linearGradient>
<radialGradient id='r' cx='0.28' cy='0.18' r='0.85'>
<stop offset='0' stop-color='hsl({h} 90% 70%)' stop-opacity='0.42'/>
<stop offset='1' stop-color='hsl({h} 90% 40%)' stop-opacity='0'/>
</radialGradient>
<pattern id='p' width='26' height='26' patternUnits='userSpaceOnUse'>
<path d='M26 0H0V26' fill='none' stroke='hsl({h} 70% 80%)' stroke-opacity='0.10' stroke-width='1'/>
</pattern>
</defs>
<rect width='400' height='260' fill='url(#g)'/>
<rect width='400' height='260' fill='url(#p)'/>
<rect width='400' height='260' fill='url(#r)'/>
<g opacity='0.95'>
<rect x='140' y='92' width='120' height='96' rx='22' fill='hsl({h2} 45% 8%)' fill-opacity='0.55'
 stroke='hsl({h} 85% 72%)' stroke-opacity='0.55' stroke-width='2'/>
<text x='200' y='152' text-anchor='middle' font-family='ui-sans-serif,system-ui,sans-serif'
 font-size='46' font-weight='700' fill='hsl({h} 92% 88%)' letter-spacing='1'>{mono}</text>
</g>
<rect x='0.5' y='0.5' width='399' height='259' fill='none' stroke='hsl({h} 80% 70%)' stroke-opacity='0.25'/>
</svg>"""
    return "data:image/svg+xml;charset=utf-8," + urllib.parse.quote(svg, safe="")


def load(audit_path: str) -> dict:
    with open(audit_path, encoding="utf-8") as fh:
        return json.load(fh)


def slugify(s: str) -> str:
    return "".join(c if (c.isalnum() or c in "._-") else "-" for c in s) or "tile"


def arcade_titles(site_repo: str) -> dict:
    """stem -> display title for the arcade ports ('2048.html' -> '2048').

    The port's own <title> is the honest name of the thing that launches — a dozen
    clone cards can point at one port, and the clone names ('2048 Open Fun Game',
    '2048 (Privacy Friendly)') describe upstream repos, not the game the visitor plays.
    """
    import re
    import subprocess
    names = []
    try:
        r = subprocess.run(["git", "-C", site_repo, "ls-tree", "--name-only", "HEAD",
                            "games/arcade/"], capture_output=True, text=True, timeout=30)
        names = [l.split("/", 2)[-1] for l in r.stdout.splitlines()
                 if l.endswith(".html") and l.count("/") == 2]
    except Exception:
        names = []
    if not names:
        d = os.path.join(site_repo, "games", "arcade")
        if os.path.isdir(d):
            names = [f for f in os.listdir(d) if f.endswith(".html")]
    out = {}
    for fn in names:
        txt = _git_show(site_repo, "games/arcade/" + fn)
        m = re.search(r"<title[^>]*>(.*?)</title>", txt, re.S | re.I)
        title = re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
        title = re.sub(r"^(moved|redirect)\s*[·:\-—]\s*", "", title, flags=re.I).strip()
        if title:
            out[fn[:-5]] = title
    return out


def build_tiles(data: dict, art_dir: str = "", out_dir: str = "",
                titles: dict | None = None) -> list[dict]:
    """Tiles from the audit's live entries, ONE TILE PER LAUNCH TARGET.

    The catalogue is keyed by source repository, so several cards can launch the same
    file (three '2048' cards -> one 2048.html, seven sudoku cards -> one sudoku.html).
    Rendering one tile per card made the shelf look like a catalogue of repos with the
    same game repeated. Here the launch URL is the identity: the best card names the
    tile, the rest are folded under it as `sources` (nothing is dropped — the data all
    still ships in games.json/library.json).

    Art priority: a real screenshot captured by scripts/lib-art.mjs (--art), else the
    generated monogram plate."""
    tiles: list[dict] = []
    shots = set()
    if art_dir and os.path.isdir(art_dir):
        shots = {f for f in os.listdir(art_dir) if f.lower().endswith(".png")}
    titles = titles or {}

    groups: dict[str, list[dict]] = {}
    for row in data.get("entries_live", []):
        launch = (row.get("launch") or "").strip()
        if not launch:
            continue
        groups.setdefault(launch, []).append(row)

    tier_rank = {"first-party": 0, "mirror": 1, "external": 2}
    for launch, rows in groups.items():
        # The tile takes the port's own title when it is an arcade port, else the name of
        # the highest-scoring card.
        stem = ""
        if launch.startswith("/games/arcade/"):
            stem = launch.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        rows.sort(key=lambda r: (-(r.get("score") or 0), len(r.get("name") or ""),
                                 (r.get("name") or "").lower()))
        primary = rows[0]
        name = (titles.get(stem) or "").strip() or (primary.get("name") or "untitled").strip()
        tier = min((r.get("tier") or "mirror" for r in rows), key=lambda t: tier_rank.get(t, 9))
        sources = [{
            "name": (r.get("name") or "").strip(),
            "slug": r.get("slug") or "",
            "upstream": r.get("url") or "",
            "score": r.get("score"),
        } for r in rows]
        note = primary.get("detail") or TIER_NOTE.get(tier, "")
        if len(rows) > 1:
            note = f"{note} · {len(rows)} source repos folded"
        tiles.append(
            {
                "name": name,
                "slug": primary.get("slug") or "",
                "url": launch,
                "tier": tier,
                "tier_label": TIER_LABEL.get(tier, "in-browser"),
                "note": note,
                "art": art_svg(name),
                "hue": hue(name),
                "shot": "",
                "sources": sources,
                "folded": len(rows) - 1,
            }
        )
    # attach screenshots + copy them next to index.html
    if shots:
        adir = os.path.join(out_dir, "art")
        os.makedirs(adir, exist_ok=True)
        for t in tiles:
            for cand in {slugify(t["slug"]), slugify(t["slug"]).lower(), slugify(t["name"]), slugify(t["name"]).lower()}:
                fn = cand + ".png"
                if fn in shots:
                    t["shot"] = "art/" + fn
                    src = os.path.join(art_dir, fn)
                    dst = os.path.join(adir, fn)
                    if not os.path.exists(dst):
                        with open(src, "rb") as a, open(dst, "wb") as b:
                            b.write(a.read())
                    break
    tiles.sort(key=lambda t: (t["name"] or "").lower())
    return tiles


def render(tiles: list[dict], report: dict, shelf: list[dict] | None = None, originals: list[dict] | None = None) -> str:
    total = report.get("total", 0)
    live = len(tiles)
    cards_live = int(report.get("live", live) or live)
    folded = sum(int(t.get("folded") or 0) for t in tiles)
    shelf = shelf or []
    original_cards = door_html(originals or [])
    original_block = f"""  <section class="door" aria-labelledby="originals-heading">
    <h2 id="originals-heading">RDW Games originals</h2>
    <div class="doorgrid">
{original_cards}
    </div>
  </section>
""" if original_cards else ""
    door = door_html(shelf)
    door_block = ""
    if door:
        door_block = f"""  <section class="door">
    <div class="doorhead">
      <div>
        <h2>The studio shelf</h2>
        <p class="doorsub">The games we build and ship ourselves — the KAOS shelf, one level
        down at <a href="/shelf/">/shelf/</a>. These are full 3D builds, not ports of phone
        puzzlers: they open in this tab and play.</p>
      </div>
      <a class="doorbtn" href="/shelf/">Browse the whole shelf &rarr;</a>
    </div>
    <div class="doorgrid">
{door}
    </div>
  </section>

""" if True else ""
    chips_extra = ""
    if any(t["tier"] == "external" for t in tiles):
        chips_extra = ('      <button class="chip" data-tier="external" aria-pressed="false">'
                       'embedded</button>\n')
    queued = report.get("quarantine", total - live)
    pct = round(100.0 * live / total, 1) if total else 0.0
    faces = sum(1 for t in tiles if t["tier"] == "first-party")
    data_json = json.dumps(tiles, ensure_ascii=False).replace("</", "<\\/")
    counts = json.dumps(
        {
            "total": total,
            "live": live,
            "live_cards": cards_live,
            "folded": folded,
            "shelf": len(shelf),
            "queued": queued,
            "first_party": faces,
            "by_tier": {k: sum(1 for t in tiles if t["tier"] == k) for k in TIER_LABEL},
        }
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Playable — game library</title>
<meta name="description" content="Every game here plays in the browser. No downloads, no installs.">
<style>
:root{{
  --bg:#07090f; --bg2:#0b0f18; --card:#121826; --line:#1e2938;
  --ink:#eaf1ff; --dim:#a6b6cc; --accent:#7cf5d0; --gold:#ffd479;
  --r:18px; --shadow:0 18px 40px -18px #000;
}}
*{{box-sizing:border-box}}
html,body{{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}}
body{{min-height:100vh;background:
  radial-gradient(1100px 520px at 12% -12%, #16324a 0%, transparent 62%),
  radial-gradient(900px 480px at 88% -4%, #2a1f45 0%, transparent 58%),
  linear-gradient(#07090f,#05070c 60%)}}
a{{color:inherit}}
.wrap{{max-width:1380px;margin:0 auto;padding:34px 22px 90px}}
header.top{{display:flex;flex-wrap:wrap;gap:18px;align-items:flex-end;justify-content:space-between;
  padding-bottom:22px;border-bottom:1px solid var(--line)}}
.brand{{display:flex;align-items:center;gap:14px}}
.mark{{width:44px;height:44px;border-radius:13px;flex:0 0 auto;
  background:linear-gradient(140deg,var(--accent),#4aa8ff 62%,#a06bff);
  box-shadow:0 0 0 1px #ffffff22, 0 10px 24px -10px #4aa8ff88;
  display:grid;place-items:center;color:#04121a;font-weight:800;font-size:19px}}
h1{{font-size:26px;letter-spacing:-0.4px;margin:0;font-weight:750}}
.brand p{{margin:3px 0 0;color:var(--dim);font-size:13px}}
.rule{{margin:14px 0 0;color:#c7d5e8;font-size:13.5px;max-width:74ch}}
.rule b{{color:var(--accent);font-weight:650}}
.stats{{display:flex;gap:10px;flex-wrap:wrap}}
.stat{{background:#0e1420cc;border:1px solid var(--line);border-radius:14px;padding:10px 14px;min-width:96px}}
.stat .n{{font-size:22px;font-weight:750;letter-spacing:-0.5px;font-variant-numeric:tabular-nums}}
.stat .l{{font-size:11px;letter-spacing:.11em;text-transform:uppercase;color:var(--dim)}}
.stat.live .n{{color:var(--accent)}} .stat.queue .n{{color:var(--gold)}}
.stat.shelf_stat .n{{color:#9bd0ff}}
.tools{{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:26px 0 20px}}
#q{{flex:1 1 260px;min-width:200px;background:#0e1420;border:1px solid var(--line);border-radius:12px;
  color:var(--ink);padding:11px 14px;font:inherit;outline:none}}
#q:focus{{border-color:var(--accent);box-shadow:0 0 0 3px #7cf5d022}}
.chips{{display:flex;gap:8px;flex-wrap:wrap}}
.chip{{background:#0e1420;border:1px solid var(--line);color:var(--dim);border-radius:999px;
  padding:8px 14px;font:inherit;font-size:13px;cursor:pointer}}
.chip[aria-pressed=true]{{color:#04121a;background:var(--accent);border-color:var(--accent);font-weight:650}}
.door{{margin:26px 0 6px;border:1px solid var(--line);border-radius:22px;padding:20px 22px 22px;
  background:linear-gradient(160deg,#101a2acc,#0b1020aa);box-shadow:var(--shadow)}}
.doorhead{{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;margin-bottom:16px}}
.door h2{{margin:0 0 6px;font-size:20px;letter-spacing:-0.3px}}
.doorsub{{margin:0;color:var(--dim);font-size:13.5px;max-width:78ch}}
.doorsub a{{color:var(--accent);text-decoration:none}}
.doorbtn{{flex:0 0 auto;align-self:center;text-decoration:none;border:1px solid #2b3b52;border-radius:999px;
  padding:10px 18px;font-size:13px;font-weight:650;color:var(--ink);background:#0d1421}}
.doorbtn:hover{{border-color:var(--accent);color:var(--accent)}}
.doorgrid{{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(232px,1fr))}}
.doorcard{{display:flex;flex-direction:column;gap:6px;text-decoration:none;color:inherit;
  border:1px solid var(--line);border-radius:14px;padding:13px 14px;background:#0c121ecc;
  transition:transform .16s ease,border-color .16s ease}}
.doorcard:hover,.doorcard:focus-visible{{transform:translateY(-3px);border-color:#3b5573;box-shadow:0 20px 34px -22px #000}}
.doorcard img{{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:contain;border-radius:8px}}
.doorcard .k{{font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--accent)}}
.doorcard strong{{font-size:15.5px;line-height:1.2;font-weight:680}}
.doorcard .d{{font-size:12.5px;color:var(--dim);line-height:1.4;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}}
.doorcard .go{{margin-top:auto;font-size:12px;font-weight:650;color:#9bd0ff}}
.grid{{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(206px,1fr))}}
.tile{{position:relative;padding:0;border:1px solid var(--line);border-radius:var(--r);overflow:hidden;
  background:var(--card);cursor:pointer;text-align:left;color:inherit;font:inherit;
  box-shadow:var(--shadow);transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}}
.tile:hover,.tile:focus-visible{{transform:translateY(-4px);border-color:#3b5573;
  box-shadow:0 26px 46px -22px #000,0 0 0 1px #7cf5d033}}
.tile .art{{display:block;width:100%;aspect-ratio:400/260;background-size:cover;background-position:center}}
.tile .body{{padding:11px 13px 13px;display:flex;align-items:center;gap:10px;justify-content:space-between}}
.tile .nm{{font-weight:640;font-size:15px;line-height:1.25;overflow:hidden;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}}
.badge{{flex:0 0 auto;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#b9cbe4;
  border:1px solid #2b3b52;border-radius:999px;padding:4px 8px;background:#0d1421;
  display:inline-flex;align-items:center;gap:5px}}
.badge::before{{content:'';width:5px;height:5px;border-radius:50%;background:#5b708c}}
.tile[data-tier=first-party] .badge::before{{background:var(--accent)}}
.tile[data-tier=mirror] .badge::before{{background:#6ba8ff}}
.tile .art.shot{{filter:saturate(1.02) brightness(.98)}}
.play{{position:absolute;inset:auto 12px 56px 12px;opacity:0;transform:translateY(6px);
  transition:.16s ease;display:flex;justify-content:center}}
.tile:hover .play,.tile:focus-visible .play{{opacity:1;transform:none}}
.play span{{background:#0b1220e6;border:1px solid #ffffff26;color:var(--ink);border-radius:999px;
  padding:7px 16px;font-size:12.5px;font-weight:650;letter-spacing:.04em;backdrop-filter:blur(6px)}}
.empty{{color:var(--dim);padding:26px 2px}}
.queue{{margin-top:46px;border-top:1px solid var(--line);padding-top:26px}}
.queue h2{{font-size:16px;margin:0 0 6px;letter-spacing:-0.2px}}
.queue p{{margin:0 0 14px;color:var(--dim);font-size:13.5px;max-width:80ch}}
.bar{{height:9px;border-radius:999px;background:#101827;overflow:hidden;border:1px solid var(--line)}}
.bar i{{display:block;height:100%;background:linear-gradient(90deg,var(--accent),#4aa8ff)}}
.legend{{display:flex;justify-content:space-between;color:var(--dim);font-size:12px;margin-top:8px;
  font-variant-numeric:tabular-nums}}
footer{{margin-top:40px;color:#6f7f96;font-size:12px;border-top:1px solid var(--line);padding-top:16px}}
#stage{{position:fixed;inset:0;z-index:60;display:none;background:#04060b;flex-direction:column}}
#stage.on{{display:flex}}
.bar2{{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#0a0f19;border-bottom:1px solid var(--line)}}
.bar2 b{{font-size:14px;font-weight:650}}
.bar2 .srcs{{font-size:11.5px;color:var(--dim);max-width:46ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.bar2 .sp{{flex:1}}
.btn{{background:#131b2a;border:1px solid #2b3b52;color:var(--ink);border-radius:10px;padding:7px 13px;
  font:inherit;font-size:12.5px;cursor:pointer;text-decoration:none}}
.btn:hover{{border-color:var(--accent);color:var(--accent)}}
#frame{{flex:1;width:100%;border:0;background:#000}}
@media (max-width:520px){{h1{{font-size:22px}} .wrap{{padding:22px 14px 60px}}
  .grid{{grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:12px}}}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <div class="mark">▸</div>
      <div>
        <h1>Playable</h1>
        <p>Cluer Holdings — the game library</p>
      </div>
    </div>
    <div class="stats">
      <div class="stat live"><div class="n">{live}</div><div class="l">play now</div></div>
      <div class="stat shelf_stat"><div class="n">{len(shelf)}</div><div class="l">studio shelf</div></div>
      <div class="stat queue"><div class="n">{queued}</div><div class="l">converting</div></div>
      <div class="stat"><div class="n">{faces}</div><div class="l">three.js</div></div>
    </div>
  </header>

  <p class="rule">Click any tile and the game <b>starts right here</b> — no downloads, no
  installers, no app stores, nothing to leave this page for. Anything that can't do that isn't
  a tile: it waits in the conversion queue below and is rebuilt as a <b>three.js</b> game,
  verified click-to-play before it ships.</p>

{original_block}{door_block}  <div class="tools">
    <input id="q" type="search" placeholder="Search {live} playable games…" autocomplete="off" spellcheck="false">
    <div class="chips" id="chips">
      <button class="chip" data-tier="all" aria-pressed="true">All</button>
      <button class="chip" data-tier="first-party" aria-pressed="false">three.js</button>
      <button class="chip" data-tier="mirror" aria-pressed="false">in-browser</button>
{chips_extra}    </div>
  </div>

  <div class="grid" id="grid"></div>
  <p class="empty" id="empty" hidden>No tile matches that. Try a different word.</p>

  <section class="queue">
    <h2>The conversion queue</h2>
    <p>{queued} titles from the old catalog do not play in a browser — they were APK links,
    store pages, downloads, or project homepages. They are kept (nothing deleted) and are being
    rebuilt as three.js web games. A title joins the grid above only after it click-plays in a
    real browser.</p>
    <div class="bar"><i style="width:{pct}%"></i></div>
    <div class="legend"><span>{live} tiles from {cards_live} live cards ({folded} duplicate
    source repos folded)</span><span>{pct}% of {total} catalogue rows browser-playable</span></div>
  </section>

  <footer>Built from the library audit — every tile below the fold is verified in headless Chromium
  before it is listed. No APK, zip, installer or store link is ever published as a tile.</footer>
</div>

<div id="stage" role="dialog" aria-modal="true" aria-label="Game player">
  <div class="bar2">
    <b id="title">Game</b>
    <span id="srcs" class="srcs"></span>
    <span class="sp"></span>
    <a class="btn" id="pop" href="#" target="_blank" rel="noopener">Open in new tab</a>
    <button class="btn" id="close">Close ✕</button>
  </div>
  <iframe id="frame" title="Game" allow="autoplay; fullscreen; gamepad; clipboard-write"
   sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-pointer-lock allow-orientation-lock"></iframe>
</div>

<script>
const TILES = {data_json};
const COUNTS = {counts};
const grid = document.getElementById('grid');
const stage = document.getElementById('stage');
const frame = document.getElementById('frame');
const titleEl = document.getElementById('title');
const pop = document.getElementById('pop');
let tier = 'all', term = '';

function tileEl(t, i) {{
  // Built with DOM nodes + textContent (never innerHTML) so a title from the audit can
  // never inject markup into the public page.
  const b = document.createElement('button');
  b.className = 'tile'; b.type = 'button'; b.dataset.tier = t.tier;
  b.setAttribute('aria-label', `Play ${{t.name}}`);
  const art = document.createElement('span');
  art.className = 'art'; art.style.backgroundImage = `url("${{t.shot || t.art}}")`;
  if (t.shot) art.classList.add('shot');
  const body = document.createElement('span'); body.className = 'body';
  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = t.name;
  const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = t.tier_label;
  body.append(nm, badge);
  const play = document.createElement('span'); play.className = 'play';
  const playIn = document.createElement('span'); playIn.textContent = '▶ Play';
  play.append(playIn);
  b.append(art, body, play);
  b.addEventListener('click', () => open(t));
  return b;
}}

function draw() {{
  const list = TILES.filter(t =>
    (tier === 'all' || t.tier === tier) &&
    (!term || t.name.toLowerCase().includes(term)));
  grid.replaceChildren(...list.map(tileEl));
  document.getElementById('empty').hidden = list.length > 0;
}}
function open(t) {{
  titleEl.textContent = t.name;
  const srcs = document.getElementById('srcs');
  srcs.textContent = (t.sources && t.sources.length > 1)
    ? `${{t.sources.length}} source repos: ${{t.sources.map(s => s.name).join(' · ')}}`
    : (t.note || '');
  frame.src = t.url;
  pop.href = t.url;
  stage.classList.add('on');
  document.getElementById('close').focus();
}}
function close() {{ stage.classList.remove('on'); frame.src = 'about:blank'; }}
document.getElementById('close').addEventListener('click', close);
addEventListener('keydown', e => {{ if (e.key === 'Escape' && stage.classList.contains('on')) close(); }});
document.getElementById('q').addEventListener('input', e => {{ term = e.target.value.trim().toLowerCase(); draw(); }});
document.getElementById('chips').addEventListener('click', e => {{
  const c = e.target.closest('.chip'); if (!c) return;
  tier = c.dataset.tier;
  for (const x of document.querySelectorAll('.chip')) x.setAttribute('aria-pressed', String(x === c));
  draw();
}});
draw();
</script>
</body>
</html>
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audit", default=".queue/library-audit.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--art", default="", help="dir of per-tile screenshots from scripts/lib-art.mjs")
    ap.add_argument("--site-repo", default=os.path.expanduser("~/kaos/work/site"),
                    help="site repo whose HEAD holds games/catalog.json (the studio shelf)")
    args = ap.parse_args()

    data = load(args.audit)
    os.makedirs(args.out, exist_ok=True)
    titles = arcade_titles(args.site_repo)
    shelf = kaos_shelf(args.site_repo)
    originals = load_releases()
    tiles = build_tiles(data, args.art, args.out, titles)
    if not tiles:
        print("FAIL: audit has no live entries — refusing to publish an empty shelf")
        return 2
    os.makedirs(args.out, exist_ok=True)
    page = render(tiles, data, shelf, originals)
    with open(os.path.join(args.out, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(page)
    payload = {
        "tiles": tiles,
        "originals": [{key: release[key] for key in
                       ("slug", "title", "version", "description", "source", "commit", "url",
                        "preview", "preview_alt")}
                      for release in originals],
        "counts": {k: v for k, v in data.items() if k != "entries_live"},
    }
    # games.json is the name the publish script (and the /catalog/ alias) already ship;
    # library.json is the same payload under the new, honest name. Both, one file's worth.
    for fn in ("games.json", "library.json"):
        with open(os.path.join(args.out, fn), "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=1)
    print(f"LIBRARY {len(tiles)} tiles (from {data.get('live', len(tiles))} live cards, "
          f"{sum(t.get('folded') or 0 for t in tiles)} folded) | shelf {len(shelf)} | "
          f"{data.get('quarantine', 0)} queued | "
          f"{os.path.getsize(os.path.join(args.out, 'index.html'))//1024} KB index.html -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
