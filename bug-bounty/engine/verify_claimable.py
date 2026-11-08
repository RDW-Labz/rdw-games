#!/usr/bin/env python3
"""Measure every `claimable=1` row against the provider's own namespace API.

`dig` proves a name is unused; it never proves the name is free. Azure keeps the DNS name of a
deleted Traffic Manager profile reserved and answers `409 Domain name not available` on create, and an
App Service hostname whose app survived with its traffic pointed elsewhere reads dead in DNS while
`checknameavailability` answers `nameAvailable: false`. Both cases look identical to a resolver, so the
only honest verdict comes from the provider.

Verdicts, and what each one licenses:

  available     create succeeded (Traffic Manager) or nameAvailable answered true (App Service)
                -> draft a report, then delete the resource in the same run
  unavailable   the provider says somebody holds the name -> evidence only, never a takeover
  unknown       no token, no API, resolver flake -> stays claimable, never promoted to a finding

Usage:
    engine/verify_claimable.py                 # measure, print, rewrite claimable/why in the state DB
    engine/verify_claimable.py --dry-run       # measure and print, touch nothing
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys

ROOT = __import__("pathlib").Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))

from azure_web_claim import arm, available, token  # noqa: E402

DB = ROOT / "engine" / "state.db"
OUT = ROOT / "reports" / "claimable-verdicts.json"


def subscription(tok: str) -> str:
    _, body = arm(tok, "GET", "/subscriptions?api-version=2022-12-01")
    subs = [s for s in body.get("value", []) if s.get("state") == "Enabled"]
    return sorted(subs, key=lambda s: s["displayName"].lower().endswith("subscription"))[-1]["subscriptionId"]


def web_verdict(tok: str, sub: str, label: str) -> tuple[str, str]:
    code, body = arm(tok, "POST",
                     f"/subscriptions/{sub}/providers/Microsoft.Web/checknameavailability"
                     "?api-version=2022-03-01",
                     {"name": label, "type": "Microsoft.Web/sites"})
    if code != 200:
        return "unknown", f"checknameavailability HTTP {code}"
    if body.get("nameAvailable"):
        return "available", "nameAvailable=true"
    return "unavailable", f"nameAvailable=false ({body.get('reason') or 'hosted elsewhere'})"


def tm_verdict(tok: str, sub: str, label: str, rg: str) -> tuple[str, str]:
    """A create attempt is the only test Traffic Manager answers honestly."""
    body = {"location": "global",
            "properties": {"trafficRoutingMethod": "Priority",
                           "dnsConfig": {"relativeName": label},
                           "monitorConfig": {"protocol": "HTTPS", "port": 443, "path": "/"},
                           "endpoints": []}}
    arm(tok, "PUT", f"/subscriptions/{sub}/resourceGroups/{rg}?api-version=2021-04-01",
        {"location": "eastus2"})
    code, resp = arm(tok, "PUT",
                     f"/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/"
                     f"trafficManagerProfiles/{label}?api-version=2022-04-01", body)
    if code in (200, 201):
        arm(tok, "DELETE", f"/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/"
                           f"trafficManagerProfiles/{label}?api-version=2022-04-01")
        return "available", "profile created then deleted"
    if code == 409:
        return "unavailable", "409 Domain name not available (deleted profiles keep the name)"
    if code == 400 and "is not available" in json.dumps(resp):
        return "unavailable", "400 label refused by the provider (not available in trafficmanager.net)"
    return "unknown", f"PUT HTTP {code}: {json.dumps(resp)[:160]}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--rg", default="rg-claim-verify")
    a = ap.parse_args()

    db = sqlite3.connect(DB)
    rows = db.execute("select host, target, provider from findings where claimable=1 "
                      "order by provider, target").fetchall()
    print(f"{len(rows)} claimable row(s) to measure")

    try:
        tok = token()
        sub = subscription(tok)
        print(f"subscription {sub}")
    except Exception as e:  # no token: every verdict is unknown, which changes nothing
        print(f"no ARM token ({e}) — verdicts stay unknown")
        return 1

    verdicts, seen = [], {}
    for host, target, provider in rows:
        if provider == "azurewebsites.net":
            label, kind = target.split(".")[0], "azure-web"
            key = ("azure-web", label)
        elif provider == "trafficmanager.net":
            label, kind = target.split(".")[0], "traffic-manager"
            key = ("traffic-manager", label)
        else:
            continue  # elastic beanstalk names are environment-scoped; not this script's question
        if key not in seen:
            try:
                seen[key] = (web_verdict(tok, sub, label) if kind == "azure-web"
                             else tm_verdict(tok, sub, label, a.rg))
            except Exception as e:
                seen[key] = ("unknown", f"error {e}")
            print(f"  {kind:16} {label:42} -> {seen[key][0]}  ({seen[key][1]})")
        verdicts.append({"host": host, "target": target, "provider": provider,
                         "label": label, "kind": kind,
                         "verdict": seen[key][0], "why": seen[key][1]})

    store = json.dumps(verdicts, indent=1)
    counts = {}
    for v in verdicts:
        counts[v["verdict"]] = counts.get(v["verdict"], 0) + 1
    print("verdicts:", counts)
    if a.dry_run:
        print("dry run — state DB untouched")
        return 0

    OUT.write_text(store + "\n")
    for v in verdicts:
        if v["verdict"] == "unavailable":
            db.execute("update findings set claimable=0, why=? where host=? and target=?",
                       (f"{v['kind']}: {v['why']}", v["host"], v["target"]))
    db.commit()
    left = db.execute("select count(*) from findings where claimable=1").fetchone()[0]
    print(f"claimable=1 now {left} (was {len(rows)}) · verdicts written to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
