#!/usr/bin/env python3
"""Which of the graded claimable hosts are actually inside a live HackerOne asset?

Reads `findings where claimable=1` from state.db, maps each host to candidate programmes via the
(over-broad) scopes table, then asks HackerOne itself through h1_scope. Prints IN with the asset id
that must be cited, or OUT with the programmes that own the apex but do not list the host.

    python3 engine/claimable_scope_report.py
"""
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))
import h1_scope  # noqa: E402

c = sqlite3.connect(ROOT / "engine" / "state.db")
c.row_factory = sqlite3.Row
hosts = [r["host"] for r in c.execute("SELECT host FROM findings WHERE claimable=1 ORDER BY host")]
counts = {"in": 0, "out": 0, "none": 0}
for h in hosts:
    handles = sorted({r["handle"] for r in c.execute(
        "SELECT handle FROM scopes WHERE ? = apex OR ? LIKE '%.'||apex", (h, h))})
    if not handles:
        counts["none"] += 1
        print(f"{h:42} no programme in scope table")
        continue
    hits = []
    for hd in handles:
        m = h1_scope.match(hd, h, need_bounty=True)
        if m:
            hits.append(f"{hd} scope={m['id']} asset={m['asset']}")
    if hits:
        counts["in"] += 1
        print(f"{h:42} IN   " + " | ".join(hits))
    else:
        counts["out"] += 1
        print(f"{h:42} OUT  of " + ", ".join(handles))
print(f"\n{counts['in']} in-scope / {counts['out']} out-of-scope / {counts['none']} no programme "
      f"— {len(hosts)} claimable hosts")
