#!/usr/bin/env python3
"""Which of the free-tier takeover candidates actually sit inside a published scope?

Availability is not a finding. `kubernetes.netlify.app` has no site attached, but it is someone's name
in a free-tier namespace, not a vulnerability, unless a *programme's* hostname still points at it. So
this joins reports/freeclaim.json (what the providers say is unclaimed) against the scopes table using
the exact-asset-or-wildcard rule from scope_cover, and prints only the intersections.

  python3 engine/freeclaim_scope.py
  python3 engine/freeclaim_scope.py --json reports/freeclaim-scoped.json
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

from scope_cover import covers

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine/state.db"
FREE = ROOT / "reports/freeclaim.json"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json")
    ap.add_argument("--all", action="store_true", help="include UNKNOWN verdicts as well")
    a = ap.parse_args()

    cand = json.loads(FREE.read_text())
    if not a.all:
        cand = [c for c in cand if c["verdict"] == "AVAILABLE"]
    scopes = sqlite3.connect(f"file:{DB}?mode=ro", uri=True).execute(
        "SELECT platform, handle, asset, asset_type, bounty FROM scopes").fetchall()

    rows = []
    for c in cand:
        for host in c.get("hosts", []):
            for platform, handle, asset, atype, bounty in scopes:
                how = covers(asset, host)
                if not how:
                    continue
                rows.append({"host": host, "target": c["target"], "ns": c["ns"],
                             "verdict": c["verdict"], "how": how, "platform": platform,
                             "handle": handle, "asset": asset, "bounty": bool(bounty),
                             "claim": c.get("why", "")})

    # collapse to one row per host+programme, exact beats wildcard
    best: dict[tuple, dict] = {}
    for r in rows:
        k = (r["host"], r["platform"], r["handle"])
        cur = best.get(k)
        if cur is None or (cur["how"] == "wildcard" and r["how"] == "exact"):
            best[k] = r
    out = sorted(best.values(), key=lambda r: (r["platform"], r["handle"], r["host"]))

    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=1))
    cur_key = None
    for r in out:
        k = (r["platform"], r["handle"])
        if k != cur_key:
            print(f"\n{r['platform']}:{r['handle']}  (bounty={r['bounty']})")
            cur_key = k
        print(f"   {r['host']:50} -> {r['target']:38} [{r['how']}] via {r['asset']}")
    print(f"\n{len(out)} free-tier candidate(s) inside a published scope")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
