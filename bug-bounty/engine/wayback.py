#!/usr/bin/env python3
"""Mine the Wayback Machine for JavaScript and old endpoints that were public once.

The live sweep (`engine/jsscan.py`) measured 0 exploitable secrets across 420 paying-scope hosts, and
the reason is structural rather than bad luck: a key that still works is usually not in the bundle a
marketing site serves today, because somebody rotated it *and* shipped a new build. The archive is a
different corpus — same hosts, same scope, but every bundle that ever shipped, including builds from
before the incident that taught them to rotate.

Three passes per host, all read-only and all inside the published scope:

  1. archived JS  — CDX rows with an application/javascript mimic, fetched raw (`/web/<ts>id_/`) so
     the bytes are the original bundle rather than the archive's rewritten HTML.
  2. old paths    — every archived URL, matched against the ones that leak a tree by existing:
     `/.git/`, `/.env`, `/.svn`, `*.sql`, `*.bak`, `*~`, `/backup/`, `/.DS_Store`, `wp-config`.
  3. bucket refs  — storage hostnames quoted in old bundles (`s3.amazonaws.com/<bucket>`,
     `<bucket>.s3...`, `storage.googleapis.com/<bucket>`, `<account>.blob.core.windows.net`). The
     bucket name is the finding; the script never probes it, because a foreign bucket is not in scope
     and a `403` is not authorization.

Politeness: the archive is a shared public service, so concurrency is low, a pause sits between
requests, and `429`/`503` back off instead of retrying hard. A run that gets throttled prints the
throttled count — otherwise "0 hits" would be indistinguishable from "archive said no".

  python3 engine/wayback.py --limit 25 --workers 4 --js 2      # validate on 25 hosts
  python3 engine/wayback.py --limit 200 --workers 6            # real pass, writes wayback_hits

Nothing in this file uses a credential, writes to a third party, or stores a secret whole.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jsscan import PATTERNS, NOISE, build_scope_index, covering_scope, masked  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine" / "state.db"
OUT = ROOT / "reports" / "wayback.json"
CDX = "https://web.archive.org/cdx/search/cdx"
RAW = "https://web.archive.org/web/{}id_/{}"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

LEAK_PATH = re.compile(
    r"(?i)(/\.git/(?:config|HEAD)|/\.env(?:\.[a-z]+)?$|/\.svn/|/backup/|\.sql$|\.bak$|~$|"
    r"/\.DS_Store$|wp-config\.php|/\.aws/credentials|/id_rsa$|/\.npmrc$|/\.docker/config\.json)")
BUCKET = re.compile(
    r"(?:https?://)(?:s3[.-][a-z0-9-]+\.amazonaws\.com/([a-z0-9][a-z0-9.-]{2,62})"
    r"|([a-z0-9][a-z0-9.-]{2,62})\.s3[.-][a-z0-9-]*\.?amazonaws\.com"
    r"|storage\.googleapis\.com/([a-z0-9][a-z0-9._-]{2,62})"
    r"|([a-z0-9]{3,24})\.blob\.core\.windows\.net)", re.I)

STATE = {"cdx_ok": 0, "cdx_429": 0, "js_ok": 0, "js_fail": 0}


def http_get(url: str, timeout: float = 25.0, tries: int = 2, redirects: int = 4) -> tuple[int, str]:
    import http.client
    for attempt in range(tries):
        for _ in range(redirects + 1):
            u = urllib.parse.urlsplit(url)
            if not u.hostname:
                return 0, ""
            conn = http.client.HTTPSConnection(u.hostname, u.port, timeout=timeout)
            path = (u.path or "/") + (("?" + u.query) if u.query else "")
            try:
                conn.request("GET", path, headers={"User-Agent": UA, "Accept": "*/*",
                                                  "Accept-Encoding": "identity"})
                r = conn.getresponse()
                if r.status in (301, 302, 303, 307, 308):
                    loc = r.getheader("Location") or ""
                    if not loc:
                        return r.status, ""
                    # `http://` originals redirect to `https://`, and an un-followed redirect reads
                    # exactly like a missing capture — 49 of 64 fetches "failed" until this loop.
                    url = urllib.parse.urljoin(url, loc)
                    continue
                if r.status in (429, 503, 502):
                    STATE["cdx_429"] += 1
                    break
                if r.status != 200:
                    return r.status, ""
                return r.status, r.read(4_000_000).decode("utf-8", "replace")
            except Exception:
                break
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
        time.sleep(1 + attempt * 2)
    return 0, ""


def cdx(host: str, js_only: bool, limit: int = 200, url_filter: str = "") -> list[tuple[str, str]]:
    q = {"url": f"{host}/*", "output": "json", "fl": "timestamp,original",
         "collapse": "urlkey", "limit": str(limit), "from": "2021"}
    if js_only:
        q["filter"] = "mimetype:application/javascript"
    if url_filter:
        q["filter"] = url_filter
    time.sleep(0.4)
    code, body = http_get(f"{CDX}?{urllib.parse.urlencode(q)}")
    if code != 200 or not body.strip():
        return []
    try:
        rows = json.loads(body)
    except Exception:
        return []
    STATE["cdx_ok"] += 1
    return [(r[0], r[1]) for r in rows[1:] if len(r) >= 2]


def scan(body: str, host: str, url: str) -> list[dict]:
    hits = []
    for name, rx, sev, note in PATTERNS:
        for m in rx.finditer(body):
            val = m.group(1) if m.groups() else m.group(0)
            if NOISE.search(body[max(0, m.start() - 60): m.end() + 60]):
                continue
            hits.append({"kind": name, "severity": sev, "host": host, "url": url,
                         "value": masked(val), "note": note})
    for m in BUCKET.finditer(body):
        name = next(g for g in m.groups() if g)
        hits.append({"kind": "bucket-ref", "severity": "investigate", "host": host, "url": url,
                     "value": masked(name), "note": "name only; ownership must be proven"})
    return hits


def host_passes(host: str, js_limit: int) -> tuple[list[dict], list[dict], list[str]]:
    old = cdx(host, js_only=False)
    leaks = [{"kind": "leaky-path", "severity": "investigate", "host": host, "url": u,
              "value": masked(u.rsplit("/", 1)[-1])}
             for _, u in old if LEAK_PATH.search(urllib.parse.urlsplit(u).path)]
    # Two queries, because the recorded mimetype lies often enough to matter: modern sites serve
    # `text/plain` or `text/html` for `.js` to get past sniffing heuristics, and a mimetype-only
    # filter silently drops exactly those bundles.
    js = cdx(host, js_only=True)
    js += cdx(host, js_only=False, url_filter=r"original:.*\.js(\?.*)?$")
    seen, ordered = set(), []
    for ts, u in js:
        key = u.split("?", 1)[0]
        if key not in seen:
            seen.add(key)
            ordered.append((ts, u))
    hits, fetched = [], []
    for ts, u in ordered[: max(1, js_limit)]:
        code, body = http_get(RAW.format(ts, u))
        if code == 200 and body:
            STATE["js_ok"] += 1
            fetched.append(u)
            hits.extend(scan(body, host, u))
        else:
            STATE["js_fail"] += 1
    return hits, leaks, fetched


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=25)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--js", type=int, default=2, help="archived bundles to fetch per host")
    ap.add_argument("--paying", action="store_true", default=True)
    ap.add_argument("--match", default="")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    db = sqlite3.connect(str(DB))
    exact, wild = build_scope_index(db, True)
    hosts = [r[0] for r in db.execute(
        """select h.host from hosts h join apex_dns a on a.apex = h.domain
           where a.a is not null and a.a <> ''
             and (h.host = h.domain
                  or h.host like 'www.%' or h.host like 'app.%' or h.host like 'api.%'
                  or h.host like 'admin.%' or h.host like 'portal.%' or h.host like 'm.%'
                  or h.host like 'my.%' or h.host like 'secure.%' or h.host like 'shop.%')
           order by random()""")]
    rx = re.compile(args.match) if args.match else None
    pool = []
    for h in hosts:
        if rx and not rx.search(h):
            continue
        base, rows = covering_scope(h, exact, wild)
        if not base:
            continue
        pool.append((h, ",".join(sorted({f"{p}:{hd}" for p, hd in rows}))[:60]))
        if len(pool) >= args.limit * 4:
            break
    pool.sort(key=lambda t: t[0].count("."))
    picked = pool[: args.limit]
    print(f"scanning {len(picked)} in-scope hosts, {args.js} archived bundle(s) each, "
          f"{args.workers} workers")

    t0 = time.time()
    all_hits: list[dict] = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for host, tag in picked:
            hits, leaks, fetched = host_passes(host, args.js)
            for x in hits + leaks:
                all_hits.append({**x, "scope": tag})
            flag = f"{len(hits)} secret · {len(leaks)} leaky-path · {len(fetched)} bundle(s)"
            print(f"  {host:<46} {flag}  {tag}")

    real = [h for h in all_hits if h["severity"] not in ("public-by-design", "info")]
    kinds: dict[str, int] = {}
    for h in all_hits:
        kinds[h["kind"]] = kinds.get(h["kind"], 0) + 1
    print(f"\n{len(all_hits)} hit(s) in {time.time() - t0:.0f}s · cdx ok {STATE['cdx_ok']} "
          f"throttled {STATE['cdx_429']} · bundles ok {STATE['js_ok']} fail {STATE['js_fail']} · "
          f"{len(real)} non-publishable · {kinds}")
    for h in sorted(real, key=lambda x: (x["severity"] != "critical", x["kind"]))[:25]:
        print(f"  {h['severity'].upper():<11} {h['kind']:<20} {h['host']:<40} {h['url'][:64]}")

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return
    db.execute("""create table if not exists wayback_hits (
                    host text, kind text, severity text, url text, value_sha text,
                    value_head text, first_seen text)""")
    import datetime as dt
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    db.executemany(
        "insert into wayback_hits (host, kind, severity, url, value_sha, value_head, first_seen)"
        " values (?,?,?,?,?,?,?)",
        [(h["host"], h["kind"], h["severity"], h["url"], h["value"]["sha256"],
          h["value"]["head"], now) for h in all_hits])
    db.commit()
    OUT.write_text(json.dumps(all_hits, indent=2) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)} and {len(all_hits)} rows to wayback_hits")


if __name__ == "__main__":
    main()
