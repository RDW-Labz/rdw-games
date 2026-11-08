#!/usr/bin/env python3
"""What has this workstream actually earned? Asked once, answered wrong.

The receivables register said "Claims filed 2" and left GitHub listed as `new` while HackerOne had
already closed it `informative` six days earlier. That is the failure this module exists to prevent:
a tally assembled from notes drifts from the platform, and a drifted tally is worse than none because
it gets quoted to someone.

So nothing here is remembered. Every number is read at call time from the thing that owns it:

  collected / signed   reports/esign/*.json        — envelopes, written by engine/esign.py
  offers out           outreach/sent.json          — every offer actually delivered
  replies in           reports/out/replies.json    — measured from the mailbox, not from the ledger
  claims               reports/filed.json + the HackerOne API, live
  claimable backlog    engine/state.db             — what the recon thinks is still worth filing

and the offer price is the one figure that has to be stated, because the emails were sent with it.

Usage:
  ./money.py            human tally
  ./money.py --json     same numbers, machine-readable
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "reports"
ESIGN = REPORTS / "esign"
FILED = REPORTS / "filed.json"
SENT = ROOT / "outreach" / "sent.json"
REPLIES = REPORTS / "out" / "replies.json"
DB = ROOT / "engine" / "state.db"

# The figure every audit offer quotes. Stated once, here, so a change is one edit and not fourteen
# re-reads of the outbox.
OFFER_USD = 1500

# Two mailboxes, one company. `unit4cloud.com` is Unit4's cloud estate, not a second prospect — counting
# mailboxes as prospects is how a 15-organisation outbound turns into "16 hot leads" in a status update.
ALIASES = {"unit4cloud": "unit4"}

# HackerOne states that mean the report is finished, for better or worse.
CLOSED = {"informative", "not-applicable", "duplicate", "resolved", "spam"}


def esign_entries() -> list[dict]:
    out = []
    for p in sorted(ESIGN.glob("*.json")) if ESIGN.is_dir() else []:
        try:
            out.append(json.loads(p.read_text()))
        except Exception:
            continue
    return out


def offers() -> list[dict]:
    try:
        book = json.loads(SENT.read_text())
    except Exception:
        return []
    rows = []
    for to, rec in book.items():
        if not isinstance(rec, dict):
            continue
        rows.append({
            "to": to,
            "domain": rec.get("domain") or to.split("@")[-1],
            "count": rec.get("count") or 1,
            "sent_at": rec.get("sent_at"),
            "kind": rec.get("kind"),
            "bounced": bool(rec.get("bounced")),
        })
    return rows


def claims() -> list[dict]:
    """Live HackerOne state. A hacker token sees `state`, not the bounty payout."""
    try:
        book = json.loads(FILED.read_text())
    except Exception:
        return []
    sys.path.insert(0, str(ROOT / "engine"))
    try:
        import h1_api
    except Exception:
        return [{**r, "live_state": "unpolled"} for r in book]
    rows = []
    for r in book:
        rid = r.get("id")
        code, payload = h1_api.call("GET", f"/hackers/reports/{rid}")
        if code != 200:
            rows.append({**r, "live_state": f"HTTP {code}"})
            continue
        data = payload.get("data") if isinstance(payload, dict) else None
        a = data.get("attributes", {}) if isinstance(data, dict) else {}
        rows.append({**r, "live_state": a.get("state", "?"), "bounty": a.get("bounty_amount")})
    return rows


def replies() -> dict:
    """What came back, measured from the mailbox by `tools/mail_search.py`.

    `sent.json` records what went out; nothing in it can ever record what came in, so the tally used to end
    on "0 replies is the only measured fact" even when three organisations had answered. The mailbox is the
    only owner of that number, and it is readable without OAuth (the signed-in Firefox profile copy), so the
    count now comes from `reports/out/replies.json` — refreshed by `tools/replies_ingest.py` — with its age
    stated, because a stale reply count is as misleading as none.
    """
    try:
        d = json.loads(REPLIES.read_text())
    except Exception:
        return {"measured": False, "reason": "no reports/out/replies.json — run tools/replies_ingest.py"}
    rows = d.get("rows") or []
    by_org: dict[str, list[str]] = {}
    for r in rows:
        frm = (r.get("from") or "").lower()
        dom = frm.split("@")[-1].split(">")[0].strip()
        if not dom or "." not in dom:
            continue
        key = dom.split(".")[0]
        by_org.setdefault(ALIASES.get(key, key), []).append(r.get("subject") or "")
    return {"measured": True, "captured": d.get("captured_at"), "matched": d.get("matched", len(rows)),
            "by_org": by_org, "query": d.get("query")}


def backlog() -> int:
    try:
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        n = c.execute("select count(*) from findings where claimable=1").fetchone()[0]
        c.close()
        return n
    except Exception:
        return 0


def main() -> None:
    es = esign_entries()
    of = offers()
    cl = claims()
    rp = replies()

    collected = sum(float(e.get("amount_usd") or 0) for e in es if e.get("status") == "paid")
    signed = sum(float(e.get("amount_usd") or 0) for e in es if e.get("status") == "signed")
    offered_es = sum(float(e.get("amount_usd") or 0) for e in es if e.get("status") == "offered")
    # sent.json records what went out, not what came back: there is no bounce field, so a bounce can
    # only be counted if someone wrote one down. Say that instead of quietly treating all as delivered.
    bounced = [o for o in of if o["bounced"]]
    delivered = [o for o in of if not o["bounced"]]
    bounce_known = bool(bounced)
    orgs: dict[str, list[str]] = {}
    for o in of:
        key = (o["domain"] or o["to"].split("@")[-1]).split(".")[0]
        key = ALIASES.get(key, key)
        orgs.setdefault(key, []).append(o["to"])
    open_claims = [c for c in cl if (c.get("live_state") or "") not in CLOSED]
    dead_claims = [c for c in cl if (c.get("live_state") or "") in CLOSED]

    if "--json" in sys.argv:
        print(json.dumps({
            "collected_usd": collected,
            "signed_unpaid_usd": signed,
            "offered_unsigned_usd": offered_es,
            "outreach_offers": len(of),
            "outreach_orgs": len(orgs),
            "outreach_bounced": len(bounced),
            "outreach_ask_usd": OFFER_USD * len(orgs),
            "outreach_replies_measured": rp.get("measured"),
            "outreach_replies": rp.get("matched"),
            "outreach_orgs_heard": len(rp.get("by_org") or {}),
            "outreach_replies_captured": rp.get("captured"),
            "claims_filed": len(cl),
            "claims_open": len(open_claims),
            "claims_closed": len(dead_claims),
            "backlog_claimable": backlog(),
        }, indent=2))
        return

    print(f"COLLECTED            ${collected:,.2f}")
    if signed:
        print(f"signed, unpaid       ${signed:,.2f}   ({', '.join(e['slug'] for e in es if e.get('status') == 'signed')})")
    if offered_es:
        print(f"offered, unsigned    ${offered_es:,.2f}   ({', '.join(e['slug'] for e in es if e.get('status') == 'offered')})")

    print(f"\nclaims filed         {len(cl)}   live: {len(open_claims)} open / {len(dead_claims)} closed")
    for c in cl:
        print(f"  {c.get('id'):<9} {str(c.get('live_state')):<14} {str(c.get('program')):<11} {str(c.get('title'))[:52]}")

    print(f"\noffers sent          {len(of)} to {len(orgs)} organisations, ${OFFER_USD:,} each = ${OFFER_USD * len(orgs):,} asked")
    if bounce_known:
        print(f"  bounced            {len(bounced)}  ({', '.join(o['domain'] for o in bounced)})")
    else:
        print("  bounced            not recorded per-offer")
    if rp.get("measured"):
        heard_orgs = rp.get("by_org") or {}
        print(f"  replies            {rp.get('matched')} message(s) from {len(heard_orgs)} of {len(orgs)} "
              f"organisations (mailbox read {rp.get('captured') or 'unknown'})")
        for key, subjects in sorted(heard_orgs.items()):
            print(f"    {key:<14} {subjects[0][:64] if subjects else ''}")
    else:
        print(f"  replies            unmeasured — {rp.get('reason')}")

    print(f"\nbacklog claimable    {backlog()}   (engine/state.db, findings.claimable=1)")
    print("\nSignatures and payouts are the operator's act; nothing here moves money.")


if __name__ == "__main__":
    main()
