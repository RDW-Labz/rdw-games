#!/usr/bin/env python3
"""Can this subscription create an App Service at all — without touching anyone else's name?

The claim path (`azure_web_claim.py`) ends at `PUT .../sites/<victim-label>`, and every attempt so far died
before it started: the Support API refused a quota ticket (`400 InvalidSupportPlan`, Free plan) and the
create was never proven either way. So probe it with a label nobody owns:

  create RG + F1 plan + site `rdwlabz-quota-<rand>`  ->  read back the hostname  ->  delete the RG

$0 on F1 while it exists, and the resource group is removed in the same run, so a failure cannot leave a
half-built environment behind for a later pass to trip over.

  .venv/bin/python engine/azure_quota_probe.py            # probe, then tear down
  .venv/bin/python engine/azure_quota_probe.py --keep     # leave it up to inspect a failure
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))

SUB = "d21b2b11-a93f-47f7-a5eb-d1d9dd2e74a9"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--location", default="", help="try one region; default sweeps the usual candidates")
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()

    import azure_arm as aa
    import azure_web_claim as awc

    tok = awc.token()
    label = f"rdwlabz-quota-{int(time.time()) % 100000}"
    rg, plan = "rg-quota-probe", f"plan-{label}"

    code, res = aa.arm(tok, "POST",
                       f"/subscriptions/{SUB}/providers/Microsoft.Web/checkNameAvailability"
                       "?api-version=2022-03-01", {"name": label, "type": "Microsoft.Web/sites"})
    print(f"availability {label}: HTTP {code} available={res.get('nameAvailable')}")
    if not res.get("nameAvailable"):
        print("probe label is taken — rerun, the timestamp collided")
        return 1

    rgcode, _ = aa.arm(tok, "PUT", f"/subscriptions/{SUB}/resourceGroups/{rg}?api-version=2021-04-01",
                       {"location": "eastus"})
    print(f"rg {rg}: HTTP {rgcode}")
    if rgcode >= 400:
        return 1
    regions = [a.location] if a.location else ["eastus", "eastus2", "centralus", "westus2", "westus3",
                                                "northeurope", "uksouth", "southeastasia", "canadaeast",
                                                "australiaeast"]
    plan_ok, chosen, last = None, "", ""
    for loc in regions:
        code, body = aa.arm(tok, "PUT",
                            f"/subscriptions/{SUB}/resourceGroups/{rg}/providers/Microsoft.Web/serverfarms/"
                            f"{plan}?api-version=2022-03-01",
                            {"location": loc,
                             "sku": {"name": "F1", "tier": "Free", "capacity": 1},
                             "properties": {"reserved": False}})
        msg = (body.get("error") or {}).get("message", "")
        print(f"  plan F1 @{loc:14} HTTP {code} {msg[:140]}")
        if code < 400:
            plan_ok, chosen = body, loc
            break
        last = msg
        if code in (401, 403) and "ineligible" not in msg and "not accepting" not in msg:
            continue

    if plan_ok is None:
        print("\nRESULT: no region accepted a plan.")
        print("  'locationineligible' = this subscription may only deploy to a subset of regions; the fix is "
              "a different region or a support-backed subscription, NOT a quota ticket.")
        if not a.keep:
            code, _ = aa.arm(tok, "DELETE",
                             f"/subscriptions/{SUB}/resourceGroups/{rg}?api-version=2021-04-01")
            print(f"  teardown {rg}: HTTP {code}")
        return 1

    print(f"\nplan accepted in {chosen}")
    site = awc.wait_ready(tok, SUB, rg, label)
    host = site.get("properties", {}).get("defaultHostName", "")
    state = site.get("properties", {}).get("state", "?")
    print(f"created: {host}  state={state}  region={chosen}")
    print(f"RESULT: App Service creation WORKS on this subscription — the claim path is unblocked "
          f"(no quota ticket needed).")
    if a.keep:
        print(f"left up: rg {rg} / {label}")
        return 0
    code, _ = aa.arm(tok, "DELETE", f"/subscriptions/{SUB}/resourceGroups/{rg}?api-version=2021-04-01")
    print(f"teardown {rg}: HTTP {code}")
    for _ in range(20):
        c, _ = aa.arm(tok, "GET", f"/subscriptions/{SUB}/resourceGroups/{rg}?api-version=2021-04-01")
        if c == 404:
            print("teardown confirmed: RG gone")
            break
        time.sleep(6)
    return 0


if __name__ == "__main__":
    sys.exit(main())
