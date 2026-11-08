#!/usr/bin/env python3
"""Resolve the in-scope apex domains nobody has ever looked at.

Measured 2026-11-03: 31,457 H1 apex domains in scope, 1,836 of them have any recorded host — 5%. The
dangling sweep that produced 70 in-scope takeover candidates only had those 5% to look at, so coverage,
not provider breadth, is the binding constraint on finding more.

This resolves apex A and CNAME records into `apex_dns` and is resumable: rows already present are
skipped, so it can be stopped and restarted without losing progress or re-querying.

  python3 engine/resolve_apex.py --limit 3000        # bounded run
  python3 engine/resolve_apex.py                     # everything left
"""
from __future__ import annotations

import argparse
import sqlite3
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine/state.db"


def dig(name: str, rtype: str) -> str:
    try:
        p = subprocess.run(["dig", "+short", "+time=3", "+tries=2", rtype, name],
                           capture_output=True, text=True, timeout=10)
        return " ".join(p.stdout.split())[:300]
    except Exception:
        return ""


def probe(apex: str) -> tuple[str, str, str]:
    return apex, dig(apex, "A"), dig(apex, "CNAME")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=40)
    ap.add_argument("--platform", default="h1")
    a = ap.parse_args()

    db = sqlite3.connect(DB, timeout=30)
    db.execute("""CREATE TABLE IF NOT EXISTS apex_dns (
                    apex TEXT PRIMARY KEY, a TEXT, cname TEXT, checked_at TEXT)""")
    db.commit()

    rows = db.execute(
        f"""SELECT DISTINCT lower(ltrim(asset,'*.')) FROM scopes
            WHERE platform=? AND asset IS NOT NULL""", (a.platform,)).fetchall()
    apex = set()
    for (x,) in rows:
        x = (x or "").strip().lower().lstrip("*.").split("/")[0].rstrip(".")
        if x and "." in x:
            apex.add(x)
    done = {r[0] for r in db.execute("SELECT apex FROM apex_dns")}
    todo = sorted(apex - done)
    if a.limit:
        todo = todo[: a.limit]
    print(f"scoped apex: {len(apex)}  already resolved: {len(done)}  this run: {len(todo)}", flush=True)
    if not todo:
        return 0

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for i, (name, arec, cname) in enumerate(ex.map(probe, todo), 1):
            db.execute("INSERT OR REPLACE INTO apex_dns VALUES (?,?,?,datetime('now'))",
                       (name, arec, cname.rstrip(".")))
            if i % 500 == 0:
                db.commit()
                rate = i / max(time.time() - t0, 1e-6)
                print(f"  {i}/{len(todo)}  {rate:.0f}/s", flush=True)
    db.commit()

    live = db.execute("SELECT count(*) FROM apex_dns WHERE a != ''").fetchone()[0]
    total = db.execute("SELECT count(*) FROM apex_dns").fetchone()[0]
    pointed = db.execute("SELECT count(*) FROM apex_dns WHERE cname != ''").fetchone()[0]
    print(f"\napex_dns: {total} rows  {live} resolve  {pointed} have a CNAME  "
          f"({(time.time()-t0):.0f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
