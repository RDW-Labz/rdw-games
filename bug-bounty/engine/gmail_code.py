#!/usr/bin/env python3
"""Read the newest one-time login code out of the human's own signed-in Gmail tab (CDP).

Used only when the account owner says "type it in for me". Each Gmail message in a thread
is timestamped, so this sorts by that timestamp instead of trusting thread order, and it
never prints the code unless --reveal is passed.

  CDP_PORT=9224 python3 engine/gmail_code.py              # newest code, not printed
  CDP_PORT=9224 python3 engine/gmail_code.py --reveal     # newest code, printed
  CDP_PORT=9224 python3 engine/gmail_code.py --query='from:bugcrowd newer_than:1h'
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import urllib.parse

import websockets

from browser_login import Session, new_tab

MESSAGES_JS = """JSON.stringify([...document.querySelectorAll('div.a3s')].map(d => {
  let n = d, when = '';
  for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
    const t = n.querySelector && n.querySelector('span[title]');
    if (t && /\\d{4}/.test(t.getAttribute('title') || '')) { when = t.getAttribute('title'); break; }
  }
  return {when, text: d.innerText.slice(0, 400)};
}))"""


async def newest_code(query: str, reveal: bool) -> tuple[str | None, str]:
    url = "https://mail.google.com/mail/u/0/#search/" + urllib.parse.quote(query)
    async with websockets.connect(new_tab(url), max_size=40_000_000) as ws:
        s = Session(ws)
        await asyncio.sleep(7)
        for _ in range(6):
            if await s.ev("document.querySelectorAll('tr.zA').length"):
                break
            await asyncio.sleep(3)
        # a single-message conversation opens straight from the row; a thread needs a click
        await s.ev("(() => { const r = document.querySelector('tr.zA'); if (r) r.click(); })()")
        await asyncio.sleep(6)
        raw = await s.ev(MESSAGES_JS) or "[]"
        msgs = json.loads(raw)
        if not msgs:
            return None, "no messages parsed"
        keyed = []
        for m in msgs:
            codes = re.findall(r"\b(\d{6})\b", m["text"])
            keyed.append((m["when"], codes[-1] if codes else None, m["when"]))
        keyed.sort(key=lambda t: t[0])  # RFC-ish dates sort lexicographically within a day
        newest = keyed[-1]
        print("messages:", len(msgs), "| newest stamp:", newest[0])
        for when, code, _ in keyed:
            print("   ", when, "code:" + ("found" if code else "none"))
        if reveal:
            print("newest code:", newest[1])
        return newest[1], newest[0]


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    qflag = next((f.split("=", 1)[1] for f in sys.argv[1:] if f.startswith("--query=")), None)
    q = qflag or (args[0] if args else "from:(bugcrowd) newer_than:2h")
    code, when = asyncio.run(newest_code(q, "--reveal" in sys.argv))
    print("__CODE__=" + (code or "NONE"))
