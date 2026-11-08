#!/usr/bin/env python3
"""Sweep the CNAME table for takeover providers that `dangling.py` does not know about.

The existing detection covers the free/hobby namespaces (netlify, github.io, heroku, vercel, azure).
It does not cover the two providers that actually show up in this dataset in bulk:

  elb.amazonaws.com        4,449 targets — a deleted Elastic Load Balancer stops resolving, and the name
                           is re-creatable by anyone who can launch an ELB in any account with that name
  shops.myshopify.com        695 targets — a closed Shopify store frees its handle
  *.cloudfront.net          distribution-specific names; a deleted distribution returns the CloudFront
                           error page rather than NXDOMAIN, so HTTP signature matters, not DNS

A dangling target is necessary but not sufficient: the *victim* hostname has to sit inside a published
scope, or the finding is evidence only. That intersection is printed separately and is the only part
worth filing.

  python3 engine/sweep_providers.py --limit 1500 --json reports/provider-sweep.json
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine/state.db"

PROVIDERS = {
    "elb": "elb.amazonaws.com",
    "myshopify": "myshopify.com",
    "cloudfront": "cloudfront.net",
    "s3": "s3.amazonaws.com",
    "appspot": "appspot.com",
}


def dig(name: str, rtype: str = "A") -> str:
    try:
        p = subprocess.run(["dig", "+short", "+time=4", "+tries=2", rtype, name],
                           capture_output=True, text=True, timeout=12)
        return p.stdout.strip()
    except Exception:
        return ""


def classify(target: str) -> str | None:
    t = target.rstrip(".").lower()
    for kind, suffix in PROVIDERS.items():
        if t.endswith("." + suffix):
            # aws s3 has a dozen regional spellings; only the canonical one is worth chasing here
            return kind
    return None


def probe(row: tuple) -> dict | None:
    host, target = row
    kind = classify(target)
    if not kind:
        return None
    a = dig(target)
    status = "DANGLING" if not a else "ALIVE"
    if kind == "cloudfront" and not a:
        status = "DANGLING"
    return {"host": host, "target": target.rstrip("."), "kind": kind,
            "target_a": a, "status": status}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=1500)
    ap.add_argument("--json")
    ap.add_argument("--workers", type=int, default=24)
    a = ap.parse_args()

    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = [(h, t) for h, t in c.execute("select distinct host, target from cnames")
            if t and classify(t)]
    print(f"candidates in {len(PROVIDERS)} provider namespaces: {len(rows)}")
    rows = rows[: a.limit]

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        out = [r for r in ex.map(probe, rows) if r]

    dangling = [r for r in out if r["status"] == "DANGLING"]
    print(f"checked {len(out)}  dangling {len(dangling)}")

    sys.path.insert(0, str(ROOT / "engine"))
    from scope_cover import covers
    scopes = c.execute("select platform, handle, asset from scopes").fetchall()
    payable = []
    for r in dangling:
        hit = next(((pl, hd, at) for pl, hd, at in scopes if covers(at, r["host"])), None)
        if hit:
            r["scope"] = f"{hit[0]}:{hit[1]} via {hit[2]}"
            payable.append(r)

    print(f"dangling inside a published scope: {len(payable)}")
    for r in payable[:40]:
        print(f"  {r['kind']:10} {r['host']:44} -> {r['target']:46} [{r['scope']}]")
    by_kind: dict[str, int] = {}
    for r in dangling:
        by_kind[r["kind"]] = by_kind.get(r["kind"], 0) + 1
    print("dangling by provider:", by_kind)

    if a.json:
        Path(a.json).write_text(json.dumps(
            {"checked": len(out), "dangling": dangling, "payable": payable}, indent=1))
        print("wrote", a.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
