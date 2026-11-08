#!/usr/bin/env python3
"""Open Gmail threads by search query and print the messages, using the copied profile.

  python3 engine/mail_thread.py 'from:unit4.com' --n 2

Read-only: it searches, opens the conversation, and extracts the message bodies. Nothing is marked
read-or-not, nothing is sent, no link is clicked. Gmail's own search decides what matches.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse

from mail_read import driver, refresh_profile

JS_MESSAGES = """
const out = [];
document.querySelectorAll('div.adn.ads').forEach(m => {
    const hdr = [...m.querySelectorAll('span.gD, span.go')].map(s => s.textContent).filter(Boolean);
    const bodies = [...m.querySelectorAll('div.a3s')].map(b => b.innerText).join('\\n---\\n');
    if (bodies) out.push({headers: hdr.slice(0, 3), body: bodies});
});
if (!out.length) {
    const b = document.querySelector('div.a3s');
    if (b) out.push({headers: [], body: b.innerText});
}
return out;
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--n", type=int, default=1, help="how many conversations to open (default 1)")
    ap.add_argument("--chars", type=int, default=1500)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    refresh_profile()
    d = driver()
    try:
        d.get("https://mail.google.com/mail/u/0/#search/" + urllib.parse.quote(a.query))
        time.sleep(7)
        rows = d.execute_script("""
            return [...document.querySelectorAll('tr.zA')].slice(0, 15).map(r => {
                const a = r.querySelector('a[href*="/#"], a[href*="#"]');
                const f = r.querySelector('.yW span, .bA4 span');
                return {
                  subject: (r.querySelector('.bog')||{}).textContent || '',
                  from: (f && f.getAttribute && f.getAttribute('email')) || '',
                  when: (r.querySelector('.xW span')||{}).textContent || '',
                  href: a ? a.getAttribute('href') : '',
                  snippet: (r.querySelector('.y2')||{}).textContent || ''};
            });
        """) or []
        print(f"{len(rows)} matching conversations for: {a.query}")
        for r in rows[:10]:
            print(f"  · {r['when']:<10} {r['from'][:28]:<28} {r['subject'][:70]}")

        threads = []
        for i in range(min(a.n, len(rows))):
            d.get("https://mail.google.com/mail/u/0/#search/" + urllib.parse.quote(a.query))
            time.sleep(5)
            els = d.find_elements("css selector", "tr.zA")
            if i >= len(els):
                print("  (row vanished — skipping)")
                continue
            # JS click, because a row outside the headless viewport raises ElementNotInteractable
            d.execute_script("arguments[0].click()", els[i])
            time.sleep(6)
            msgs = d.execute_script(JS_MESSAGES) or []
            # expand collapsed messages so replies are included
            for btn in d.find_elements("css selector", "div.ajR, span.ams"):
                try:
                    btn.click()
                    time.sleep(1)
                except Exception:
                    pass
            msgs = d.execute_script(JS_MESSAGES) or msgs
            threads.append({"row": rows[i], "messages": [
                {"headers": m.get("headers"), "body": (m.get("body") or "")[:a.chars]} for m in msgs]})

        if a.json:
            print(json.dumps(threads, indent=1))
        else:
            for t in threads:
                print("\n" + "=" * 78)
                print(f"SUBJECT: {t['row']['subject']}\nFROM: {t['row']['from'] or t['row']['snippet'][:60]}")
                for m in t["messages"]:
                    print("-" * 78)
                    if m["headers"]:
                        print("[headers]", " / ".join(m["headers"][:2]))
                    print(m["body"].strip()[:a.chars])
    finally:
        try:
            d.quit()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
