#!/usr/bin/env python3
"""Second touch for paid-audit offers that have not been answered.

Offers land, get forwarded, and die in an unread queue. One short nudge between 44 and 120 hours
after the first send roughly doubles reply rate on cold security outreach, and it costs nothing.

Rules baked in so this cannot become spam:
  * one follow-up per address, ever — recorded as `followup_at` in outreach/sent.json
  * bounced addresses are skipped
  * only 44h+ old (never same-day), and only once during the window
  * the nudge adds a fact, not urgency: it names the finding count and repeats the free fix

    python3 engine/send_followup.py --dry-run
    python3 engine/send_followup.py
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path

from send_offers import KEYFILE, OUTREACH, parse, send

ROOT = Path(__file__).resolve().parent.parent
MIN_HOURS = 44
MAX_HOURS = 120

TEMPLATE = """Hello,

Putting this back at the top of your queue once, since a dangling record is silent until someone uses
it — nothing urgent, and nothing to buy.

{count} hostname{plural} in {domain} point at cloud resources that no longer exist. The fix is deleting
the stale CNAME record{plural}, which costs nothing and needs no engagement with me.

If the {count}-record list is useful as-is, it is in the message below this one. If you would rather
have the whole zone swept — every hostname, every CNAME followed, each one given a claimability
verdict, and a re-test after your fix — that is the $1,500 audit, three business days:

    https://square.link/u/h41lTw3P

Either way, reply and tell me what you would prefer and I will work around it.

Michael McLuer
RDW Labz
security@rdwlabz.com
"""


def count_for(name: str) -> tuple[int, str]:
    """Recover the record count and domain from the draft's subject line — the one field every draft
    carries in the same shape ("4 dangling DNS records on harman.com — ..."). Body parsing was brittle
    across draft generations, so it is not used."""
    p = OUTREACH / name
    if not p.exists():
        return 0, ""
    head, _, _ = p.read_text().partition("\n---\n")
    for line in head.splitlines():
        if line.lower().startswith("subject:"):
            m = re.search(r"(\d+)\s+dangling", line)
            d = re.search(r"\bon\s+([a-z0-9.-]+\.[a-z]{2,})", line, re.I)
            if m and d:
                return int(m.group(1)), d.group(1)
    return 0, ""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--min-hours", type=int, default=MIN_HOURS)
    a = ap.parse_args()

    book = OUTREACH / "sent.json"
    sent = json.loads(book.read_text()) if book.exists() else {}
    key = "" if a.dry_run else KEYFILE.read_text().strip()
    now = dt.datetime.now(dt.timezone.utc)
    fired = 0

    for addr, rec in sorted(sent.items()):
        if rec.get("status") == "bounced" or rec.get("followup_at"):
            continue
        try:
            sent_at = dt.datetime.fromisoformat(rec["sent_at"])
        except Exception:
            continue
        age_h = (now - sent_at).total_seconds() / 3600
        if age_h < a.min_hours or age_h > MAX_HOURS:
            continue
        n, domain = rec.get("count"), rec.get("domain")
        if not n or not domain:
            n, domain = count_for(rec.get("draft", ""))
        if not n:
            print(f"SKIP {addr}: could not recover the record count")
            continue
        subj = f"Re: {rec.get('subject', 'dangling DNS records')}"
        body = TEMPLATE.format(count=n, domain=domain, plural="" if n == 1 else "s")
        if a.dry_run:
            print(f"WOULD NUDGE -> {addr}  age={age_h:.1f}h  count={n}  domain={domain}")
            continue
        res = send(key, addr, subj, body)
        if res.get("id"):
            rec["followup_at"] = now.isoformat(timespec="seconds")
            rec["followup_id"] = res["id"]
            book.write_text(json.dumps(sent, indent=1) + "\n")
            print(f"nudged -> {addr} ({res['id']})")
            fired += 1
        else:
            print(f"FAILED -> {addr}: {res}")
    print(f"{fired} follow-ups sent")


if __name__ == "__main__":
    main()
