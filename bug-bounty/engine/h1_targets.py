#!/usr/bin/env python3
"""Build the sweep target list from LIVE HackerOne state: paying *and* accepting submissions.

engine/programs.py seeds from bounty-targets-data, which knows nothing about `submission_state`. A
programme can pay $15,000 and still be paused — filing then returns a bare `403` with no explanation
(that is exactly how eToro answers today: `"submission_state": "paused"`). Enumerating a paused
programme's estate is wasted DNS.

This writes the registrable domains of every programme that pays AND accepts submissions now, so the
sweep spends its budget only where a finding can actually be filed.

  python3 engine/h1_targets.py            # write engine/data/h1_open_domains.txt
  python3 engine/h1_targets.py --seed 200 # also add the first N missing domains to state.db
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from h1_api import call  # noqa: E402
from h1_scope_match import get, pages  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "engine" / "data" / "h1_open_domains.txt"
STATE = ROOT / "engine" / "data" / "h1_open_programs.json"

# same registrable-domain shortcut the rest of the engine uses; a two-label suffix is fine for a
# target list — anything mis-split simply fails to enumerate and costs one DNS query.
TWO_LABEL_SLDS = {"co.uk", "com.au", "co.jp", "com.br", "co.in", "com.mx", "co.nz", "com.tr",
                  "co.za", "com.sg", "com.hk", "co.il", "com.cn", "com.ar", "co.kr", "com.tw",
                  "gov.uk", "org.uk", "ac.uk", "net.au", "com.pl", "com.ua", "co.id"}


def registrable(host: str) -> str:
    host = host.lower().strip().strip(".")
    host = urlparse(host if "://" in host else "http://" + host).hostname or host
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    if ".".join(labels[-2:]) in TWO_LABEL_SLDS:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def main() -> None:
    seed = 0
    if "--seed" in sys.argv:
        seed = int(sys.argv[sys.argv.index("--seed") + 1])

    paying, openp = [], []
    for batch in pages("/hackers/programs"):
        for p in batch:
            a = p.get("attributes") or {}
            row = {"handle": a.get("handle"), "name": a.get("name"),
                   "bounties": bool(a.get("offers_bounties")),
                   "submission_state": a.get("submission_state")}
            paying.append(row)
            if row["bounties"] and row["submission_state"] != "paused":
                openp.append(row)
    print(f"{len(paying)} programmes · {len(openp)} paying and accepting submissions")

    cache_file = ROOT / "engine" / "data" / "h1_scopes_cache.json"
    cache = json.loads(cache_file.read_text()) if cache_file.exists() else {}

    domains: dict[str, list[str]] = {}
    for row in openp:
        handle = row["handle"]
        scopes = cache.get(handle)
        if scopes is None:
            scopes = []
            for batch in pages(f"/hackers/programs/{handle}/structured_scopes"):
                for s in batch:
                    a = s.get("attributes") or {}
                    if a.get("asset_identifier"):
                        scopes.append({"asset": a["asset_identifier"], "type": a.get("asset_type") or "",
                                       "bounty": bool(a.get("eligible_for_bounty"))})
            cache[handle] = scopes
        for s in scopes:
            if not s.get("bounty", True):
                continue
            asset = s["asset"].lstrip("*.").split("://")[-1].split("/")[0]
            if not asset or " " in asset or not asset.rsplit(".", 1)[-1].isalpha():
                continue  # CIDR blocks, IPs and ports are not enumerable zones
            d = registrable(asset)
            if d.count(".") < 1 or not d.rsplit(".", 1)[-1].isalpha():
                continue
            domains.setdefault(d, []).append(handle)

    cache_file.write_text(json.dumps(cache))
    STATE.write_text(json.dumps({"open_programs": openp, "domains": {k: sorted(set(v)) for k, v in domains.items()}},
                                indent=2) + "\n")
    OUT.write_text("".join(f"{d}\n" for d in sorted(domains)))
    print(f"{len(domains)} unique domains across those programmes -> {OUT.relative_to(ROOT)}")

    if seed:
        db = sqlite3.connect(ROOT / "engine" / "state.db")
        have = {r[0] for r in db.execute("select domain from domains")}
        added = 0
        for d in sorted(domains):
            if d in have:
                continue
            handles = ",".join(sorted(set(domains[d]))[:3])
            db.execute("insert into domains(domain, org, policy, contact, tier, last_enum) "
                       "values(?,?,?,?,?,NULL)", (d, handles, f"https://hackerone.com/{handles}", "", "bounty:h1"))
            added += 1
            if added >= seed:
                break
        db.commit()
        print(f"seeded {added} new domain(s) into state.db (tier bounty:h1)")


if __name__ == "__main__":
    main()
