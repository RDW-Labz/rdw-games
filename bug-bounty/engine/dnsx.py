#!/usr/bin/env python3
"""Dangling NS / MX dependencies.

CNAMEs are the class everybody hunts. Two other record types hand a stranger control of something the
vendor still owns:

  NS  — if a delegation names a nameserver host whose domain has lapsed, whoever registers that domain
        answers every query for the whole zone (or, in practice, the zone stops resolving and anything
        that trusts it can be redirected).
  MX  — if mail for a domain is delivered to a host under a lapsed domain, whoever registers that domain
        receives every message sent to the vendor — password resets included.

Both are decided the same way: take the hostname out of the record, strip it to its registrable domain,
and ask whether that domain is still registered (NS/SOA at the apex). A domain with no delegation at all
is the finding; one that answers NS is registered whatever else is wrong with it.

Passive: DNS queries only, run from the resolver, nothing sent to the customer's servers.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import sqlite3
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from programs import apex  # noqa: E402

DB = Path(__file__).with_name("state.db")


def db() -> sqlite3.Connection:
    c = sqlite3.connect(DB, timeout=30)
    c.execute("PRAGMA busy_timeout=30000")
    c.execute("""CREATE TABLE IF NOT EXISTS dns_deps(
                   domain TEXT, rtype TEXT, value TEXT, apex TEXT, apex_ns INTEGER,
                   resolves INTEGER, verdict TEXT, checked_at TEXT,
                   PRIMARY KEY(domain, rtype, value))""")
    return c


def dig(name: str, rtype: str) -> list[str]:
    try:
        out = subprocess.run(["dig", "+short", rtype, name], capture_output=True, text=True,
                             timeout=12).stdout
    except Exception:  # noqa: BLE001
        return []
    vals = []
    for line in out.splitlines():
        line = line.strip().rstrip(".")
        if not line:
            continue
        if rtype == "MX":
            parts = line.split()
            line = parts[-1] if parts else ""
        vals.append(line.rstrip("."))
    return [v for v in vals if v]


def apex_alive(domain: str) -> bool:
    return bool(dig(domain, "NS") or dig(domain, "SOA"))


def resolves(name: str) -> bool:
    return bool(dig(name, "A") or dig(name, "CNAME"))


def cmd_run(a) -> None:
    c = db()
    domains = [r[0] for r in c.execute(
        "SELECT domain FROM domains WHERE tier LIKE 'bounty:%' ORDER BY domain")]
    if a.limit:
        domains = domains[: a.limit]
    print(f"{len(domains)} paying-programme apexes")

    deps: dict[tuple[str, str], set[str]] = defaultdict(set)

    def grab(d):
        return d, dig(d, "NS"), dig(d, "MX")

    with cf.ThreadPoolExecutor(max_workers=max(1, a.workers)) as ex:
        for d, ns, mx in ex.map(grab, domains):
            for v in ns:
                deps[(d, "NS")].add(v)
            for v in mx:
                deps[(d, "MX")].add(v)

    print(f"{sum(len(v) for v in deps.values())} NS/MX records; checking the domains they point at")

    # one registration check per distinct target apex
    targets = sorted({a for a in (apex(v) for vals in deps.values() for v in vals) if a})
    alive = {}
    with cf.ThreadPoolExecutor(max_workers=max(1, a.workers)) as ex:
        for t, ok in zip(sorted(targets), ex.map(apex_alive, sorted(targets))):
            alive[t] = ok

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    hits = 0
    for (dom, rtype), vals in sorted(deps.items()):
        for v in sorted(vals):
            ap = apex(v)
            ns_ok = alive.get(ap, True)
            res = resolves(v)
            if not ns_ok:
                verdict, hits = "DANGLING", hits + 1
            elif not res:
                verdict = "DEAD-BUT-REGISTERED"
            else:
                verdict = "OK"
            c.execute("""INSERT INTO dns_deps(domain,rtype,value,apex,apex_ns,resolves,verdict,checked_at)
                         VALUES(?,?,?,?,?,?,?,?)
                         ON CONFLICT(domain,rtype,value) DO UPDATE SET apex_ns=excluded.apex_ns,
                           resolves=excluded.resolves, verdict=excluded.verdict,
                           checked_at=excluded.checked_at""",
                      (dom, rtype, v, ap, int(ns_ok), int(res), verdict, now))
        c.commit()
    print(f"done — {hits} DANGLING record(s)")


def cmd_show(a) -> None:
    c = db()
    for v in ("DANGLING", "DEAD-BUT-REGISTERED", "OK"):
        print(f"{v:20} {c.execute('select count(*) from dns_deps where verdict=?', (v,)).fetchone()[0]}")
    print()
    for r in c.execute("""SELECT domain,rtype,value,apex FROM dns_deps
                          WHERE verdict='DANGLING' ORDER BY rtype,domain"""):
        print(f"  {r[1]:3} {r[0][:34]:34} -> {r[2][:40]:40} (apex {r[3][:28]} unregistered)")
    print()
    for r in c.execute("""SELECT domain,rtype,value FROM dns_deps
                          WHERE verdict='DEAD-BUT-REGISTERED' ORDER BY rtype LIMIT 40"""):
        print(f"  {r[1]:3} {r[0][:34]:34} -> {r[2][:40]}")


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.set_defaults(fn=cmd_run)
    r.add_argument("--workers", type=int, default=16); r.add_argument("--limit", type=int, default=0)
    s = sub.add_parser("show"); s.set_defaults(fn=cmd_show)
    a = p.parse_args(); a.fn(a)


if __name__ == "__main__":
    main()
