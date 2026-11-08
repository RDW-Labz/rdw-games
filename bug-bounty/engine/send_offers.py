#!/usr/bin/env python3
"""Send the paid-audit offer drafts from security@rdwlabz.com.

Same rail as the disclosures: Resend, key at ~/.config/rdwlabz/resend.key (mode 600, outside the repo).
Idempotent — an address already recorded in outreach/sent.json is never re-sent.

    python3 engine/send_offers.py --dry-run
    python3 engine/send_offers.py
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import socket
import urllib.error
import urllib.request
from pathlib import Path

# This host has no working IPv6 route (wlan0 carries IPv4 only, Tailscale owns the ULA), while
# api.resend.com is fronted by Cloudflare and answers AAAA first. urllib therefore stalls in the TLS
# handshake for the full timeout on every request. Pin resolution to IPv4 so sends go out in <1s.
_ga = socket.getaddrinfo


def _v4_only(host, port, family=0, type=0, proto=0, flags=0):
    return _ga(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _v4_only

ROOT = Path(__file__).resolve().parent.parent
OUTREACH = ROOT / "outreach"
KEYFILE = Path.home() / ".config/rdwlabz/resend.key"
API = "https://api.resend.com/emails"
SENDER = "RDW Labz <security@rdwlabz.com>"
REPLY_TO = "security@rdwlabz.com"
UA = "rdw-offers/1.0"


def parse(p: Path):
    text = p.read_text()
    head, _, body = text.partition("\n---\n")
    to = subj = ""
    for line in head.splitlines():
        low = line.lower()
        if low.startswith("to:"):
            to = line.split(":", 1)[1].strip()
        elif low.startswith("subject:"):
            subj = line.split(":", 1)[1].strip()
    return to, subj, body.strip()


def send(key: str, to: str, subject: str, text: str) -> dict:
    payload = {"from": SENDER, "to": [to], "reply_to": REPLY_TO, "subject": subject, "text": text}
    req = urllib.request.Request(
        API, data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:400]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    key = "" if a.dry_run else KEYFILE.read_text().strip()
    book = OUTREACH / "sent.json"
    sent = json.loads(book.read_text()) if book.exists() else {}

    for draft in sorted(OUTREACH.glob("*-audit-offer.txt")):
        to, subj, body = parse(draft)
        if not to or not subj:
            print(f"SKIP {draft.name}: missing To:/Subject:")
            continue
        if to in sent:
            print(f"already sent -> {to} ({sent[to].get('id')})")
            continue
        if a.dry_run:
            print(f"WOULD SEND -> {to}\n  subject: {subj}\n  body: {len(body)} chars")
            continue
        res = send(key, to, subj, body)
        print(f"{to}: {res.get('id') or res}")
        if res.get("id"):
            sent[to] = {"id": res["id"], "subject": subj, "draft": draft.name,
                        "kind": "paid-audit-offer",
                        "sent_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
            book.write_text(json.dumps(sent, indent=1) + "\n")


if __name__ == "__main__":
    main()
