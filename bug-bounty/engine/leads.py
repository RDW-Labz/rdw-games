#!/usr/bin/env python3
"""Build a re-verified prospect queue: companies whose DNS is dangling *and* who have no bug bounty.

Two corpora live in `state.db`: 34,353 domains / 541,926 hosts of proven dangling and dead-target
records, and 43,365 scope rows across 909 programmes. Their intersection is the reason the bounty
lane pays nothing — if a company publishes a programme, the same finding is worth $0 to us and the
fix is free to them. The complement is the saleable set: they own the dangling record, nobody is
going to tell them for free, and the repair is a ten-minute DNS change.

Every row is re-verified with a live query at queue time, because a queue built on `cnames.seen`
from three weeks ago produces emails claiming a dangling CNAME that now resolves — the one mistake
that turns a security offer into spam.

Read-only with respect to the world: `dig` queries, nothing fetched, nothing written to any target.

  python3 engine/leads.py --top 120 --out outreach/queue.json
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dangling import DB, _status, dig, provider_for  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def scope_covered(c: sqlite3.Connection) -> set[str]:
    """Every apex with any scope row on any platform — paid, VDP, or informational."""
    out: set[str] = set()
    for (apex, asset) in c.execute("select coalesce(apex,''), coalesce(asset,'') from scopes"):
        for v in (apex, asset):
            v = (v or "").strip().lower().lstrip("*.").strip(".")
            if v and "/" not in v and " " not in v:
                out.add(v)
                parts = v.split(".")
                if len(parts) > 2:
                    out.add(".".join(parts[-2:]))
    return out


def verify(host: str, target: str, claimable_only: bool = False) -> dict | None:
    """Confirm the record still dangles right now. Returns None when it is no longer a finding."""
    ans = dig(["+short", host, "CNAME"]).strip().lower().rstrip(".")
    if ans != target.lower().rstrip("."):
        return None
    st = _status(target)
    if st in ("live", "provider-live"):
        return None
    prov = provider_for(target, host) or ()
    name, ok = (prov + (None, False))[:2]
    # A dead CloudFront distribution (`d1234.cloudfront.net`) is a real outage but not a takeable
    # name: AWS does not hand that hostname to another account. Selling "your CDN is broken" is a
    # support ticket, not a security finding, so those stay out of the claimable queue.
    if claimable_only and not ok:
        return None
    return {"host": host, "target": target, "status": st,
            "provider": name or "", "claimable": bool(ok)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=120, help="companies to keep in the queue")
    ap.add_argument("--per-company", type=int, default=2)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--out", default="outreach/queue.json")
    ap.add_argument("--claimable", action="store_true",
                    help="keep only names in a namespace another account can actually claim")
    a = ap.parse_args()

    c = sqlite3.connect(str(DB))
    covered = scope_covered(c)
    rows = c.execute("""
        select d.domain, coalesce(d.org,''), coalesce(d.contact,''), n.host, n.target
        from cnames n
        join hosts h on h.host = n.host
        join domains d on d.domain = h.domain
        where coalesce(n.alive,'') in ('False', '0') and coalesce(n.target,'') <> ''
        order by d.domain, n.host""").fetchall()

    per: dict[str, list[tuple[str, str]]] = {}
    meta: dict[str, tuple[str, str]] = {}
    for dom, org, contact, host, target in rows:
        if dom in covered or ".".join(dom.split(".")[-2:]) in covered:
            continue
        per.setdefault(dom, []).append((host, target))
        meta[dom] = (org, contact)

    print(f"{len(rows)} dead records · {len(per)} companies with no published programme")
    ranked = sorted(per.items(), key=lambda kv: -len(kv[1]))[: a.top * 3]

    jobs = [(dom, h, t) for dom, recs in ranked for h, t in recs[: a.per_company]]
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        checked = list(ex.map(lambda j: verify(j[1], j[2], a.claimable), jobs))

    live: dict[str, list[dict]] = {}
    for (dom, h, t), res in zip(jobs, checked):
        if res:
            live.setdefault(dom, []).append(res)

    out = []
    for dom, recs in sorted(live.items(), key=lambda kv: -len(kv[1]))[: a.top]:
        org, contact = meta[dom]
        out.append({"domain": dom, "org": org, "contact": contact,
                    "records": recs, "count": len(recs)})

    path = ROOT / a.out
    path.write_text(json.dumps({"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                "companies": out}, indent=2) + "\n")
    total = sum(o["count"] for o in out)
    print(f"re-verified {len(jobs)} records -> {total} still dangling across {len(out)} companies")
    for o in out[:12]:
        r = o["records"][0]
        print(f"  {o['domain']:<34} {o['count']} rec  {r['host']} -> {r['target']} [{r['status']}]")
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
