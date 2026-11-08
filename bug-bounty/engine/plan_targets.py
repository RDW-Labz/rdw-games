#!/usr/bin/env python3
"""Rank the corpus by payout and hand the enumerator its next batch.

The nightly sweep spends a fixed budget of DNS on whatever `domains` happens to hold, in insertion order.
That is the wrong order: a $3,000,000 programme and a $500 marketplace get the same share. This joins
`scopes` -> `programs` on the programme's own maximum bounty, ranks apexes by the best payout that covers
them, and prints (or seeds) the next batch.

  python3 engine/plan_targets.py                 # show the ranking
  python3 engine/plan_targets.py --queue 40      # insert the top 40 un-enumerated apexes as bounty:ranked
  python3 engine/plan_targets.py --queue 40 --stale 7   # also re-queue anything not enumerated in 7d
"""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "engine" / "data" / "target_plan.json"


def money(v) -> int:
    if v is None:
        return 0
    s = str(v)
    digits = "".join(c for c in s if c.isdigit())
    return int(digits) if digits else 0


def main() -> None:
    args = sys.argv[1:]
    queue = int(args[args.index("--queue") + 1]) if "--queue" in args else 0
    stale_days = int(args[args.index("--stale") + 1]) if "--stale" in args else 0

    db = sqlite3.connect(ROOT / "engine" / "state.db")
    db.row_factory = sqlite3.Row

    best: dict[str, dict] = {}
    for r in db.execute("""
        select s.apex as apex, s.platform, s.handle, s.asset, p.name, p.max_bounty, p.url
        from scopes s join programs p
          on p.platform = s.platform and p.handle = s.handle
        where s.bounty = 1 and s.apex is not null and s.apex <> '' and p.offers_bounty = 1
    """):
        apex = r["apex"].strip().lower()
        if not apex or apex.count(".") < 1:
            continue
        b = money(r["max_bounty"])
        cur = best.get(apex)
        if cur is None or b > cur["max_reward"]:
            best[apex] = {"apex": apex, "max_reward": b, "platform": r["platform"],
                          "handle": r["handle"].strip(), "program": r["name"], "url": r["url"]}

    known = {r["domain"]: r["last_enum"] for r in db.execute("select domain, last_enum from domains")}
    cutoff = datetime.now(timezone.utc) - timedelta(days=stale_days) if stale_days else None

    plan = []
    for apex, info in best.items():
        last = known.get(apex)
        if last is None:
            status = "new"
        elif cutoff and datetime.fromisoformat(last) < cutoff:
            status = "stale"
        else:
            status = "done"
        if status == "new" or (status == "stale" and cutoff):
            plan.append({**info, "status": status})
    plan.sort(key=lambda r: -r["max_reward"])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(plan, indent=2) + "\n")
    print(f"{len(best)} bounty-covered apexes · {len(plan)} worth enumerating")
    for r in plan[:25]:
        print(f"  ${r['max_reward']:>9,}  {r['apex'][:38]:<38} {r['platform']}  {r['program'][:34]}")

    if queue:
        added = 0
        for r in plan:
            if added >= queue:
                break
            if r["status"] != "new":
                continue  # only brand-new apexes; stale ones are handled by dangling.py --days
            db.execute("insert into domains(domain, org, policy, contact, tier, last_enum) "
                       "values(?,?,?,?,?,NULL)",
                       (r["apex"], r["handle"], r["url"] or "", "", "bounty:ranked"))
            added += 1
        db.commit()
        print(f"queued {added} apex(es) as tier bounty:ranked")


if __name__ == "__main__":
    main()
