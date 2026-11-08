#!/usr/bin/env python3
"""Search a mailbox from the operator's own signed-in Firefox profile.

`engine/mail_read.py` proves the profile copy works, but it only ever reads `#inbox`, so a reply that was
filtered, archived or read cannot be found — and the question this answers is whether any of the 14
organisations offered a paid audit ever wrote back to `security@rdwlabz.com`.

  python3 tools/mail_search.py "from:xola.com OR from:differential.com"
  python3 tools/mail_search.py --file reports/out/org-domains.txt
  python3 tools/mail_search.py "from:xola.com" --json

Gmail applies OR across `from:` terms, so a single query covers the whole outreach list. An empty result is
reported as `matched: 0` only when Gmail itself says so — a signed-out or slow page is reported as unnamed
rather than as "no replies".
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engine"))

import mail_read  # noqa: E402

ROWS = """
const rs = [...document.querySelectorAll('tr.zA')].slice(0, 60);
return rs.map(r => {
  const sn = r.querySelector('.yW span, .bA4 span');
  const un = r.querySelector('.bA4 span, .yX.xY span, .zF, .yP');
  const sub = r.querySelector('.bog');
  const when = r.querySelector('.xW span');
  const snip = r.querySelector('.y2');
  return {from: (sn && sn.getAttribute('email')) || (un && un.textContent) || '',
          name: (un && un.textContent) || '',
          subject: (sub && sub.textContent) || '',
          when: (when && when.textContent) || '',
          snippet: (snip && snip.textContent) || ''};
});
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="?")
    ap.add_argument("--file", help="newline-separated domains to OR together")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--open", action="store_true", help="open the newest hit and return its links")
    a = ap.parse_args()

    if a.file:
        doms = [ln.strip() for ln in Path(a.file).read_text().splitlines() if ln.strip()]
        query = " OR ".join(f"from:{d}" for d in doms)
    else:
        query = a.query or ""
    if not query:
        ap.error("need a query or --file")

    mail_read.refresh_profile()
    d = mail_read.driver()
    try:
        url = "https://mail.google.com/mail/u/0/#search/" + urllib.parse.quote(query)
        d.get(url)
        time.sleep(11)
        cur = d.current_url
        if "accounts.google.com" in cur or "ServiceLogin" in cur:
            print(json.dumps({"ok": False, "why": "signed out — Google wants a fresh login", "url": cur}))
            return 2
        rows = d.execute_script(ROWS) or []
        body = d.find_element("css selector", "body").text
        empty = "No messages matched your search" in body or "did not match any" in body
        out = {"ok": True, "query": query, "matched": len(rows), "gmail_says_empty": empty,
               "url": cur, "rows": rows}
        if a.open and rows:
            # a message body holds links the snippet never shows (reset tokens, invoice buttons), so open
            # the newest hit and hand back its anchors rather than making the caller re-search blind
            d.execute_script("document.querySelector('tr.zA').click()")
            time.sleep(9)
            out["opened"] = {"url": d.current_url,
                             "text": d.find_element("css selector", "body").text[:1200]}
            out["links"] = d.execute_script(
                "return [...document.querySelectorAll('a')].map(a => a.href).filter(Boolean)")
        if a.json:
            print(json.dumps(out, indent=1))
        else:
            print(f"query: {query}\nmatched: {len(rows)}   gmail_says_empty: {empty}")
            for r in rows:
                print(f"  {r['when']:<10} {r['from']:<34} {r['subject'][:70]}")
                if r.get("snippet"):
                    print(f"      {r['snippet'][:110]}")
        return 0
    finally:
        try:
            d.quit()
        except Exception:
            pass


raise SystemExit(main())
