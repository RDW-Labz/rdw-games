#!/usr/bin/env python3
"""Refresh the measured reply set: who answered the outreach, as the mailbox sees it.

`sent.json` can say what went out but never what came back, so the money tally used to end on "0 replies is
the only measured fact" while three organisations had in fact answered — Unit4 (moved to Bugcrowd), bpost
(auto-ack), and Differential (removed the CNAMEs on our report). The mailbox owns this number.

  python3 tools/replies_ingest.py            # read the mailbox, rewrite reports/out/replies.json
  python3 tools/replies_ingest.py --print    # same, and print the rows

A mailbox that is signed out, slow, or showing the Gmail marketing page is *not* "no replies": the run exits
non-zero and leaves the previous file untouched, because overwriting a good count with a zero from a broken
read is how a real reply gets lost. The `captured_at` stamp is what lets `engine/money.py` say how old the
number is instead of implying it is live.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / "tools" / "mail_search.py"
DOMAINS = ROOT / "reports" / "out" / "org-domains.txt"
TARGET = ROOT / "reports" / "out" / "replies.json"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", dest="show", action="store_true")
    a = ap.parse_args()

    if not DOMAINS.exists():
        print(f"missing {DOMAINS} — regenerate it from outreach/sent.json")
        return 2
    items = []
    for src in (DOMAINS,):
        for line in src.read_text().split():
            line = line.strip().lower()
            if line and not line.startswith("#"):
                items.append(line)
    # `from:a OR from:b` — Gmail silently drops terms past a handful of ORs, and a dropped term looks
    # exactly like "nobody replied", so batches stay at four.
    queries = [items[i:i + 4] for i in range(0, len(items), 4)]

    rows: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for batch in queries:
        q = " OR ".join(f"from:{d}" for d in batch)
        r = subprocess.run([sys.executable, str(TOOL), q, "--json"],
                           capture_output=True, text=True, timeout=420)
        try:
            d = json.loads(r.stdout)
        except Exception:
            print(f"read failed for {batch[0]}…: {(r.stdout or r.stderr or '')[-200:]}")
            return 3
        if not d.get("ok"):
            print(f"mailbox unreadable ({batch[0]}…): refusing to overwrite a good count with a bad read")
            return 3
        for row in d.get("rows") or []:
            k = (row.get("from") or "", row.get("subject") or "")
            if k in seen:
                continue
            seen.add(k)
            rows.append(row)

    out = {
        "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "query": " OR ".join(f"from:{d}" for d in items),
        "matched": len(rows),
        "gmail_says_empty": not rows,
        "rows": rows,
    }
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(json.dumps(out, indent=1) + "\n")
    print(f"{len(rows)} reply message(s) from {len(items)} domains → {TARGET.relative_to(ROOT)}")
    if a.show:
        for row in rows:
            print(f"  {row.get('when', ''):<8} {(row.get('from') or '')[:38]:<38} {(row.get('subject') or '')[:60]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
