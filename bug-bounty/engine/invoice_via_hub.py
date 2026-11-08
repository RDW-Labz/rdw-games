#!/usr/bin/env python3
"""Issue and send a SquareHub invoice for a closed audit deal.

Michael's ruling (2026-11-02): payments for the recon/audit work run through SquareHub, not the raw
square.link pages. This is the bridge — it takes the one thing a closed deal always has (a billing
address, an amount, a domain) and drives SquareHub's own invoice rail:

    POST /api/v1/invoices                create   (bill_to_*, lines[])
    POST /api/v1/invoices/{id}/issue     issue    (assigns invoice_no, becomes collectable)
    POST /api/v1/invoices/{id}/send      send     (Square create+send, webhook receiver tracks payment)

Dry run by default. Nothing is created until --apply, and nothing is emailed to the payer until --send
is also passed, because an invoice that reaches a prospect before they have agreed is worse than no
invoice at all.

Auth: SquareHub needs a bearer token for an *active* organization member. Mint one in the backend venv:

    cd workspace/squarehub-core/backend
    PYTHONPATH=. ./.venv/bin/python /tmp/mint_hub.py     # writes /tmp/hub_tok.txt

Usage:
    ./engine/invoice_via_hub.py --to ap@vendor.com --name "Vendor Security" \
        --domain vendor.com --amount 1500 --apply --send
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

HUB = os.environ.get("HUB_BASE", "http://127.0.0.1:8000")
ORG = os.environ.get("HUB_ORG", "639dc318-bc9c-48f0-8e72-b3f8ab705260")
TOKEN_FILE = pathlib.Path(os.environ.get("HUB_TOKEN_FILE", "/tmp/hub_tok.txt"))

AUDIT_DESC = "DNS hygiene audit — {domain}"
MONITOR_DESC = "DNS hygiene monitoring, 1 month — {domain}"


def token() -> str:
    if not TOKEN_FILE.exists():
        sys.exit(f"no token at {TOKEN_FILE} — mint one first (see the docstring)")
    return TOKEN_FILE.read_text().strip()


def call(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{HUB}{path}"
    if "?" not in url:
        url += "?" + urllib.parse.urlencode({"organization_id": ORG})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token()}")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} -> {e.code}: {e.read().decode()[:400]}")


def build(args) -> dict:
    desc = (MONITOR_DESC if args.kind == "monitoring" else AUDIT_DESC).format(domain=args.domain)
    if args.desc:
        desc = args.desc
    return {
        "bill_to_name": args.name,
        "bill_to_email": args.to,
        "bill_to_phone": args.phone,
        "currency": "USD",
        "terms": "Net 7",
        "notes": args.notes or f"Dangling DNS records found on {args.domain}.",
        "lines": [
            {
                "description": desc,
                "quantity": 1,
                "unit_price_cents": int(round(args.amount * 100)),
            }
        ],
    }


def main() -> None:
    p = argparse.ArgumentParser(description="Create/issue/send a SquareHub invoice for an audit deal")
    p.add_argument("--to", required=True, help="payer email")
    p.add_argument("--name", required=True, help="payer / company name as it should appear on the invoice")
    p.add_argument("--domain", required=True, help="customer domain the finding was on")
    p.add_argument("--amount", type=float, default=1500.0, help="dollars (default 1500)")
    p.add_argument("--kind", choices=("audit", "monitoring"), default="audit")
    p.add_argument("--phone", default=None)
    p.add_argument("--desc", default=None, help="override the line description")
    p.add_argument("--notes", default=None)
    p.add_argument("--apply", action="store_true", help="actually create the invoice")
    p.add_argument("--send", action="store_true", help="also email it via Square (needs --apply)")
    a = p.parse_args()

    payload = build(a)
    print(json.dumps(payload, indent=2))
    if not a.apply:
        print("\n[dry run] rerun with --apply (and --send when the deal is actually closed)")
        return

    inv = call("POST", "/api/v1/invoices", payload)
    inv_id = inv.get("invoice_id") or inv.get("id")
    print(f"\ncreated {inv.get('invoice_no', '?')} id={inv_id} total={inv.get('total_cents')}")

    issued = call("POST", f"/api/v1/invoices/{inv_id}/issue", {})
    print(f"issued  status={issued.get('status')} no={issued.get('invoice_no')}")

    if a.send:
        sent = call("POST", f"/api/v1/invoices/{inv_id}/send", {})
        print(f"sent    {json.dumps(sent)[:300]}")
    else:
        print("not sent — rerun with --send, or send from the SquareHub Invoices screen")


if __name__ == "__main__":
    main()
