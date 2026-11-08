#!/usr/bin/env python3
"""Second half of the delegation test: does the delegated zone still exist *at* its own nameservers?

`ns_delegation.py` proves a name has a zone cut and that its NS hostnames resolve. That is not enough.
Almost every provider runs shared nameservers — `ns-123.awsdns-45.org` answers for thousands of zones,
so the NS hostname resolving says nothing about whether *this* zone is still hosted. The authoritative
question is asked of the NS itself:

    SOA <zone> @<its own nameserver>

  NOERROR            -> the zone is live, nothing to report
  REFUSED/SERVFAIL   -> the nameservers are up but this zone is not hosted there: a dangling delegation,
                        and the strongest kind, because the provider will hand the name to the next
                        customer who asks for it
  NXDOMAIN           -> the zone is unknown to the NS (often the same outcome, recorded separately)
  timeout            -> unknown, never counted as a finding

Only dangling zones inside a published scope are carried forward.

  python3 engine/ns_zone_check.py --json reports/ns-zone.json
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import dns.exception
import dns.message
import dns.query
import dns.rdatatype
import dns.resolver

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine/state.db"

RES = dns.resolver.Resolver(configure=True)
RES.lifetime, RES.timeout = 5.0, 5.0


def zone_status(zone: str) -> str:
    """Ask the recursive resolver for the zone's SOA.

    Direct authoritative queries are not available on this host: UDP *and* TCP to port 53 are redirected
    to the local stub (127.0.0.53), which answers `REFUSED` with `rd` echoed — proof the reply came from a
    recursive server, not the NS we addressed. A known-hosted zone is the control: if that answers REFUSED
    when addressed directly, then every authoritative result on the box is fiction.

    Recursive status is still a real signal: a zone whose nameservers are lame makes the resolver answer
    SERVFAIL, and a name the parent does not actually delegate answers NXDOMAIN.
    """
    q = dns.message.make_query(zone, dns.rdatatype.SOA)
    for attempt in range(2):
        try:
            r = dns.query.udp(q, RES.nameservers[0], timeout=5)
        except dns.exception.Timeout:
            if attempt == 0:
                continue
            return "timeout"
        except Exception:
            return "error"
        name = dns.rcode.to_text(r.rcode())
        if name == "NOERROR":
            return "served" if r.answer else "no-soa"
        if name == "NXDOMAIN":
            return "nxdomain"
        if name in ("SERVFAIL", "REFUSED", "NOTAUTH"):
            if attempt == 0:
                continue
            return name.lower()
        return name.lower()
    return "timeout"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="reports/ns-zone.json")
    ap.add_argument("--workers", type=int, default=48)
    a = ap.parse_args()

    db = sqlite3.connect(DB, timeout=120)
    db.execute("pragma busy_timeout=120000")
    db.execute("""create table if not exists ns_zone(
        host text primary key, ns text, status text, verdict text, checked_at text)""")
    db.commit()
    done = {r[0] for r in db.execute("select host from ns_zone")}
    cuts = [(h, ns.split(",")) for h, ns in
            db.execute("select host, ns from ns_deleg where verdict='delegated-ok' and ns_live>0")
            if h not in done]
    print(f"delegated cuts with live NS to zone-test: {len(cuts)}  (already done {len(done)})")

    def check(item):
        host, nss = item
        statuses = [(nss[0] if nss else "-", zone_status(host))]
        kinds = [s for _, s in statuses]
        if "served" in kinds or "no-soa" in kinds:
            verdict = "live"
        elif all(k in ("servfail", "nxdomain", "notauth") for k in kinds):
            verdict = "dangling-zone"
        else:
            verdict = "unknown"
        return {"host": host, "ns": nss, "statuses": statuses, "verdict": verdict}

    buf = []
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for r in ex.map(check, cuts):
            buf.append(r)
            if len(buf) >= 200:
                db.executemany("insert or replace into ns_zone(host,ns,status,verdict,checked_at) values(?,?,?,?,?)",
                               [(x["host"], ",".join(x["ns"]),
                                 ",".join(f"{n}={s}" for n, s in x["statuses"]), x["verdict"],
                                 time.strftime("%FT%TZ", time.gmtime())) for x in buf])
                db.commit()
                bad = sum(1 for x in buf if x["verdict"] == "dangling-zone")
                print(f"  {len(buf)} tested, dangling-zone {bad}")
                buf.clear()
    if buf:
        db.executemany("insert or replace into ns_zone(host,ns,status,verdict,checked_at) values(?,?,?,?,?)",
                       [(x["host"], ",".join(x["ns"]),
                         ",".join(f"{n}={s}" for n, s in x["statuses"]), x["verdict"],
                         time.strftime("%FT%TZ", time.gmtime())) for x in buf])
        db.commit()

    sys.path.insert(0, str(ROOT / "engine"))
    from scope_cover import covers
    scopes = db.execute("select platform, handle, asset from scopes").fetchall()
    rows = db.execute("select host, ns, status from ns_zone where verdict='dangling-zone'").fetchall()
    hits = []
    for host, ns, status in rows:
        m = next(((p, h, at) for p, h, at in scopes if covers(at, host)), None)
        rec = {"host": host, "ns": ns.split(","), "status": status,
               "scope": f"{m[0]}:{m[1]}" if m else None}
        hits.append(rec)
    Path(ROOT / a.json).write_text(json.dumps({"dangling": hits}, indent=1))
    ins = [r for r in hits if r["scope"]]
    print(f"\ndangling zones: {len(hits)}   in scope: {len(ins)}")
    for r in ins:
        print(f"  {r['host'][:54]:54} {r['status'][:40]:40} [{r['scope']}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
