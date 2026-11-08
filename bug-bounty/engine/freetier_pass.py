#!/usr/bin/env python3
"""Occupancy pass over the free-tier hostnamespaces, where DNS cannot answer the question.

Every one of these zones answers for arbitrary labels, so `dig` says "resolves" for a free name and for
an occupied one alike. The only evidence is the provider's own "nothing deployed here" page, fetched
from the **native** hostname (never the victim's — the victim's host tells you nothing about the
occupancy of the name).

Three verdicts, never two: available / occupied / unknown. A timeout, a 403 or a TLS failure is
*unknown*, and only `available` is carried into the scope join — a name nobody points at is somebody's
vacant username, not a vulnerability.

Yield is expected to be low; the point of running it is to be able to state the arithmetic.

  python3 engine/freetier_pass.py --json reports/freetier-queue.json
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import ssl
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine/state.db"

# provider -> (suffix, unclaimed signature regex, claimable-label rule)
PROVIDERS = {
    "netlify":    ("netlify.app",     r"Not Found - Request ID", r"^(?P<label>[a-z0-9-]+)\.netlify\.app$"),
    "github":     ("github.io",       r"There isn't a GitHub Pages site here|Site not found", r"^(?P<label>[a-z0-9-]+)\.github\.io$"),
    "heroku":     ("herokuapp.com",   r"No such app", r"^(?P<label>[a-z0-9-]+)\.herokuapp\.com$"),
    "vercel":     ("vercel.app",      r"DEPLOYMENT_NOT_FOUND", r"^(?P<label>[a-z0-9-]+)\.vercel\.app$"),
    "pages":      ("pages.dev",       r"Deployment Not Found", r"^(?P<label>[a-z0-9-]+)\.pages\.dev$"),
    "firebase":   ("web.app",         r"Site Not Found", r"^(?P<label>[a-z0-9-]+)\.(?:web\.app|firebaseapp\.com)$"),
    "fly":        ("fly.dev",         r"^$|not found", r"^(?P<label>[a-z0-9-]+)\.fly\.dev$"),
    "surge":      ("surge.sh",        r"project not found|Surge", r"^(?P<label>[a-z0-9-]+)\.surge\.sh$"),
    "readthedocs":("readthedocs.io",  r"404|not found", r"^(?P<label>[a-z0-9-]+)\.readthedocs\.io$"),
    "pantheon":   ("pantheonsite.io", r"404|not found", r"^(?P<label>[a-z0-9-]+)\.pantheonsite\.io$"),
    "unbounce":   ("unbouncepages.com", r"404|not found", r"^(?P<label>[a-z0-9-]+)\.unbouncepages\.com$"),
    "wixsite":    ("wixsite.com",     r"404|not found", r"^(?P<label>[a-z0-9-]+)\.wixsite\.com$"),
}

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def fetch(url: str, timeout: int = 15) -> tuple[int | None, str]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (recon; contact in DNS SOA)"})
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            return r.status, r.read(20000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read(20000).decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception:
        return None, ""


def probe(row: dict) -> dict:
    label, suffix, sig = row["label"], row["suffix"], row["sig"]
    native = f"{label}.{suffix}"
    code, body = fetch(f"https://{native}/")
    if code is None:
        row["verdict"] = "unknown"
    elif re.search(sig, body, re.I):
        row["verdict"] = "available"
    elif code in (200, 301, 302, 403) and body:
        row["verdict"] = "occupied"
    else:
        row["verdict"] = "unknown"

    # GitHub Pages is the one namespace where the "no site here" page is also what a live *owner* gets,
    # so the shell page proves nothing: 51 of 55 labels in one corpus had live orgs behind them. Ask the
    # API who owns the label; an existing account means only that account can publish, whatever Pages says.
    if row["verdict"] == "available" and row["provider"] == "github":
        st, _ = fetch(f"https://api.github.com/users/{label}")
        if st == 200:
            row["verdict"] = "occupied-owner-exists"
        elif st is None:
            row["verdict"] = "unknown"

    row["native"] = native
    row["http"] = code
    row["excerpt"] = re.sub(r"\s+", " ", body)[:120]
    return row


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="reports/freetier-queue.json")
    ap.add_argument("--workers", type=int, default=16)
    a = ap.parse_args()

    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    edges = set(db.execute("select host, target from cnames").fetchall())
    edges |= set(db.execute("select apex, cname from apex_dns where cname != ''").fetchall())

    rows, seen = [], set()
    for host, target in edges:
        t = (target or "").lower().rstrip(".")
        for kind, (suffix, sig, rx) in PROVIDERS.items():
            m = re.match(rx, t)
            if not m:
                continue
            label = m.group("label")
            key = (kind, label, host)
            if key in seen:
                break
            seen.add(key)
            rows.append({"provider": kind, "label": label, "suffix": suffix, "sig": sig,
                         "host": host, "target": t})
            break
    print(f"free-tier CNAME edges: {len(rows)}  "
          f"({dict(Counter(r['provider'] for r in rows))})")

    # one probe per (provider, label) — the name is the claimable unit, not the victim host
    uniq = {}
    for r in rows:
        uniq.setdefault((r["provider"], r["label"]), r)
    print(f"distinct claimable names: {len(uniq)}")
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        verdicts = {k: v for k, v in zip(uniq, ex.map(probe, uniq.values()))}

    tally = Counter(v["verdict"] for v in verdicts.values())
    print(f"verdicts: {dict(tally)}")

    sys.path.insert(0, str(ROOT / "engine"))
    from scope_cover import covers
    scopes = db.execute("select platform, handle, asset from scopes").fetchall()

    available = [v for v in verdicts.values() if v["verdict"] == "available"]
    print(f"available names: {len(available)}")
    hits = []
    for v in available:
        hosts = sorted({r["host"] for r in rows
                        if r["provider"] == v["provider"] and r["label"] == v["label"]})
        for h in hosts:
            hit = next(((p, hd, at) for p, hd, at in scopes if covers(at, h)), None)
            if hit:
                hits.append({**v, "host": h, "scope": f"{hit[0]}:{hit[1]} via {hit[2]}"})
    print(f"available AND in a published scope: {len(hits)}")
    for h in hits:
        print(f"  {h['provider']:10} {h['native']:44} <- {h['host'][:38]} [{h['scope'][:32]}]")

    Path(ROOT / a.json).write_text(json.dumps(
        {"edges": len(rows), "verdicts": dict(tally), "available": available, "in_scope": hits}, indent=1))
    print("wrote", a.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
