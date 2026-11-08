#!/usr/bin/env python3
"""RDW Labz payable links — the forward set.

Runs inside SquareHub's backend venv (it borrows the app's Fernet-encrypted Square token):

    cd ~/.local/share/z13/releases/hermes-stock-l9m64A/workspace/squarehub-core/backend
    PYTHONPATH=. ./.venv/bin/python /path/to/engine/square_links.py

Location `L6WC96AFWEZP8` "RDW Labz" is a location on the existing merchant — same bank settlement as
every other location, separate reporting bucket. Idempotency keys make re-running safe.

The two older links (h41lTw3P / 7GnO5RnD) are on the corporate "RDW" location and are still live:
four outreach emails carry them, so they must not be deleted.
"""
import asyncio
from uuid import UUID

from app.db.session import get_session_maker
from app.services.square_service import get_write_client

ORG = UUID("639dc318-bc9c-48f0-8e72-b3f8ab705260")
LOC = "L6WC96AFWEZP8"

OFFERS = [
    dict(key="rdw-labz-dns-audit-single-zone-v1",
         name="DNS Hygiene Audit — single zone sweep", cents=150000,
         note="One zone, up to ~2,000 subdomains. Dangling-record report with evidence, "
              "remediation steps and re-test in 3 business days."),
    dict(key="rdw-labz-dns-monitor-month-v1",
         name="DNS Hygiene Monitoring — 1 month", cents=75000,
         note="Continuous dangling-DNS monitoring for one zone, 30-day term, alerts with evidence."),
]


async def main() -> None:
    s = get_session_maker()()
    try:
        client, _, _ = await get_write_client(s, ORG)
        for o in OFFERS:
            r = await client._call("POST", "/online-checkout/payment-links", {
                "idempotency_key": o["key"],
                "quick_pay": {"name": o["name"][:255],
                              "price_money": {"amount": o["cents"], "currency": "USD"},
                              "location_id": LOC},
                "checkout_options": {"ask_for_shipping_address": False},
                "payment_note": o["note"][:500],
            })
            pl = r.get("payment_link", {})
            print(f"{o['name']}: {pl.get('url')}  (id {pl.get('id')}, order {pl.get('order_id')})")
    finally:
        await s.close()


if __name__ == "__main__":
    asyncio.run(main())
