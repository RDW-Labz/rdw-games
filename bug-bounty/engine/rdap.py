#!/usr/bin/env python3
"""Is the domain a dangling CNAME points at still registered?

A CNAME can only be hijacked if the target's namespace is claimable. For provider-hosted names that means
a free account name; for third-party *domains* it means the registration lapsed. That second case is the
one no provider fingerprint can see, and it is the strongest kind of takeover evidence there is: whoever
registers the expired domain owns every subdomain that still points at it, plus its mail.

RDAP is the registry's own answer (`rdap.org` redirects to the authoritative server), so this pass is
passive public-record lookup — no request to the customer's host, nothing that touches their infrastructure.

    python3 rdap.py run [--workers 3]      # checks every dead CNAME target's registrable domain
    python3 rdap.py show                   # available / registered / unknown, with registrar + expiry
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from programs import apex  # noqa: E402

import subprocess  # noqa: E402


def has_ns(domain: str) -> bool:
    """Registries answer NS for every live registration; an empty answer is the real signal.

    rdap.org returns 404 for whole TLDs it cannot bootstrap (every .io domain looked "available"), so
    RDAP alone cannot decide availability. DNS can: no NS and no SOA at the apex means nothing serves
    that name.
    """
    try:
        out = subprocess.run(["dig", "+short", "NS", domain], capture_output=True, text=True, timeout=12)
        soa = subprocess.run(["dig", "+short", "SOA", domain], capture_output=True, text=True, timeout=12)
        return bool(out.stdout.strip() or soa.stdout.strip())
    except Exception:  # noqa: BLE001
        return True  # never call something available on a lookup failure

DB = Path(__file__).with_name("state.db")
UA = "Mozilla/5.0 (compatible; rdwlabz-recon/1.0)"


def db() -> sqlite3.Connection:
    c = sqlite3.connect(DB, timeout=30)
    c.execute("PRAGMA busy_timeout=30000")
    c.execute("""CREATE TABLE IF NOT EXISTS rdap(
                   domain TEXT PRIMARY KEY, http INTEGER, status TEXT, registrar TEXT,
                   expires TEXT, note TEXT, checked_at TEXT)""")
    return c


def rdap(domain: str, timeout: int = 20):
    url = f"https://rdap.org/domain/{domain}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rdap+json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            code = r.status
    except urllib.error.HTTPError as e:
        if e.code in (404, 410):
            return 404, "AVAILABLE", "", "", "registry says the domain is not registered"
        return e.code, "UNKNOWN", "", "", f"rdap http {e.code}"
    except Exception as e:  # noqa: BLE001
        return 0, "UNKNOWN", "", "", f"{type(e).__name__}"
    try:
        d = json.loads(raw.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return code, "UNKNOWN", "", "", "unparseable rdap body"

    registrar, expires = "", ""
    for e in d.get("events", []):
        if e.get("eventAction") == "expiration":
            expires = e.get("eventDate", "")[:10]
    for ent in d.get("entities", []):
        roles = ent.get("roles") or []
        if "registrar" in roles:
            for v in (ent.get("vcardArray") or [[], []])[1] or []:
                if isinstance(v, list) and v and v[0] == "fn":
                    registrar = str(v[3])[:60]
    # status list is worth keeping: pendingDelete / redemptionPeriod mean it is on the way out
    st = ",".join(d.get("status", []))[:80]
    return code, "REGISTERED", registrar, expires, st


def cmd_run(a) -> None:
    c = db()
    targets = [r[0] for r in c.execute("SELECT DISTINCT target FROM cnames WHERE target IS NOT NULL")]
    doms = sorted({apex(t) for t in targets if apex(t)})
    print(f"{len(targets)} distinct CNAME targets -> {len(doms)} registrable domains")

    def work(d):
        if has_ns(d):
            return (d, 0, "REGISTERED", "", "", "apex answers NS/SOA")
        time.sleep(0.2)
        code, status, registrar, expires, note = rdap(d)
        if status == "AVAILABLE":
            return (d, code, "AVAILABLE", registrar, expires, "no NS/SOA at apex and registry 404")
        return (d, code, "LAPSED", registrar, expires, note)

    with cf.ThreadPoolExecutor(max_workers=max(1, a.workers)) as ex:
        for d, code, status, registrar, expires, note in ex.map(work, doms):
            c.execute("""INSERT INTO rdap(domain,http,status,registrar,expires,note,checked_at)
                         VALUES(?,?,?,?,?,?,?)
                         ON CONFLICT(domain) DO UPDATE SET http=excluded.http, status=excluded.status,
                           registrar=excluded.registrar, expires=excluded.expires,
                           note=excluded.note, checked_at=excluded.checked_at""",
                      (d, code, status, registrar, expires, note,
                       datetime.now(timezone.utc).isoformat(timespec="seconds")))
            c.commit()
            if status == "AVAILABLE":
                print(f"  AVAILABLE  {d}", flush=True)
    print("rdap pass done")


def cmd_show(a) -> None:
    c = db()
    for st in ("AVAILABLE", "REGISTERED", "UNKNOWN"):
        n = c.execute("SELECT count(*) FROM rdap WHERE status=?", (st,)).fetchone()[0]
        print(f"{st:11} {n}")
    print()
    rows = c.execute("SELECT domain,note FROM rdap WHERE status='AVAILABLE' ORDER BY domain").fetchall()
    if rows:
        print("unregistered targets (takeover possible by registering the domain):")
        for d, note in rows:
            hosts = [r[0] for r in c.execute("""SELECT c.host FROM cnames c WHERE c.target LIKE ?
                                                OR c.target LIKE ?""", (f"%.{d}", d))]
            print(f"  {d:34} {len(hosts)} host(s) -> {', '.join(hosts[:4])}")


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.set_defaults(fn=cmd_run); r.add_argument("--workers", type=int, default=3)
    s = sub.add_parser("show"); s.set_defaults(fn=cmd_show)
    a = p.parse_args(); a.fn(a)


if __name__ == "__main__":
    main()
