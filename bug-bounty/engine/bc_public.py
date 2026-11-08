#!/usr/bin/env python3
"""Public Bugcrowd engagement directory — 297 programmes, no API token required.

`https://bugcrowd.com/engagements.json` is served without auth and returns every public engagement with
its reward range, access status and type. That is discovery: it tells us which programmes pay and whether
they are accepting, without the Hacker API that support still has to enable.

Scope itself is *not* public (the per-engagement target_groups endpoints 301 to login), so scope matching
keeps using bounty-targets-data through `scopes` in state.db. This script's job is the other half: knowing
which of those programmes actually accept submissions today.

  python3 engine/bc_public.py                  # write engine/data/bc_engagements.json
  python3 engine/bc_public.py --bounty-only    # just the paying ones, printed
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
import time
from pathlib import Path

import urllib.request

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "engine" / "data" / "bc_engagements.json"


def get(url: str, tries: int = 4) -> dict:
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (rdwlabz-recon)",
                "X-Requested-With": "XMLHttpRequest",
            })
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            if attempt == tries - 1:
                print(f"  ! {url} -> {e}")
                return {}
            time.sleep(2 * (attempt + 1))
    return {}


def money(s: str | None) -> int:
    if not s:
        return 0
    n = re.sub(r"[^0-9]", "", s)
    return int(n) if n else 0


def main() -> None:
    rows, page, total = [], 1, None
    while True:
        d = get(f"https://bugcrowd.com/engagements.json?page={page}")
        eng = d.get("engagements") or []
        total = (d.get("paginationMeta") or {}).get("totalCount") or total
        if not eng:
            break
        for e in eng:
            rs = e.get("rewardSummary") or {}
            rows.append({
                "slug": (e.get("briefUrl") or "").rsplit("/", 1)[-1],
                "name": e.get("name"),
                "url": f"https://bugcrowd.com{e.get('briefUrl')}" if e.get("briefUrl") else None,
                "type": (e.get("productEngagementType") or {}).get("label"),
                "access": e.get("accessStatus"),
                "private": bool(e.get("isPrivate")),
                "min_reward": money(rs.get("minReward")),
                "max_reward": money(rs.get("maxReward")),
                "reward_summary": rs.get("summary"),
                "service_level": e.get("serviceLevel"),
                "industry": e.get("industryName"),
                "ends_at": e.get("endsAt"),
            })
        page += 1
        time.sleep(0.4)
        if total and len(rows) >= total:
            break

    Out = sorted(rows, key=lambda r: (-(r["max_reward"] or 0), r["name"] or ""))
    OUT.write_text(json.dumps({"total": len(Out), "engagements": Out}, indent=2) + "\n")
    paying = [r for r in Out if (r["max_reward"] or 0) > 0 and r["access"] == "open"]
    print(f"{len(Out)} public engagements · {len(paying)} paying and open -> {OUT.relative_to(ROOT)}")

    # how many of those do we already have scope for?
    db = sqlite3.connect(f"file:{ROOT / 'engine' / 'state.db'}?mode=ro", uri=True)
    have = {r[0].strip().lower() for r in db.execute("select distinct handle from scopes where platform='bc'")}
    covered = [r for r in paying if any(h and h in (r["name"] or "").lower() for h in have)]
    print(f"  {len(covered)} of them look like they have scope rows in state.db already")

    if "--bounty-only" in sys.argv:
        for r in paying:
            print(f"  ${r['min_reward']:>6}-${r['max_reward']:<7} {r['slug'][:44]:<44} {r['name'][:40]}")


if __name__ == "__main__":
    main()
