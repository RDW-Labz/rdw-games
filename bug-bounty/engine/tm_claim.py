#!/usr/bin/env python3
"""Claim the seven dangling Azure Traffic Manager profile names and serve the SDTO PoC.

Creates one tiny web host (nginx with /ha.html = "Hello world!"), then registers each dangling profile
name as a Traffic Manager profile pointing at it, so `dig` on the Starbucks hostname resolves to our
infrastructure and `curl http://<host>.starbucks.com/ha.html` returns the file.

  python3 engine/tm_claim.py --plan        # show what would be created
  python3 engine/tm_claim.py --create      # create RG, host VM, profiles, endpoints
  python3 engine/tm_claim.py --verify      # dig + curl every host
  python3 engine/tm_claim.py --destroy     # delete the resource group (removes everything)

Everything is confined to one resource group so teardown is a single delete.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time

RG = "rg-sdto-poc"
LOCATION = "eastus"
VM = "sdto-poc"
DNS_LABEL = "sdto-poc-z13"          # <label>.<location>.cloudapp.azure.com
HOST_FQDN = f"{DNS_LABEL}.{LOCATION}.cloudapp.azure.com"

PROFILES = {
    "jssdev-starbucks": "jssdev.starbucks.com",
    "s00150tmppdpim": "wfmnapim.starbucks.com",
    "s00150tmpctpim": "wfmnapimct.starbucks.com",
    "s00149tmpdvpim": "wfmnapimdv.starbucks.com",
    "s00149tmpstpim": "wfmnapimst.starbucks.com",
    "s00149tmpdvpos": "wfmnaposdv.starbucks.com",
    "s00150tmppspos": "wfmnaposps.starbucks.com",
}

CLOUD_INIT = """#cloud-config
package_update: true
packages: [nginx]
write_files:
  - path: /var/www/html/ha.html
    content: |
      Hello world!
runcmd:
  - systemctl enable --now nginx
  - sed -i 's/^user .*/user www-data;/' /etc/nginx/nginx.conf || true
"""


def az(*args: str, check: bool = True, timeout: int = 900) -> str:
    cmd = ["az", *args, "--only-show-errors", "-o", "json"] if not args[-1:] == ("-ojson",) else ["az", *args]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise SystemExit(f"az {' '.join(args[:3])} failed:\n{r.stderr[-800:]}")
    return r.stdout.strip()


def plan() -> None:
    print(f"resource group : {RG} ({LOCATION})")
    print(f"poc host       : {VM} -> {HOST_FQDN} serving /ha.html")
    print(f"profiles       : {len(PROFILES)}")
    for name, host in PROFILES.items():
        print(f"  {name:<18} -> {host}")


def create() -> None:
    acct = json.loads(az("account", "list")) if az("account", "list", check=False) else []
    if not acct:
        raise SystemExit("no Azure subscription on this login — a subscription is required to create profiles")
    sub = acct[0]
    print(f"subscription: {sub['name']} ({sub['id']})")

    print("resource group…")
    az("group", "create", "-n", RG, "-l", LOCATION)

    print("web host (nginx + ha.html)…")
    az("vm", "create", "-g", RG, "-n", VM, "-l", LOCATION,
       "--image", "Ubuntu2404", "--size", "Standard_B1s",
       "--admin-username", "azureuser", "--generate-ssh-keys",
       "--public-ip-sku", "Standard", "--public-ip-address-version", "IPv4",
       "--dns-name", DNS_LABEL, "--custom-data", CLOUD_INIT, timeout=1800)
    az("vm", "open-port", "-g", RG, "-n", VM, "--port", "80", "--priority", "310")

    print(f"waiting for {HOST_FQDN} to serve /ha.html…")
    for i in range(40):
        time.sleep(15)
        r = subprocess.run(["curl", "-s", "-m", "8", f"http://{HOST_FQDN}/ha.html"],
                           capture_output=True, text=True)
        if "Hello world" in r.stdout:
            print("  up:", r.stdout.strip())
            break
        print(f"  {i}: not yet")
    else:
        raise SystemExit("poc host never served /ha.html")

    print("traffic manager profiles…")
    for name, host in PROFILES.items():
        try:
            az("network", "traffic-manager", "profile", "create", "-g", RG, "-n", name,
               "--routing-method", "Priority", "--unique-dns-name", name, "--ttl", "30",
               "--profile-status", "Enabled")
            az("network", "traffic-manager", "endpoint", "create", "-g", RG,
               "--profile-name", name, "-n", "poc", "--type", "externalEndpoints",
               "--target", HOST_FQDN, "--endpoint-status", "Enabled", "--priority", "1")
            print(f"  CLAIMED {name} -> {host}")
        except SystemExit as e:
            print(f"  FAILED  {name}: {str(e)[:160]}")


def verify() -> None:
    for name, host in PROFILES.items():
        cname = subprocess.run(["dig", "+short", "CNAME", host], capture_output=True, text=True).stdout.strip()
        body = subprocess.run(["curl", "-s", "-m", "12", f"http://{host}/ha.html"],
                              capture_output=True, text=True).stdout.strip()
        print(f"{host:<26} cname={cname or '-':<44} http={body[:20] or 'FAIL'}")


def destroy() -> None:
    az("group", "delete", "-n", RG, "--yes", "--no-wait")
    print(f"deleting {RG} (all profiles + host) in the background")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--create", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--destroy", action="store_true")
    a = ap.parse_args()
    plan()
    if a.create:
        create()
    if a.verify:
        verify()
    if a.destroy:
        destroy()
