#!/usr/bin/env python3
"""Match every claimable host against *all* platforms' scopes at once, not just HackerOne.

state.db already holds the merged scope corpus from bounty-targets-data — H1 39,498 rows, Bugcrowd
1,950, Intigriti 1,445, YesWeHack 472 — and `scopes.bounty` records the programme's own bounty flag. One
suffix-anchored pass over 70 hosts therefore answers "is this finding payable anywhere?" for the cost of
a local query, instead of one network walk per platform.

  python3 engine/scope_match_all.py            # write reports/scope-matches-all.json
  python3 engine/scope_match_all.py --paying   # only bounty-eligible rows
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "reports" / "scope-matches-all.json"

URL = {
    "h1": "https://hackerone.com/{h}",
    "bc": "https://bugcrowd.com/{h}",
    "it": "https://app.intigriti.com/programs/{h}/detail",
    "yw": "https://yeswehack.com/programs/{h}",
}


def host_of(asset: str) -> str:
    a = (asset or "").strip().lower()
    if not a:
        return ""
    a = a.split("://", 1)[-1]
    a = a.split("/", 1)[0].split(":", 1)[0]
    return a.strip(".")


def hit(host: str, asset: str, atype: str) -> bool:
    a = host_of(asset)
    if not a:
        return False
    # "*" / "*." catch-all rows match every host and are meaningless as scope evidence
    if len(a.strip("*.")) < 3:
        return False
    if atype and atype.lower() in ("ip_address", "cidr", "mobile", "android", "ios", "hardware",
                                   "executable", "source_code", "other", "smart_contract"):
        return False
    if a.startswith("*."):
        base = a[2:]
        return host == base or host.endswith("." + base)
    if a.startswith("*"):
        # `*foo.com` is a partial-label wildcard; match it on a label boundary only, because
        # `host.endswith("foo.com")` also accepts `evilfoo.com`, which is a different registrant.
        tail = a.lstrip("*").lstrip(".")
        return host == tail or host.endswith("." + tail)
    return host == a or host.endswith("." + a)


def main() -> None:
    paying_only = "--paying" in sys.argv
    db = sqlite3.connect(f"file:{ROOT / 'engine' / 'state.db'}?mode=ro", uri=True)
    hosts = [r[0] for r in db.execute("select host from findings where claimable=1")]
    print(f"{len(hosts)} claimable hosts")

    rows: list[dict] = []
    for platform, handle, asset, atype, bounty in db.execute(
            "select platform, handle, asset, asset_type, bounty from scopes"):
        if paying_only and not bounty:
            continue
        h = host_of(asset)
        if not h:
            continue
        # cheap pre-filter: the host's tail must appear in the asset at all
        for host in hosts:
            if not hit(host, asset, atype or ""):
                continue
            a = h.lower()
            # Say *how* a host landed in scope. `*.twilio.com` is a promise about subdomains;
            # `twilio.com` is a promise about the apex, and a suffix match against it is the shape
            # that reads as "payable" in a digest and out-of-scope to a triager. Downstream must be
            # able to tell the two apart without re-deriving it.
            basis = ("exact" if host.lower() == a
                     else "wildcard" if a.startswith("*") else "apex-suffix")
            rows.append({"host": host, "platform": platform, "handle": handle.strip(),
                         "asset": asset, "asset_type": atype, "bounty": bool(bounty),
                         "basis": basis,
                         "program_url": URL.get(platform, "").format(h=handle.strip())})

    uniq: dict[tuple[str, str, str], dict] = {}
    for r in rows:
        k = (r["host"], r["platform"], r["handle"])
        rank = {"wildcard": 3, "exact": 2, "apex-suffix": 1}
        if k not in uniq or rank[r["basis"]] > rank[uniq[k]["basis"]]:
            uniq[k] = r
    out = sorted(uniq.values(), key=lambda r: (not r["bounty"], r["platform"], r["handle"], r["host"]))
    OUT.write_text(json.dumps(out, indent=2) + "\n")

    paying = [r for r in out if r["bounty"]]
    print(f"{len(out)} host/programme matches · {len(paying)} bounty-eligible")
    for r in out:
        print(f"  {'PAYS' if r['bounty'] else '    '} {r['host']:<45} {r['platform']:<3} "
              f"{r['handle'][:34]:<34} {r['asset']}  [{r['basis']}]")
    print(f"\nwrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
