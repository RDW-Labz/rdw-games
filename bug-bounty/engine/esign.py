#!/usr/bin/env python3
"""Intake for e-signature envelopes — read the thing, then hand the pen over.

The Celemi reward agreement has been sitting unsigned since 2 Nov. Nothing technical was in the way:
the document needs an access code that lives in a mailbox, and the mailbox lane is a Google token
that expired. That is a lane where the work is *reading and summarising a contract*, which is exactly
what should not wait on a human's evening.

This module turns an envelope into two files under reports/esign/:

  <slug>.md    what we get, what we give up, what they still owe us, and the operator's actions
  <slug>.json  the same facts, machine-readable, which is what engine/money.py counts

It does not sign, and it will not pretend to: the last step of every decision sheet is a human
signature, because that is the only part that is legally ours to withhold.

Usage:
  ./esign.py ingest --text doc.txt --org Celemi --dom celemi.com
  ./esign.py ingest --pdf agreement.pdf --org Celemi
  ./esign.py ingest --url https://app.docusign.com/...      (records the link, extracts nothing)
  ./esign.py list
  ./esign.py status <slug> offered|signed|paid|declined
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ESIGN = ROOT / "reports" / "esign"

# What a signature costs us, spelled out per document, is the point of the sheet; these are the
# clauses worth surfacing by name because they are the ones companies actually attach.
FLAGS = {
    "tax": r"\bW-?9\b|\bW-?8BEN\b|taxpayer identification|TIN\b",
    "confidentiality": r"confidential|non-?disclosure|\bNDA\b",
    "no-disclosure": r"shall not (?:publicly )?disclose|public disclosure|press release|no publicity",
    "assignment": r"assign(?:s|ment)? (?:all|any)|intellectual property|goodwill|work product",
    "indemnity": r"indemnif|hold harmless",
    "exclusivity": r"exclusiv",
    "governing-law": r"governing law|jurisdiction of|venue",
    "access-code": r"access code|one-?time code|passcode",
    "payment-method": r"\bwire\b|\bACH\b|\bcheck\b|\bpaypal\b|\bbank transfer\b",
}

DOC_KINDS = [
    (r"reward acceptance", "Reward Acceptance Agreement"),
    (r"bug bounty (?:agreement|terms)", "Bug bounty agreement"),
    (r"release of (?:claims|liability)", "Release"),
    (r"services? agreement|statement of work|\bSOW\b", "Services agreement"),
    (r"invoice", "Invoice"),
]


def text_from(args: list[str]) -> tuple[str, str]:
    """Return (text, source). PDFs go through pdftotext; a bare URL is recorded, not fetched."""
    if "--text" in args:
        p = Path(args[args.index("--text") + 1])
        return p.read_text(errors="replace"), str(p)
    if "--pdf" in args:
        p = Path(args[args.index("--pdf") + 1])
        try:
            out = subprocess.run(["pdftotext", "-layout", str(p), "-"],
                                 capture_output=True, text=True, timeout=60)
            return out.stdout, str(p)
        except Exception as e:
            return "", f"{p} (pdftotext failed: {e})"
    if "--url" in args:
        return "", args[args.index("--url") + 1]
    return "", ""


def money(text: str) -> list[tuple[float, str]]:
    hits = []
    for m in re.finditer(r"(?:US\s?\$|\$|USD\s?)\s?([0-9][0-9,]*(?:\.[0-9]{2})?)", text, re.I):
        hits.append((float(m.group(1).replace(",", "")), "USD"))
    for m in re.finditer(r"(?:EUR|€)\s?([0-9][0-9,]*(?:\.[0-9]{2})?)", text, re.I):
        hits.append((float(m.group(1).replace(",", "")), "EUR"))
    for m in re.finditer(r"([0-9][0-9,]*(?:\.[0-9]{2})?)\s?(?:USD|EUR)\b", text):
        hits.append((float(m.group(1).replace(",", "")), "USD" if "USD" in m.group(0).upper() else "EUR"))
    seen, uniq = set(), []
    for v, c in hits:
        if (v, c) not in seen:
            seen.add((v, c))
            uniq.append((v, c))
    return uniq


def slug_for(org: str, when: datetime) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", org.lower()).strip("-") or "envelope"
    return f"{base}-{when:%Y%m%d}"


def build(text: str, org: str, dom: str, source: str) -> dict:
    now = datetime.now(timezone.utc)
    low = text.lower()
    kind = next((name for pat, name in DOC_KINDS if re.search(pat, low)), "Unrecognised document")
    amounts = money(text)
    flags = {k: bool(re.search(v, text, re.I)) for k, v in FLAGS.items()}
    dates = re.findall(r"\b(?:[0-3]?\d\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d\d|20\d\d-\d\d-\d\d)\b", text)
    # The headline figure is the largest amount on the page: a reward is bigger than any fee it
    # mentions, and a fee table repeats the same number rather than inventing a larger one.
    amount, currency = (max(amounts, key=lambda a: a[0]) if amounts else (0.0, "USD"))
    return {
        "slug": slug_for(org, now),
        "org": org,
        "domain": dom,
        "doc_kind": kind,
        "amount": amount,
        "currency": currency,
        "amount_usd": amount if currency == "USD" else 0.0,
        "all_amounts": [f"{c} {v:,.2f}" for v, c in amounts],
        "flags": flags,
        "dates_seen": sorted(set(dates))[:12],
        "status": "offered" if amount else "received",
        "source": source,
        "ingested_at": now.isoformat(timespec="seconds"),
        "chars": len(text),
    }


def sheet(r: dict, text: str) -> str:
    f = r["flags"]
    def line(flag, yes, no):
        return f"- {'**' + yes + '**' if f[flag] else no}"

    give_up = [
        line("assignment", "Assigns IP / work product — read what you are handing over", "No IP assignment found"),
        line("confidentiality", "Confidentiality / NDA applies to the finding and its details", "No confidentiality clause found"),
        line("no-disclosure", "Restricts public disclosure — check expiry, a permanent gag costs future write-ups", "No publicity restriction found"),
        line("indemnity", "Indemnity — you carry risk for their downstream claims", "No indemnity found"),
        line("exclusivity", "Exclusivity — blocks you working the same class elsewhere", "No exclusivity found"),
        line("governing-law", "Governing law named — note the jurisdiction before signing", "No jurisdiction named"),
    ]
    owed = [
        line("tax", "Tax form required (W-9 / W-8BEN / TIN)", "No tax form required"),
        line("payment-method", "Payment method stated — confirm the account it names is RDW's", "No payment mechanism stated"),
        line("access-code", "Access code required to open the document — it is in the mailbox, not in this file", "No access code gating"),
    ]
    return f"""# {r['doc_kind']} — {r['org']}

`{r['slug']}` · ingested {r['ingested_at']} · **{r['currency']} {r['amount']:,.2f}** · status **{r['status']}**

Source: {r['source']} ({r['chars']:,} chars read)

## What we get

{r['currency']} {r['amount']:,.2f} for a finding that is already confirmed and already fixed by their side.
Amounts seen on the page: {', '.join(r['all_amounts']) or 'none'}.
Largest wins as the headline; if more than one figure is plausible, the sheet is wrong and the
document should be read by eye.

## What we give up

{chr(10).join(give_up)}

## What they still owe us

{chr(10).join(owed)}

## Dates on the page

{', '.join(r['dates_seen']) or 'none found'} — a signature deadline, if any, is among these.

## Operator actions

1. Open the document with the access code from the mailbox (Google token is expired — see LANES.md).
2. Read clause by clause against the list above; the sheet is a regex summary, not a legal read.
3. Confirm the signatory is the business entity that should receive the money, not a personal name.
4. Sign. That step is yours; nothing in this repo types a signature or accepts an agreement on your behalf.
5. `./esign.py status {r['slug']} signed`, then `paid` when the money lands.

## Extracted text (for review)

```
{(text[:4000] or '(nothing extracted — URL only)').strip()}
```
"""


def cmd_ingest(args: list[str]) -> None:
    text, source = text_from(args)
    org = args[args.index("--org") + 1] if "--org" in args else "Unknown"
    dom = args[args.index("--dom") + 1] if "--dom" in args else ""
    r = build(text, org, dom, source)
    ESIGN.mkdir(parents=True, exist_ok=True)
    (ESIGN / f"{r['slug']}.json").write_text(json.dumps(r, indent=2) + "\n")
    (ESIGN / f"{r['slug']}.md").write_text(sheet(r, text))
    print(f"{r['slug']}: {r['doc_kind']} · {r['currency']} {r['amount']:,.2f} · {r['status']}")
    print(f"  -> reports/esign/{r['slug']}.md")


def cmd_record(args: list[str]) -> None:
    """Register an envelope nobody could read: the operator signed it, but the document stayed behind a
    login. An agreement you cannot parse is still money once it is signed, so the record is written by
    hand and the sheet says plainly that no text was extracted."""
    def arg(name, default=None):
        return args[args.index(name) + 1] if name in args else default

    org = arg("--org")
    if not org:
        sys.exit("--org is required")
    now = datetime.now(timezone.utc)
    amount = float(arg("--amount", "0").replace(",", ""))
    r = {
        "slug": arg("--slug") or slug_for(org, now),
        "org": org,
        "domain": arg("--dom", ""),
        "doc_kind": arg("--kind", "Reward acceptance agreement"),
        "amount": amount,
        "currency": arg("--currency", "USD"),
        "amount_usd": amount if arg("--currency", "USD") == "USD" else 0.0,
        "all_amounts": [],
        "flags": {},
        "dates_seen": [],
        "status": arg("--status", "signed"),
        "source": arg("--note", "recorded by hand — document not machine-read"),
        "ingested_at": now.isoformat(timespec="seconds"),
        "signed_at": now.isoformat(timespec="seconds") if arg("--status", "signed") == "signed" else None,
        "chars": 0,
    }
    ESIGN.mkdir(parents=True, exist_ok=True)
    (ESIGN / f"{r['slug']}.json").write_text(json.dumps(r, indent=2) + "\n")
    (ESIGN / f"{r['slug']}.md").write_text(
        f"# {r['doc_kind']} — {r['org']}\n\n`{r['slug']}` · recorded {r['ingested_at']} · "
        f"**{r['currency']} {r['amount']:,.2f}** · status **{r['status']}**\n\n"
        f"No text was extracted: {r['source']}. Clause review did not happen, so the obligations in this\n"
        "agreement are unknown until someone reads it. The money is real either way — chase it.\n")
    print(f"{r['slug']}: {r['status']} · {r['currency']} {r['amount']:,.2f}")


CHASE = {
    0: ("confirming receipt of the countersigned agreement",
        "Thank you for the countersigned agreement. Could you confirm the payment reference and the\n"
        "expected payment date so it can be matched when it lands?"),
    7: ("the payment has not landed",
        "The agreement was countersigned on {signed}. Payment has not reached us yet. Could you confirm\n"
        "it is scheduled, and which entity and reference it will carry?"),
    14: ("asking for the finance contact",
        "Payment against the countersigned agreement is now two weeks overdue. If this sits with\n"
        "accounts payable rather than security, could you point me at the right contact and invoice\n"
        "reference so it does not stall further?"),
    30: ("final chase before writing it off",
        "Thirty days past countersignature and no payment has arrived, despite a confirmed and fixed\n"
        "finding. I would rather resolve this directly than escalate; if the reward has been withdrawn,\n"
        "please say so plainly and I will close it out."),
}


def cmd_chase(args: list[str]) -> None:
    """Draft the escalation ladder for every signed-but-unpaid envelope. Sending is the operator's act:
    the mail lane has no working token, and a payment chase is a message a human should read first."""
    rows = [json.loads(p.read_text()) for p in (ESIGN.glob("*.json") if ESIGN.is_dir() else [])]
    signed = [r for r in rows if r.get("status") == "signed"]
    if not signed:
        print("nothing signed and unpaid")
        return
    for r in signed:
        since = datetime.fromisoformat(r.get("signed_at") or r["ingested_at"])
        days = (datetime.now(timezone.utc) - since).days
        body = []
        for day, (subject, text) in sorted(CHASE.items()):
            if days >= day:
                body.append(f"## day {day} — {subject}\n\n{text.format(signed=since.date())}\n")
        if not body:
            print(f"{r['slug']:<24} signed {days}d ago — no chase due yet (first at day 0)")
            continue
        p = ESIGN / f"{r['slug']}-chase.md"
        p.write_text(f"# Payment chase — {r['org']} ({r['currency']} {r['amount']:,.2f})\n\n"
                     f"Signed {since.date()}, {days} days ago. Draft only — send it yourself; the mail lane\n"
                     "has an expired token and nothing here should go out unreviewed.\n\n" + "\n".join(body))
        print(f"{r['slug']:<24} {days}d past signature -> {p.relative_to(ROOT)}")


def cmd_list() -> None:
    rows = sorted(ESIGN.glob("*.json")) if ESIGN.is_dir() else []
    if not rows:
        print("no envelopes ingested yet")
        return
    for p in rows:
        r = json.loads(p.read_text())
        print(f"{r['slug']:<28} {r['status']:<9} {r['currency']} {r['amount']:>10,.2f}  {r['doc_kind']}")


def cmd_status(args: list[str]) -> None:
    slug, state = args[0], args[1]
    p = ESIGN / f"{slug}.json"
    if not p.exists():
        sys.exit(f"no such envelope: {slug}")
    if state not in {"received", "offered", "signed", "paid", "declined"}:
        sys.exit("state must be received|offered|signed|paid|declined")
    r = json.loads(p.read_text())
    r["status"] = state
    r.setdefault("history", []).append({"state": state, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    p.write_text(json.dumps(r, indent=2) + "\n")
    print(f"{slug} -> {state}")


def main() -> None:
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return
    if a[0] == "ingest":
        cmd_ingest(a[1:])
    elif a[0] == "record":
        cmd_record(a[1:])
    elif a[0] == "chase":
        cmd_chase(a[1:])
    elif a[0] == "list":
        cmd_list()
    elif a[0] == "status" and len(a) >= 3:
        cmd_status(a[1:])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
