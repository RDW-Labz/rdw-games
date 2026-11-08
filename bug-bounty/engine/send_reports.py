#!/usr/bin/env python3
"""Send the prepared disclosures through Resend as security@rdwlabz.com.

    python3 engine/send_reports.py --dry-run     # show exactly what would go out
    python3 engine/send_reports.py               # send, then record message ids in sent.json

Each email is the hand-written draft; the full report is inlined below it (so a gateway that
strips attachments still carries the evidence) and also attached as the raw .md file.

Credentials: ~/.config/rdwlabz/resend.key (mode 600, outside the repo). Never commit it.
"""
from __future__ import annotations

import argparse
import base64
import json
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KEYFILE = Path.home() / ".config/rdwlabz/resend.key"
API = "https://api.resend.com/emails"
SENDER = "RDW Labz Security <security@rdwlabz.com>"
REPLY_TO = "security@rdwlabz.com"
# Resend sits behind Cloudflare, which 1010-blocks requests without a browser-ish UA.
UA = "rdw-disclosure/1.0"

PAIRS = [
    ("submission-email-xola.txt", "report-xola-wixdemo-subdomain-takeover.md"),
    ("submission-email-differential.txt", "report-differential-elasticbeanstalk-takeover.md"),
    ("submission-email-stewart.txt", "report-stewart-trafficmanager-dangling.md"),
    ("submission-email-celemi.txt", "report-celemi-elasticbeanstalk-takeover.md"),
]


def parse(draft: Path, report: Path):
    raw = draft.read_text()
    head, _, body = raw.partition("\n\n")          # first block holds To:/Subject:
    to = subj = ""
    for line in head.splitlines():
        if line.lower().startswith("to:"):
            to = line.split(":", 1)[1].strip()
        elif line.lower().startswith("subject:"):
            subj = line.split(":", 1)[1].strip()
    if not to or not subj:
        raise SystemExit(f"{draft.name}: missing To: or Subject:")
    body = (body.rstrip()
            + "\n\n" + ("-" * 72) + "\n\nFULL REPORT\n\n" + report.read_text().rstrip() + "\n")
    return to, subj, body


def send(key: str, to: list[str], subject: str, text: str, report: Path) -> dict:
    payload = {
        "from": SENDER,
        "to": to,
        "reply_to": REPLY_TO,
        "subject": subject,
        "text": text,
        "attachments": [{
            "filename": report.name,
            "content": base64.b64encode(report.read_bytes()).decode(),
        }],
    }
    req = urllib.request.Request(
        API,
        data=json.dumps(payload).encode(),
        method="POST",
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

    if not a.dry_run:
        if not KEYFILE.exists():
            raise SystemExit(f"missing {KEYFILE}")
        key = KEYFILE.read_text().strip()
    else:
        key = ""

    out = ROOT / "sent.json"
    sent = json.loads(out.read_text()) if out.exists() else {}

    for draft_name, report_name in PAIRS:
        draft, report = ROOT / draft_name, ROOT / report_name
        if not draft.exists() or not report.exists():
            print(f"SKIP {draft_name}: missing file")
            continue
        to_field, subj, body = parse(draft, report)
        recipients = [x.strip() for x in to_field.replace(";", ",").split(",") if x.strip()]
        if to_field in sent:
            print(f"already sent -> {to_field} ({sent[to_field].get('id')})")
            continue
        if a.dry_run:
            print(f"WOULD SEND -> {to_field}\n  subject: {subj}\n  body: {len(body)} chars"
                  f"\n  attach: {report.name} ({report.stat().st_size} B)")
            continue
        res = send(key, recipients, subj, body, report)
        print(f"{to_field}: {res.get('id') or res}")
        if res.get("id"):
            sent[to_field] = {"id": res["id"], "subject": subj, "draft": draft_name,
                              "report": report_name}
            out.write_text(json.dumps(sent, indent=2))

    print(f"\n{len(sent)} recorded in {out}")


if __name__ == "__main__":
    main()
