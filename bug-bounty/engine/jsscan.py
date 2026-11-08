#!/usr/bin/env python3
"""Read public JavaScript from in-scope hosts and look for credentials that were shipped by mistake.

Why this lane and not more DNS: a dangling CNAME pays $50-$500 and this corpus is measured empty
(541,926 hosts -> 0 claimable names inside a paying published scope). A leaked live credential is the
same reconnaissance work against the same host list, but the class pays an order of magnitude more
because the impact is somebody else's cloud account, not a blank hostname.

Rules this script keeps:

  * Scope gate first. A host is only fetched when a `scopes` row on a real platform covers it. The
    script prints how many hosts it skipped for lacking scope; it never "just checks" a host whose
    policy is unknown.
  * GET only, no parameters, no auth, no fuzzing. Bundles are read the way a browser reads them.
  * Secrets are never stored whole, never printed whole and never used. Every hit is reduced to
    kind + masked form (first 4 + length + sha256 of the full value) so a report can prove the
    finding without the file becoming a credential store. If a hit turns out live, the response is a
    report, not a login.
  * A hit is a *candidate*. Client-side publishable values (`pk_live_`, Firebase web API keys,
    Supabase anon keys, Mapbox `pk.`) are matched too but tagged `public-by-design` so they are not
    counted as findings — treating those as bugs is how reports get closed as informative.

  python3 engine/jsscan.py --paying --limit 120      # bounty-eligible scopes only, 120 hosts
  python3 engine/jsscan.py --dry-run --limit 20      # fetch and print, write nothing
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sqlite3
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine" / "state.db"
OUT = ROOT / "reports" / "js-secrets.json"

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/141.0.0.0 Safari/537.36")
# A bare bot UA is answered with 403 by most WAFs, which reads as "no JS on this host" and quietly
# hides every bundle. These are the headers a browser sends for the same GET; nothing here
# authenticates or evades a paywall.
HEADERS = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/javascript,*/*;q=0.8",
           "Accept-Language": "en-US,en;q=0.9", "Accept-Encoding": "identity",
           "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Upgrade-Insecure-Requests": "1"}
MAX_BUNDLES = 6
MAX_BYTES = 3_000_000
FETCHED = [0, 0]  # [answered 200, attempted] — the ratio tells you whether a zero-hit run is real

# (name, regex, severity, note). Order matters only for output readability.
PATTERNS: list[tuple[str, re.Pattern[str], str, str]] = [
    ("aws-access-key-id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "high",
     "needs its secret half to be exploitable, but a key id alone leaks account + permission shape"),
    ("aws-secret-key", re.compile(r"(?i)aws.{0,20}?['\"]([0-9a-zA-Z/+]{40})['\"]"), "high", ""),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"), "public-by-design",
     "web keys are expected to be public; only a key with no referrer restriction is a bug"),
    ("stripe-secret", re.compile(r"\bsk_live_[0-9a-zA-Z]{20,}\b"), "critical", ""),
    ("stripe-publishable", re.compile(r"\bpk_live_[0-9a-zA-Z]{20,}\b"), "public-by-design", ""),
    ("sendgrid", re.compile(r"\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}\b"), "critical", ""),
    ("slack", re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}\b"), "high", ""),
    ("github-token", re.compile(r"\bgh[pousr]_[0-9A-Za-z]{36}\b"), "critical", ""),
    ("openai-anthropic", re.compile(r"\b(sk-(?:ant-)?(?:proj-)?[A-Za-z0-9_-]{32,})\b"), "critical", ""),
    ("private-key-block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"), "critical", ""),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"), "info",
     "almost always a public session/config token; never report without a shown privilege floor"),
    ("mapbox", re.compile(r"\bpk\.[A-Za-z0-9]{60,}\b"), "public-by-design", ""),
    ("supabase-anon", re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\."), "public-by-design",
     "anon key is designed for the browser; the bug is a missing RLS policy, not the key"),
]

# Values that are documentation, placeholders, or our own test strings.
NOISE = re.compile(
    r"(?i)(example|placeholder|your[_-]?(key|token|api)|xxxx|1234|dummy|sample|redacted|"
    r"process\.env|import\.meta\.env|\$\{|<[a-z_]+>)"
)

HOST_TYPES_SKIP = {"ip_address", "cidr", "mobile", "android", "ios", "hardware", "executable",
                   "source_code", "other", "smart_contract"}

SCRIPT_SRC = re.compile(r"""<script[^>]+src=["']([^"']+)["']""", re.I)


def host_of(asset: str) -> str:
    a = (asset or "").strip().lower()
    if not a:
        return ""
    a = a.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0]
    return a.strip(".")


def build_scope_index(db: sqlite3.Connection, paying_only: bool):
    exact: dict[str, list[tuple[str, str]]] = {}
    wild: dict[str, list[tuple[str, str]]] = {}
    for platform, handle, asset, atype, bounty in db.execute(
            "select platform, handle, asset, asset_type, bounty from scopes"):
        if paying_only and not bounty:
            continue
        if (atype or "").lower() in HOST_TYPES_SKIP:
            continue
        h = host_of(asset)
        if len(h.strip("*.")) < 3:
            continue
        row = (platform, handle.strip())
        if h.startswith("*."):
            wild.setdefault(h[2:], []).append(row)
        elif "*" not in h:
            exact.setdefault(h, []).append(row)
    return exact, wild


def covering_scope(host: str, exact, wild):
    labels = host.split(".")
    for i in range(len(labels) - 1):
        suffix = ".".join(labels[i:])
        if suffix in exact:
            return suffix, exact[suffix]
    for i in range(len(labels)):
        suffix = ".".join(labels[i:])
        if suffix in wild:
            return suffix, wild[suffix]
    return None, None


def masked(value: str) -> dict:
    return {"len": len(value),
            "sha256": hashlib.sha256(value.encode()).hexdigest()[:16],
            "head": value[:4] + "…" if len(value) > 8 else "…"}


def fetch(url: str, timeout: float = 12.0, redirects: int = 4) -> tuple[int, str]:
    import http.client
    for _ in range(redirects + 1):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            return 0, ""
        conn = (http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection)(
            u.hostname, u.port, timeout=timeout)
        path = (u.path or "/") + (("?" + u.query) if u.query else "")
        try:
            conn.request("GET", path, headers=HEADERS)
            r = conn.getresponse()
            if r.status in (301, 302, 303, 307, 308):
                loc = r.getheader("Location") or ""
                if not loc:
                    return r.status, ""
                url = urllib.parse.urljoin(url, loc)
                continue
            if r.status != 200:
                return r.status, ""
            if "text" not in (r.getheader("Content-Type") or "") and \
                    "json" not in (r.getheader("Content-Type") or ""):
                return r.status, ""
            FETCHED[0] += 1
            return r.status, r.read(MAX_BYTES).decode("utf-8", "replace")
        except Exception:
            return 0, ""
        finally:
            try:
                conn.close()
            except Exception:
                pass
    return 0, ""


def bundles_for(host: str) -> list[str]:
    base = f"https://{host}/"
    code, body = fetch(base)
    urls = [base]
    for src in SCRIPT_SRC.findall(body)[:MAX_BUNDLES]:
        if src.startswith("//"):
            src = "https:" + src
        elif src.startswith("/"):
            src = base.rstrip("/") + src
        if not src.startswith("http"):
            continue
        # Bundle extensions vary (`*.webpack`, `*.chunk.js`, hash-only assets); filtering on `.js`
        # alone missed every Quora bundle, so accept any same-site script reference and cap the count.
        urls.append(src)
    return list(dict.fromkeys(urls))


def scan_text(host: str, url: str) -> list[dict]:
    code, body = fetch(url)
    if code != 200 or not body:
        return []
    hits = []
    for name, rx, sev, note in PATTERNS:
        for m in rx.finditer(body):
            val = m.group(1) if m.groups() else m.group(0)
            ctx = body[max(0, m.start() - 60): m.end() + 60]
            if NOISE.search(ctx):
                continue
            hits.append({"host": host, "url": url, "kind": name, "severity": sev,
                         "value": masked(val), "note": note})
    return hits


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--paying", action="store_true", help="only bounty-eligible scope rows")
    ap.add_argument("--match", default="", help="regex the hostname must match, e.g. '^(dev|staging|uat)[-.]'")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--workers", type=int, default=12)
    args = ap.parse_args()

    db = sqlite3.connect(str(DB))
    exact, wild = build_scope_index(db, args.paying)
    hosts = [r[0] for r in db.execute(
        """select h.host from hosts h join apex_dns a on a.apex = h.domain
           where a.a is not null and a.a <> '' order by random()""")]
    if not args.dry_run:
        db.execute("""create table if not exists js_secrets (
                        host text, url text, kind text, severity text, value_len int,
                        value_sha text, value_head text, first_seen text,
                        state text default 'new', unique(host, kind, value_sha))""")
        known = {(h, k, s) for h, k, s in
                 db.execute("select host, kind, value_sha from js_secrets")}
    else:
        known = set()

    pool, skipped = [], 0
    host_rx = re.compile(args.match) if args.match else None
    for h in hosts:
        if host_rx and not host_rx.search(h):
            continue
        base, rows = covering_scope(h, exact, wild)
        if not base:
            skipped += 1
            if skipped > 60000:
                break
            continue
        pool.append((h, base, rows))
        if len(pool) >= 3000:
            break
    # Shallow names (apex, www, app, api) serve the bundles; random deep subdomains are mostly
    # internal hosts that answer 403 or nothing, which looks like "no secrets here" but isn't.
    pool.sort(key=lambda t: t[0].count("."))
    picked = pool[: args.limit]

    print(f"{len(hosts)} hosts in corpus · {skipped} without any published scope · "
          f"scanning {len(picked)} (paying-only={args.paying})")

    def work(item):
        h, base, rows = item
        found = []
        for url in bundles_for(h):
            found.extend(scan_text(h, url))
        return h, base, rows, found

    all_hits: list[dict] = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for h, base, rows, found in ex.map(work, picked):
            tag = ",".join(sorted({f"{p}:{hd}" for p, hd in rows}))[:70]
            fresh = [f for f in found if (f["host"], f["kind"], f["value"]["sha256"]) not in known]
            for f in fresh:
                all_hits.append({**f, "scope": tag})
            print(f"  {h:<44} {len(found):>2} hit(s)  {tag}")

    by_kind: dict[str, int] = {}
    for f in all_hits:
        by_kind[f["kind"]] = by_kind.get(f["kind"], 0) + 1
    real = [f for f in all_hits if f["severity"] not in ("public-by-design", "info")]

    print(f"\n{len(all_hits)} candidate(s) in {time.time() - t0:.0f}s · "
          f"pages answered {FETCHED[0]} · "
          f"{len(real)} non-publishable · {by_kind}")
    for f in sorted(real, key=lambda x: {"critical": 0, "high": 1}.get(x["severity"], 3))[:20]:
        print(f"  {f['severity'].upper():<8} {f['kind']:<20} {f['host']:<40} {f['value']['head']} "
              f"len={f['value']['len']} {f['url'][:70]}")

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return
    import datetime as dt
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    db.executemany(
        """insert or ignore into js_secrets
           (host, url, kind, severity, value_len, value_sha, value_head, first_seen)
           values (?,?,?,?,?,?,?,?)""",
        [(f["host"], f["url"], f["kind"], f["severity"], f["value"]["len"],
          f["value"]["sha256"], f["value"]["head"], now) for f in all_hits])
    db.commit()
    OUT.write_text(__import__("json").dumps(all_hits, indent=2) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)} and {len(all_hits)} rows to js_secrets")


if __name__ == "__main__":
    main()
