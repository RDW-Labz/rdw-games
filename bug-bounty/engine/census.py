#!/usr/bin/env python3
"""Census: how many hosts in the paying corpus actually expose something, per exposure class.

The takeover and JS lanes each answered "is *this* class worth sweeping?" with a zero. This asks the
question the other way round: take a shallow sample of in-scope hosts, throw the cheap fixed-path
probes at all of them at once, and print the hit rate per class with its denominator. A class that
hits 0/1500 is dead and should never get a cron; a class that hits 3/1500 hands us the hosts worth
reading by hand.

The trap this design exists to avoid: half the modern web answers 200 with an SPA shell for any path,
so a naive scanner "discovers" .git/config on thousands of hosts that are all the same index.html.
Every host therefore gets a control probe first — a random path that cannot exist. If the control
comes back 200 the host is a catch-all, and a finding there must match the class signature *and*
differ from the control body, or it is discarded. Hosts whose control probe fails to answer at all
are dropped before the expensive probes, which is also what keeps the run inside a few minutes.

One GET per path. No payloads, no auth, no state change — the same passive posture as every other
lane, and nothing is fetched from a host without a published scope.

  python3 engine/census.py --limit 1500 --workers 96
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jsscan import DB, build_scope_index, covering_scope, fetch  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# (path, label, signature). A signature is what separates a real hit from a soft-404 page: status
# codes lie constantly, the bytes do not.
CHECKS: list[tuple[str, str, re.Pattern]] = [
    ("/.git/config", "git-config", re.compile(r"\[core\]|repositoryformatversion", re.I)),
    ("/.env", "dotenv", re.compile(r"^[A-Z][A-Z0-9_]{2,32}\s*=\s*\S", re.M)),
    ("/.DS_Store", "ds-store", re.compile(r"Bud1")),
    ("/.svn/entries", "svn", re.compile(r"^\d+\s*$|^dir\s*$", re.M)),
    ("/server-status", "apache-status", re.compile(r"Apache Server Status|Server uptime", re.I)),
    ("/actuator/env", "spring-env", re.compile(r'"propertySources"|"activeProfiles"')),
    ("/actuator/health", "spring-health", re.compile(r'"status"\s*:\s*"(UP|DOWN)"')),
    ("/swagger-ui/index.html", "swagger", re.compile(r"Swagger\s*UI|swagger-ui", re.I)),
    ("/v2/api-docs", "swagger-2", re.compile(r'"swagger"\s*:\s*"2')),
    ("/openapi.json", "openapi", re.compile(r'"openapi"\s*:\s*"3')),
    ("/wp-json/wp/v2/users", "wp-users", re.compile(r'"slug"\s*:\s*"')),
    ("/debug/vars", "go-expvar", re.compile(r'"cmdline"|"memstats"')),
    ("/phpinfo.php", "phpinfo", re.compile(r"phpinfo\(\)|PHP Version", re.I)),
    ("/crossdomain.xml", "crossdomain", re.compile(r"<cross-domain-policy", re.I)),
]


def control(host: str) -> tuple[bool, str]:
    """Alive? And is this host a catch-all that 200s any path?"""
    st, body = fetch(f"https://{host}/zz{random.randrange(16**8):08x}-nx", timeout=6.0)
    if st == 0:
        return False, ""
    return True, (hashlib.sha256(body.encode()).hexdigest()[:16] if st == 200 and body else "")


def probe(host: str, path: str, label: str, sig: re.Pattern,
          catchall: bool, ctl_hash: str, meta: tuple[str, list[tuple[str, str]]]) -> dict | None:
    st, body = fetch(f"https://{host}{path}", timeout=6.0)
    if st != 200 or not body:
        return None
    if not sig.search(body[:200_000]):
        return None
    sha = hashlib.sha256(body.encode()).hexdigest()[:16]
    if catchall and sha == ctl_hash:
        return None
    base, rows = meta
    return {"host": host, "path": path, "kind": label, "len": len(body), "sha": sha,
            "scope": base, "platform": rows[0][0], "handle": rows[0][1]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=1500, help="hosts to probe")
    ap.add_argument("--workers", type=int, default=96)
    ap.add_argument("--paying", action="store_true", default=True)
    ap.add_argument("--match", default="", help="regex the hostname must match")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json-out", default="reports/census.json")
    a = ap.parse_args()

    db = sqlite3.connect(str(DB))
    exact, wild = build_scope_index(db, a.paying)
    hosts = [r[0] for r in db.execute(
        """select h.host from hosts h join apex_dns d on d.apex = h.domain
           where d.a is not null and d.a <> '' order by random()""")]
    rx = re.compile(a.match) if a.match else None

    pool: dict[str, tuple[str, list[tuple[str, str]]]] = {}
    order: list[str] = []
    for h in hosts:
        if rx and not rx.search(h):
            continue
        base, rows = covering_scope(h, exact, wild)
        if not base:
            continue
        pool[h] = (base, rows)
        order.append(h)
        if len(order) >= max(a.limit * 6, 4000):
            break
    # Shallow names are where applications live; a depth-4 internal host mostly answers 403 and
    # would drag every class's hit rate toward zero without telling us anything.
    order.sort(key=lambda h: (h.count("."), len(h)))
    picked = order[: a.limit]

    print(f"{len(hosts)} resolvable in-scope hosts · probing {len(picked)} × {len(CHECKS)} paths "
          f"(paying={a.paying})", flush=True)
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        ctl = dict(zip(picked, ex.map(control, picked)))
    alive = [h for h in picked if ctl[h][0]]
    catchalls = [h for h in alive if ctl[h][1]]
    print(f"control pass: {len(alive)}/{len(picked)} answered, {len(catchalls)} catch-all "
          f"({time.time() - t0:.0f}s)", flush=True)

    jobs = [(h, p, lab, sig, bool(ctl[h][1]), ctl[h][1])
            for h in alive for (p, lab, sig) in CHECKS]
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        results = [r for r in ex.map(lambda j: probe(j[0], j[1], j[2], j[3], j[4], j[5],
                                                     pool[j[0]]), jobs) if r]

    by_class: dict[str, int] = {label: 0 for _, label, _ in CHECKS}
    for r in results:
        by_class[r["kind"]] += 1

    print(f"\n{len(jobs)} probes in {time.time() - t0:.0f}s · {len(results)} signature-confirmed hits")
    print(f"{'class':<16} {'hits':>5} {'per 1000 hosts':>15}  sample")
    print("-" * 74)
    for path, label, _ in CHECKS:
        n = by_class[label]
        ex = next((h for h in results if h["kind"] == label), None)
        s = f"{ex['host'] if ex else ''}{ex['path'] if ex else ''} [{ex['platform']}:{ex['handle']}]" if ex else ""
        print(f"{label:<16} {n:>5} {n / max(len(alive), 1) * 1000:>15.1f}  {s[:42]}")

    out = ROOT / a.json_out
    out.write_text(json.dumps({
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "probed": len(picked), "alive": len(alive), "catchall": len(catchalls),
        "by_class": by_class, "hits": results}, indent=2) + "\n")
    print(f"\nwrote {a.json_out} ({len(results)} hits over {len(alive)} answering hosts)")

    if not a.dry_run and results:
        db.execute("""create table if not exists census_hits (
                        host text, path text, kind text, scope text, platform text, handle text,
                        len int, sha text, first_seen text, unique(host, path))""")
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        db.executemany("""insert or ignore into census_hits
                          (host, path, kind, scope, platform, handle, len, sha, first_seen)
                          values (?,?,?,?,?,?,?,?,?)""",
                       [(h["host"], h["path"], h["kind"], h["scope"], h["platform"],
                         h["handle"], h["len"], h["sha"], now) for h in results])
        db.commit()


if __name__ == "__main__":
    main()
