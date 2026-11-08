#!/usr/bin/env python3
"""Zone-cut pass: find subdomains that carry their own NS delegation, and prove whether that delegation
still lands somewhere alive.

Takeover scanners look at CNAMEs and stop. A subdomain delegated with its own `NS` RRset is a second,
quieter way to lose a name: if the NS hostnames themselves no longer resolve, whoever can register one of
them at that provider owns every record under the subdomain — no CNAME to notice, no page to fingerprint.

The test is mechanically simple and needs no guessing:

  1. `NS name` with a non-empty ANSWER means this name is its own zone (a zone cut); an empty answer means
     the parent's nameservers answer for it, which is not a delegation.
  2. A cut only matters if its NS hostnames are outside the parent's set.
  3. A cut is *dangling* when not one of its NS hostnames resolves — the delegation points at nothing.

Only dangling cuts inside a published scope are carried forward. Everything else is counted and dropped.

  python3 engine/ns_delegation.py --workers 64 --limit 230000
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine/state.db"

try:
    import dns.exception
    import dns.resolver
except ModuleNotFoundError:  # pragma: no cover
    raise SystemExit("needs dnspython: uv pip install --python .venv/bin/python dnspython")

RES = dns.resolver.Resolver(configure=True)
RES.timeout, RES.lifetime = 3.0, 5.0

_lock = threading.Lock()


def ns_of(name: str) -> tuple[int, list[str]]:
    """(status, NS hostnames answered *for this exact name*).

    Raw query on purpose: `resolver.resolve(name, "NS")` follows CNAME chains, so a name that is a CNAME
    into some provider returns that provider's zone NS and looks like a delegation. 667 of the first 1,000
    "dangling zones" this produced were exactly that — every sampled host resolved normally. Filtering the
    ANSWER section by owner name is the difference between a finding and a false positive.
    """
    q = dns.message.make_query(name, dns.rdatatype.NS)
    try:
        r = dns.query.udp(q, RES.nameservers[0], timeout=3)
    except Exception:
        return -2, []
    owner = dns.name.from_text(name)
    ns = [str(rr.target).lower().rstrip(".") for rrset in r.answer
          if rrset.name == owner and rrset.rdtype == dns.rdatatype.NS for rr in rrset]
    if ns:
        return 1, sorted(ns)
    return (0 if r.rcode() == dns.rcode.NOERROR else -1), []


def resolves(name: str) -> bool:
    for rt in ("A", "AAAA", "CNAME"):
        try:
            ans = RES.resolve(name, rt, raise_on_no_answer=False)
            if ans.rrset is not None and len(ans.rrset):
                return True
        except Exception:
            continue
    return False


def build_matcher(scopes):
    exact, wild = {}, {}
    for p, h, a in scopes:
        a = (a or "").strip().lower().rstrip(".")
        if not a:
            continue
        if a.startswith("*."):
            wild.setdefault(a[2:], (p, h))
        elif a.startswith("*"):
            wild.setdefault(a[1:].lstrip("."), (p, h))
        else:
            exact.setdefault(a, (p, h))

    def match(host: str):
        h = host.lower().rstrip(".")
        if h in exact:
            return exact[h]
        parts = h.split(".")
        for i in range(1, len(parts) - 1):
            s = ".".join(parts[i:])
            if s in wild:
                return wild[s]
            if s in exact:
                return exact[s]
        return None

    return match


def flush(db, rows) -> None:
    """Commit with backoff. A long pass keeps dying on a transient 'database is locked' — 137k hosts lost
    to one, then 200k to another — and the cost of a retry is nothing next to re-running the pass."""
    sql = ("insert or replace into ns_deleg(host,apex,parent_ns,ns,ns_live,resolves,verdict,checked_at)"
           " values(?,?,?,?,?,?,?,?)")
    params = [(x["host"], x["apex"], ",".join(x["parent_ns"]), ",".join(x["ns"]),
               x["ns_live"], x["resolves"], x["verdict"], x["checked_at"]) for x in rows]
    for attempt in range(8):
        try:
            db.executemany(sql, params)
            db.commit()
            return
        except sqlite3.OperationalError as e:
            if "locked" not in str(e) and "busy" not in str(e):
                raise
            time.sleep(1.5 * (attempt + 1))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=64)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--json", default="reports/ns-delegation.json")
    a = ap.parse_args()

    db = sqlite3.connect(DB, timeout=120)
    # A writer blocked by a reader's snapshot dies mid-run: the first pass lost 137k hosts to exactly that.
    # WAL lets readers and the writer coexist, and busy_timeout rides out a checkpoint instead of raising.
    db.execute("pragma journal_mode=wal")
    db.execute("pragma busy_timeout=120000")
    db.execute("""create table if not exists ns_deleg(
        host text primary key, apex text, parent_ns text, ns text, ns_live int,
        resolves int, verdict text, checked_at text)""")
    db.commit()

    done = {r[0] for r in db.execute("select host from ns_deleg")}
    scopes = db.execute("select platform, handle, asset from scopes").fetchall()
    match = build_matcher(scopes)

    todo = [(h, match(h)) for (h,) in db.execute("select host from hosts")
            if h not in done and match(h)]
    if a.limit:
        todo = todo[:a.limit]
    print(f"in-scope hosts to cut-test: {len(todo)}  (already done {len(done)})")

    parent_ns_cache: dict[str, list[str]] = {}
    buf, stopped = [], False
    t0 = time.time()
    stats = {"cut": 0, "dangling": 0, "checked": 0}

    def parent_ns(host: str) -> list[str]:
        """NS of the nearest ancestor that is its own zone: walking up, the first name with an NS
        ANSWER. Comparing a cut against its *own* NS is the bug this avoids — that makes every
        delegation look identical to its parent and silently discards all of them."""
        parts = host.split(".")
        for i in range(1, min(len(parts), 5)):
            cand = ".".join(parts[i:])
            if cand not in parent_ns_cache:
                parent_ns_cache[cand] = ns_of(cand)[1]
            if parent_ns_cache[cand]:
                return parent_ns_cache[cand]
        return []

    def work(item):
        host, scope = item
        st, ns = ns_of(host)
        if st != 1 or not ns:
            return {"host": host, "verdict": "no-cut", "ns": [], "ns_live": 0, "resolves": 1,
                    "parent_ns": [], "apex": ""}
        pns = parent_ns(host)
        if set(ns) == set(pns):
            return {"host": host, "verdict": "no-cut", "ns": ns, "ns_live": 0, "resolves": 1,
                    "parent_ns": pns, "apex": ""}
        live = sum(1 for n in ns if resolves(n))
        return {"host": host, "verdict": "dangling" if live == 0 else "delegated-ok",
                "ns": ns, "ns_live": live, "resolves": int(live > 0),
                "parent_ns": pns, "apex": ""}

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for r in ex.map(work, todo):
            stats["checked"] += 1
            if r["verdict"] in ("delegated-ok", "dangling"):
                stats["cut"] += 1
            if r["verdict"] == "dangling":
                stats["dangling"] += 1
                print(f"  DANGLING {r['host']}  NS={','.join(r['ns'])[:90]}")
            r["checked_at"] = time.strftime("%FT%TZ", time.gmtime())
            r["_scope"] = match(r["host"])
            buf.append(r)
            if len(buf) >= 500:
                with _lock:
                    flush(db, buf)
                done_n = stats["checked"]
                print(f"  {done_n}/{len(todo)} checked, cuts {stats['cut']}, dangling {stats['dangling']} "
                      f"({done_n / max(time.time() - t0, 1):.0f}/s)")
                buf.clear()

    if buf:
        flush(db, buf)

    rows = db.execute("select host, ns, ns_live, parent_ns from ns_deleg "
                      "where verdict='dangling' order by host").fetchall()
    out = []
    for host, ns, ns_live, pns in rows:
        m = match(host)
        out.append({"host": host, "ns": ns.split(","), "parent_ns": pns.split(","),
                    "scope": f"{m[0]}:{m[1]}" if m else None})
    Path(ROOT / a.json).write_text(json.dumps({"stats": stats, "rows": out}, indent=1))
    print(f"\nzone cuts found: {stats['cut']}   dangling: {len(out)}   in scope: "
          f"{sum(1 for r in out if r['scope'])}")
    for r in out:
        if r["scope"]:
            print(f"  {r['host'][:52]:52} -> {','.join(r['ns'])[:46]:46} [{r['scope']}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
