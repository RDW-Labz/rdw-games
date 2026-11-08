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
import html
import json
import re
import sys
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


def merge(queue: list[dict], catalog: list[dict], dirs: dict[str, Path]) -> list[dict]:
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
        entries.append(
            {
                "name": c["display"],
                "slug": c["slug"] or (q["slug"] if q else (clone or "")),
                "url": url,
                "stars": q["stars"] if q else 0,
                "license": q["license"] if q else "",
                "size_kb": q["size_kb"] if q else 0,
                "source": q["source"] if q else "",
                "summary": q["summary"] if q else "",
                "judged": True,
                "score": c["score"],
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
                "stars": q["stars"],
                "license": q["license"],
                "size_kb": q["size_kb"],
                "source": q["source"],
                "summary": q["summary"],
                "judged": False,
                "score": None,
                "type": "",
                "platforms": "",
                "status": "",
                "desk_only": False,
                "row": None,
            }
        )
    # Judged first (highest score first), then the rest by stars.
    entries.sort(
        key=lambda e: (0 if e["judged"] else 1, -(e["score"] or 0), -e["stars"], e["name"].lower())
    )
    return entries


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
.stats{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;color:var(--dim);font-size:13px}
.stats b{color:var(--ink)}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
input[type=search]{flex:1 1 260px;min-width:200px;background:#0f1520;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px 11px;font:inherit}
input[type=search]:focus{outline:2px solid rgba(124,245,208,.35);border-color:var(--accent)}
select,button{background:#0f1520;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px 11px;font:inherit;cursor:pointer}
button.on{border-color:var(--accent);color:var(--accent)}
main{padding:14px 18px 60px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 12px;display:flex;flex-direction:column;gap:6px}
.card h3{margin:0;font-size:15px;line-height:1.25;display:flex;gap:8px;align-items:baseline}
.card h3 a{color:inherit;text-decoration:none}
.card h3 a:hover{color:var(--accent)}
.score{font-size:13px;font-weight:700;color:var(--gold);white-space:nowrap}
.meta{color:var(--dim);font-size:12px;display:flex;gap:8px;flex-wrap:wrap}
.pill{border:1px solid var(--line);border-radius:999px;padding:1px 7px;font-size:11px;color:var(--dim)}
.pill.j{color:var(--accent);border-color:rgba(124,245,208,.4)}
.sum{color:#b9c7dc;font-size:13px;margin:0}
.type{color:#c9d7ea;font-size:12.5px;margin:0}
.more{background:none;border:0;color:var(--dim);padding:0;font-size:12px;text-align:left}
.more:hover{color:var(--accent)}
.status{display:none;color:#a9b8cd;font-size:12.5px;border-top:1px dashed var(--line);padding-top:6px;white-space:pre-wrap}
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
const sortBtn = document.getElementById('sort');
let judgedOnly = true, sortMode = 'score';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtSize = kb => !kb ? '' : kb >= 1024 ? (kb/1024).toFixed(kb >= 10240 ? 0 : 1) + ' MB' : kb + ' KB';

stats.innerHTML = `<span><b>${DATA.total}</b> titles in the queue</span>
  <span><b>${DATA.judged}</b> judged</span>
  <span><b>${DATA.bySource.fdroid || 0}</b> F-Droid</span>
  <span><b>${DATA.bySource.github || 0}</b> GitHub sweep</span>
  <span><b>${DATA.bySource.curated || 0}</b> curated</span>
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
  if (sortMode === 'score') r.sort((a,b) => (b.score||0)-(a.score||0) || (b.stars||0)-(a.stars||0) || a.name.localeCompare(b.name));
  else if (sortMode === 'stars') r.sort((a,b) => (b.stars||0)-(a.stars||0) || a.name.localeCompare(b.name));
  else r.sort((a,b) => a.name.localeCompare(b.name));
  return r;
}

function render(){
  const r = rows();
  empty.hidden = r.length > 0;
  // Every interpolated field below passes through esc() before it reaches the markup;
  // the only raw HTML here is this file's own template. 400+ cards is fine, but cap it anyway.
  grid.innerHTML = r.slice(0, 600).map((e,i) => {
    const title = e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noreferrer noopener">${esc(e.name)}</a>` : esc(e.name);
    const pills = [
      e.judged ? '<span class="pill j">judged</span>' : '<span class="pill">queued</span>',
      e.source ? `<span class="pill">${esc(SRC[e.source] || e.source)}</span>` : '',
      e.stars ? `<span class="pill">★ ${e.stars.toLocaleString()}</span>` : '',
      e.license ? `<span class="pill">${esc(e.license)}</span>` : '',
      e.size_kb ? `<span class="pill">${fmtSize(e.size_kb)}</span>` : ''
    ].join('');
    const score = e.score != null ? `<span class="score">${e.score}${e.desk_only ? '<span class="pill">desk</span>' : ''}</span>` : '';
    return `<article class="card">
      <h3>${title}${score}</h3>
      <div class="meta">${pills}</div>
      ${e.type ? `<p class="type">${esc(e.type)}</p>` : ''}
      ${e.summary ? `<p class="sum">${esc(e.summary.slice(0, 220))}${e.summary.length > 220 ? '…' : ''}</p>` : ''}
      ${e.status ? `<button class="more" data-i="${i}">evidence</button><div class="status" id="s${i}">${esc(e.status)}</div>` : ''}
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
document.getElementById('foot').textContent = 'Queue and scores come from the repo artifacts (GAMES.queue / CATALOG.md). Links open the upstream project.';
render();
</script>
</body>
</html>
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site-out", help="output directory")
    ap.add_argument("--src", default=".", help="repo root holding GAMES.queue + CATALOG.md")
    args = ap.parse_args()

    src = Path(args.src).resolve()
    out = Path(args.out).resolve()
    queue = read_queue(src)
    catalog = read_catalog(src)
    dirs = clone_dirs(src)
    entries = merge(queue, catalog, dirs)

    by_source: dict[str, int] = {}
    for q in queue:
        by_source[q["source"]] = by_source.get(q["source"], 0) + 1

    payload = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "total": len(queue),
        "judged": len(catalog),
        "bySource": by_source,
        "entries": entries,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "games.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    # The JSON goes inside a <script type="application/json">, so escape the sequence
    # that would close it early.
    blob = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    (out / "index.html").write_text(PAGE.replace("__DATA__", blob), encoding="utf-8")
    print(f"wrote {out/'index.html'} + games.json — {len(queue)} queued, {len(catalog)} judged, {len(entries)} entries")


if __name__ == "__main__":
    main()
