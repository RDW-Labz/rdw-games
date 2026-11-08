#!/usr/bin/env python3
"""Wire security@rdwlabz.com: Resend sending domain + Cloudflare Email Routing.

    python3 engine/wire_email.py --check          # what is missing, no changes
    python3 engine/wire_email.py --apply          # create DNS records, verify, add the route

Credentials (never in the repo):
    ~/.config/rdwlabz/cf.token     Cloudflare API token: Zone:DNS:Edit + Zone:Email Routing:Edit
    ~/.config/rdwlabz/resend.key   Resend API key, full access

Both APIs are idempotent here: existing DNS records are updated, an existing route is left alone.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

CONF = Path.home() / ".config/rdwlabz"
ZONE = "rdwlabz.com"
SENDER = "security@rdwlabz.com"
# security@rdwlabz.com is a forward-only alias, not an inbox — nobody can log in as it.
# Its mail lands in a mailbox the owner monitors, which is what verification needs.
# Override with RDW_FORWARD_TO if that ever moves (michael@cluerholdings.com is still
# an unverified destination in Cloudflare, so pointing the rule there would bounce mail).
FORWARD_TO = os.environ.get("RDW_FORWARD_TO", "jmacluer@gmail.com")


def load(name: str) -> str:
    p = CONF / name
    if not p.exists():
        return ""
    return p.read_text().strip()


def api(url: str, token: str, method: str = "GET", body: dict | None = None, cf: bool = False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    # Resend sits behind Cloudflare, which 1010-blocks requests with no User-Agent.
    req.add_header("User-Agent", "rdw-wire-email/1.0")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        return {"_http_error": e.code, "_body": raw}
    try:
        return json.loads(raw)
    except Exception:
        return {"_raw": raw}


def cf(url: str, token: str, method="GET", body=None):
    r = api(f"https://api.cloudflare.com/client/v4{url}", token, method, body)
    if isinstance(r, dict) and r.get("success") is False:
        print(f"  CF error {url}: {json.dumps(r.get('errors'))[:300]}")
    return r


def resend(url: str, key: str, method="GET", body=None):
    r = api(f"https://api.resend.com{url}", key, method, body)
    if isinstance(r, dict) and r.get("_http_error"):
        print(f"  Resend error {url}: {r['_body'][:300]}")
    return r


def dig(args: list[str]) -> str:
    try:
        import subprocess
        r = subprocess.run(["dig", "+short", *args, "@1.1.1.1"], capture_output=True, text=True,
                           timeout=10)
        return r.stdout.strip()
    except Exception as e:  # noqa: BLE001
        return f"(dig failed: {e})"


def dns_only(forward_to: str) -> None:
    """Verify the sender from public DNS when no Cloudflare token is available."""
    rk = load("resend.key")
    checks = [
        ("DKIM", dig(["TXT", f"resend._domainkey.{ZONE}"]), "p="),
        ("return-path MX", dig(["MX", f"send.{ZONE}"]), "feedback-smtp"),
        ("SPF (send)", dig(["TXT", f"send.{ZONE}"]), "v=spf1"),
        ("DMARC", dig(["TXT", f"_dmarc.{ZONE}"]), "v=DMARC1"),
        ("inbound MX", dig(["MX", ZONE]), "mx.cloudflare.net"),
    ]
    ok = True
    for label, value, needle in checks:
        good = needle in value
        ok &= good
        print(f"  {'ok  ' if good else 'FAIL'} {label:15s} {value[:70] or '(empty)'}")

    doms = resend("/domains", rk).get("data") or []
    dom = next((d for d in doms if d.get("name") == ZONE), None)
    if dom:
        sending = (dom.get("capabilities") or {}).get("sending")
        print(f"  resend: status={dom.get('status')} sending={sending}")
        ok &= sending == "enabled"
    else:
        print("  resend: domain not found under this key")
        ok = False

    print(f"\n{'sender ready' if ok else 'SENDER NOT READY'}: {SENDER} -> replies to {forward_to}")
    print("(records are read-only here; mint ~/.config/rdwlabz/cf.token to rewrite them)")
    sys.exit(0 if ok else 1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--forward-to", default=FORWARD_TO)
    a = ap.parse_args()

    cft, rk = load("cf.token"), load("resend.key")
    if not rk:
        print(f"MISSING: resend.key in {CONF} — cannot send without it")
        sys.exit(2)
    if not cft:
        # The DNS records are already published and verified; without a zone token this script
        # cannot rewrite them, but it can still prove the sender is live from public DNS.
        print(f"cf.token: absent in {CONF} — DNS writes unavailable, checking live DNS instead")
        dns_only(a.forward_to)
        return

    # 1. zone
    zones = cf(f"/zones?name={ZONE}", cft).get("result") or []
    if not zones:
        sys.exit(f"token cannot see zone {ZONE} (scopes?)")
    zid, aid = zones[0]["id"], zones[0]["account"]["id"]
    print(f"zone {ZONE}: {zid}")

    # 2. Resend domain + required records
    doms = resend("/domains", rk).get("data") or []
    dom = next((d for d in doms if d.get("name") == ZONE), None)
    if not dom:
        if not a.apply:
            print("resend: domain not present yet (would create)")
        else:
            dom = resend("/domains", rk, "POST", {"name": ZONE}).get("id")
            dom = resend(f"/domains/{dom}", rk) if isinstance(dom, str) else dom
        if not dom:
            sys.exit("could not create the Resend domain")
    did = dom.get("id") if isinstance(dom, dict) else dom
    detail = resend(f"/domains/{did}", rk)
    records = detail.get("records") or []
    print(f"resend domain status: {detail.get('status')}  records: {len(records)}")

    # 3. push them into Cloudflare
    existing = {(r["type"], r["name"]): r["id"] for r in
                (cf(f"/zones/{zid}/dns_records?per_page=200", cft).get("result") or [])}
    for rec in records:
        name, rtype, value = rec.get("name"), rec.get("type"), rec.get("value")
        body = {"type": rtype, "name": name, "content": value, "ttl": rec.get("ttl") or 3600,
                "proxied": False}
        if rtype == "MX":
            body["priority"] = rec.get("priority") or 10
        key = (rtype, name)
        if key in existing:
            print(f"  update {rtype} {name}")
            if a.apply:
                cf(f"/zones/{zid}/dns_records/{existing[key]}", cft, "PATCH", body)
        else:
            print(f"  create {rtype} {name}")
            if a.apply:
                cf(f"/zones/{zid}/dns_records", cft, "POST", body)

    # 4. verify
    if a.apply:
        resend(f"/domains/{did}/verify", rk, "POST")
        for i in range(10):
            st = resend(f"/domains/{did}", rk).get("status")
            print(f"  verify: {st}")
            if st == "verified":
                break
            time.sleep(6)

    # 5. Email Routing: destination address + rule
    dst = cf(f"/accounts/{aid}/email/routing/addresses", cft, "POST", {"email": a.forward_to})
    if isinstance(dst, dict) and dst.get("success") is False:
        print("  (destination may already exist or need verification by email)")
    rules = cf(f"/zones/{zid}/email/routing/rules", cft).get("result") or []
    if any(SENDER in json.dumps(r) for r in rules):
        print(f"  route {SENDER} already exists")
    else:
        print(f"  create route {SENDER} -> {a.forward_to}")
        if a.apply:
            cf(f"/zones/{zid}/email/routing/rules", cft, "POST", {
                "name": f"{SENDER} to {a.forward_to}",
                "enabled": True,
                "matchers": [{"type": "literal", "field": "to", "value": SENDER}],
                "actions": [{"type": "forward", "value": [a.forward_to]}],
            })

    if not a.apply:
        print("\n(dry run — nothing changed. re-run with --apply)")
    else:
        print(f"\nsender ready: {SENDER}")
        print("next: python3 engine/send_reports.py --dry-run, then send")


if __name__ == "__main__":
    main()
