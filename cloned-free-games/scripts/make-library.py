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


def build_tiles(data: dict, art_dir: str = "", out_dir: str = "") -> list[dict]:
    """Tiles from the audit's live entries. Art priority: a real screenshot captured by
    scripts/lib-art.mjs (--art), else the generated monogram plate. The screenshot is the
    point of the facelift — a shelf of games should show the games, not initials."""
    tiles = []
    shots = set()
    if art_dir and os.path.isdir(art_dir):
        shots = {f for f in os.listdir(art_dir) if f.lower().endswith(".png")}
    for row in data.get("entries_live", []):
        name = (row.get("name") or "untitled").strip()
        launch = row["launch"]
        tiles.append(
            {
                "name": name,
                "slug": row.get("slug") or "",
                "url": launch,
                "tier": row.get("tier", "mirror"),
                "tier_label": TIER_LABEL.get(row.get("tier", ""), "in-browser"),
                "note": row.get("detail") or TIER_NOTE.get(row.get("tier", ""), ""),
                "art": art_svg(name),
                "hue": hue(name),
                "shot": "",
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


def render(tiles: list[dict], report: dict) -> str:
    total = report.get("total", 0)
    live = len(tiles)
    queued = report.get("quarantine", total - live)
    pct = round(100.0 * live / total, 1) if total else 0.0
    faces = sum(1 for t in tiles if t["tier"] == "first-party")
    data_json = json.dumps(tiles, ensure_ascii=False).replace("</", "<\\/")
    counts = json.dumps(
        {
            "total": total,
            "live": live,
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
.tools{{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:26px 0 20px}}
#q{{flex:1 1 260px;min-width:200px;background:#0e1420;border:1px solid var(--line);border-radius:12px;
  color:var(--ink);padding:11px 14px;font:inherit;outline:none}}
#q:focus{{border-color:var(--accent);box-shadow:0 0 0 3px #7cf5d022}}
.chips{{display:flex;gap:8px;flex-wrap:wrap}}
.chip{{background:#0e1420;border:1px solid var(--line);color:var(--dim);border-radius:999px;
  padding:8px 14px;font:inherit;font-size:13px;cursor:pointer}}
.chip[aria-pressed=true]{{color:#04121a;background:var(--accent);border-color:var(--accent);font-weight:650}}
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
      <div class="stat queue"><div class="n">{queued}</div><div class="l">converting</div></div>
      <div class="stat"><div class="n">{faces}</div><div class="l">three.js</div></div>
    </div>
  </header>

  <p class="rule">Click any tile and the game <b>starts right here</b> — no downloads, no
  installers, no app stores, nothing to leave this page for. Anything that can't do that isn't
  a tile: it waits in the conversion queue below and is rebuilt as a <b>three.js</b> game,
  verified click-to-play before it ships.</p>

  <div class="tools">
    <input id="q" type="search" placeholder="Search {live} playable games…" autocomplete="off" spellcheck="false">
    <div class="chips" id="chips">
      <button class="chip" data-tier="all" aria-pressed="true">All</button>
      <button class="chip" data-tier="first-party" aria-pressed="false">three.js</button>
      <button class="chip" data-tier="mirror" aria-pressed="false">in-browser</button>
    </div>
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
    <div class="legend"><span>{live} live of {total}</span><span>{pct}% browser-playable</span></div>
  </section>

  <footer>Built from the library audit — every tile below the fold is verified in headless Chromium
  before it is listed. No APK, zip, installer or store link is ever published as a tile.</footer>
</div>

<div id="stage" role="dialog" aria-modal="true" aria-label="Game player">
  <div class="bar2">
    <b id="title">Game</b>
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
    args = ap.parse_args()

    data = load(args.audit)
    os.makedirs(args.out, exist_ok=True)
    tiles = build_tiles(data, args.art, args.out)
    if not tiles:
        print("FAIL: audit has no live entries — refusing to publish an empty shelf")
        return 2
    os.makedirs(args.out, exist_ok=True)
    page = render(tiles, data)
    with open(os.path.join(args.out, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(page)
    payload = {"tiles": tiles, "counts": {k: v for k, v in data.items() if k != "entries_live"}}
    # games.json is the name the publish script (and the /catalog/ alias) already ship;
    # library.json is the same payload under the new, honest name. Both, one file's worth.
    for fn in ("games.json", "library.json"):
        with open(os.path.join(args.out, fn), "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=1)
    print(f"LIBRARY {len(tiles)} tiles | {data.get('quarantine', 0)} queued | "
          f"{os.path.getsize(os.path.join(args.out, 'index.html'))//1024} KB index.html -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
