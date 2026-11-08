#!/usr/bin/env python3
"""How much of the corpus is actually in somebody's published scope, and how much of that pays?

The store holds ~542k hosts and the sweeps were run over ~230k "in-scope" ones — but that count came from
"host shares a registrable apex with any scoped asset", which is not scope. A programme that lists
`www.starbucks.com` only covers `www.starbucks.com`; `wfmnapim.starbucks.com` is a stranger to it. With
per-asset matching (exact host, or a wildcard the host sits under) most of the corpus drops out, and the
question "why does nothing pay" answers itself: scanning a VDP or an unlisted host pays $0 no matter how
good the finding is.

This pass is read-only and prints the surface by programme, so the next sweep can be aimed at the hosts
that can actually produce money.

  .venv/bin/python engine/surface.py [--json reports/surface.json]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine" / "state.db"
sys.path.insert(0, str(ROOT / "engine"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="")
    ap.add_argument("--top", type=int, default=25)
    a = ap.parse_args()

    from scope_cover import host_of

    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    hosts = {h: d for h, d in db.execute("select host, domain from hosts")}

    exact: dict[str, list[tuple]] = defaultdict(list)
    wild: dict[str, list[tuple]] = defaultdict(list)
    for plat, handle, asset, bounty in db.execute(
            "select platform, handle, asset, bounty from scopes"):
        h = host_of(asset)
        if not h:
            continue
        rec = (plat, handle, bool(bounty))
        if h.startswith("*."):
            wild[h[2:]].append(rec)
        else:
            exact[h].append(rec)

    progs = {(p, h): (n, o, mx) for p, h, n, o, mx in
             db.execute("select platform, handle, name, offers_bounty, max_bounty from programs")}

    hit: Counter = Counter()
    hit_max: dict[tuple, int] = {}
    paying_hosts = set()
    n_exact = n_wild = 0
    for host in hosts:
        matched = exact.get(host)
        kind = "exact" if matched else ""
        if not matched:
            parts = host.split(".")
            for i in range(1, len(parts) - 1):
                cand = ".".join(parts[i:])
                if cand in wild:
                    matched, kind = wild[cand], "wildcard"
                    break
        if not matched:
            continue
        if kind == "exact":
            n_exact += 1
        else:
            n_wild += 1
        for plat, handle, bounty in matched:
            hit[(plat, handle, bounty)] += 1
            mx = progs.get((plat, handle), ("", True, 0))[2] or 0
            hit_max[(plat, handle, bounty)] = max(hit_max.get((plat, handle, bounty), 0), int(mx or 0))
            if bounty and kind == "exact" or (bounty and kind == "wildcard"):
                paying_hosts.add(host)

    total = len(hosts)
    print(f"hosts in corpus      {total:>8}")
    print(f"  covered exact      {n_exact:>8}")
    print(f"  covered wildcard   {n_wild:>8}")
    print(f"  covered (unique)   {len({h for h in hosts if exact.get(h) or any(
        '.'.join(h.split('.')[i:]) in wild for i in range(1, len(h.split('.')) - 1))}):>8}")
    print(f"  paying programmes  {len(paying_hosts):>8}")

    rows = []
    for (plat, handle, bounty), n in hit.most_common():
        name, offers, mx = progs.get((plat, handle), ("", True, 0))
        rows.append({"platform": plat, "handle": handle, "name": name, "hosts": n,
                     "bounty": bounty, "max_bounty": int(mx or 0)})
    print(f"\ntop {a.top} programmes by covered hosts (* = pays)")
    for r in rows[: a.top]:
        print(f"  {'*' if r['bounty'] else ' '} {r['platform']:3}:{r['handle'][:26]:26} "
              f"{r['hosts']:>7} hosts  max={r['max_bounty']:>6}  {r['name'][:38]}")
    if a.json:
        Path(a.json).write_text(json.dumps({"total": total, "exact": n_exact, "wildcard": n_wild,
                                           "paying_hosts": len(paying_hosts), "programs": rows}, indent=1))
        print(f"\nwrote {a.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
