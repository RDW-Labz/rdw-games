#!/usr/bin/env python3
"""One-shot Bugcrowd sign-in: Okta identifier+passcode, then the emailed code.

The account owner said "type it in for me and I will approve", so the emailed one-time
code is read from his own signed-in Gmail tab and typed into the Okta prompt without ever
touching argv, a log line or this transcript — it lives in this process's memory for the
one fill, and only its length is printed.

  CDP_PORT=9224 python3 engine/bc_login.py            # full run
  CDP_PORT=9224 python3 engine/bc_login.py --dry      # stop just before typing the code

Leaves the tab on whatever Bugcrowd answers, and prints the landing URL/title so the
result is verifiable rather than assumed.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import urllib.parse
import urllib.request

import websockets

from browser_login import CDP, SECRETS, Session, new_tab

GMAIL_Q = "newer_than:10m"  # any sender: Okta mails come from bugcrowd/okta, both throttled
MSGS_JS = """JSON.stringify([...document.querySelectorAll('div.a3s')].map(d => {
  let n = d, when = '';
  for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
    const t = n.querySelector && n.querySelector('span[title]');
    if (t && /\\d{4}/.test(t.getAttribute('title') || '')) { when = t.getAttribute('title'); break; }
  }
  return {when, text: d.innerText.slice(0, 400)};
}))"""

CODE_SELECTORS = ['input[name="credentials.passcode"]', 'input[autocomplete="one-time-code"]',
                  'input[type="tel"]', 'input[type="text"]']


def _age_minutes(stamp: str) -> float:
    """Minutes since a Gmail stamp like 'Nov 7, 2026, 3:58 PM' (999 if unparseable)."""
    from datetime import datetime
    for fmt in ("%b %d, %Y, %I:%M %p", "%b %d, %Y, %H:%M"):
        try:
            return (datetime.now() - datetime.strptime(stamp, fmt)).total_seconds() / 60
        except Exception:
            continue
    return 999.0


def tab_id_of(ws_url: str) -> str:
    return ws_url.rsplit("/", 1)[-1]


async def wait_text(s: Session, needle: str, tries: int = 12) -> bool:
    for _ in range(tries):
        t = (await s.ev("document.body.innerText") or "").lower()
        if needle in t:
            return True
        await asyncio.sleep(1)
    return False


async def main(dry: bool) -> int:
    creds = json.loads(SECRETS.read_text())["bugcrowd"]

    # ---- step 1: identifier -> Next -> passcode -------------------------------------------------
    ws_url = new_tab("https://bugcrowd.com/user/sign_in")
    async with websockets.connect(ws_url, max_size=40_000_000) as ws:
        s = Session(ws)
        await asyncio.sleep(5)
        if not await s.fill('input[name="identifier"]', creds["email"]):
            print("no identifier field; url:", await s.ev("location.href"))
            return 1
        await s.ev("""(() => { const c = document.querySelector('input[name=rememberMe]');
                     if (c && !c.checked) c.click(); })()""")
        await asyncio.sleep(0.5)
        await s.ev("""(() => { const b = [...document.querySelectorAll('button,input[type=submit]')]
                     .find(e => /next|continue|sign in|log in/i.test(e.innerText || e.value || ''));
                     if (b) b.click(); })()""")
        await asyncio.sleep(4)
        if not await s.fill('input[name="credentials.passcode"]', creds["password"]):
            print("no passcode field after Next; text:", (await s.snapshot(160)))
            return 1
        await s.ev("""(() => { const b = [...document.querySelectorAll('button,input[type=submit]')]
                     .find(e => /verify|sign in|next|continue|log in/i.test(e.innerText || e.value || ''));
                     if (b) b.click(); })()""")
        ok = await wait_text(s, "verification code")
        print("email-code prompt:", "reached" if ok else "NOT reached")
        if not ok:
            print("text:", await s.snapshot(200))
            return 1
        otab = tab_id_of(ws_url)

    # ---- step 2: newest emailed code, read in Gmail's own page ---------------------------------
    print("reading code from Gmail…")
    code = None
    code_when = None
    async with websockets.connect(new_tab("https://mail.google.com/mail/u/0/#search/"
                                          + urllib.parse.quote(GMAIL_Q)), max_size=40_000_000) as ws:
        g = Session(ws)
        await asyncio.sleep(7)
        for attempt in range(8):                      # poll: Okta may send a few seconds late
            for _ in range(5):
                if await g.ev("document.querySelectorAll('tr.zA').length"):
                    break
                await asyncio.sleep(2)
            # open each result thread, then harvest every message it holds
            nrows = int(await g.ev("document.querySelectorAll('tr.zA').length") or 0)
            cands = []
            for i in range(min(nrows, 4)):
                await g.ev(f"(() => {{ const r=[...document.querySelectorAll('tr.zA')]; if (r[{i}]) r[{i}].click(); }})()")
                await asyncio.sleep(4)
                msgs = json.loads(await g.ev(MSGS_JS) or "[]")
                for m in msgs:
                    got = re.findall(r"\b(\d{6})\b", m["text"])
                    if got:
                        cands.append((m["when"], got[-1]))
                await g.ev("(() => { const b=document.querySelector('.ar9,[aria-label=Back]'); if(b) b.click(); })()")
                await asyncio.sleep(2)
            fresh = [c for c in cands if _age_minutes(c[0]) <= 6]
            fresh.sort(key=lambda t: t[0])
            if fresh:
                code_when, code = fresh[-1]
                break
            print(f"   poll {attempt + 1}: no fresh code yet ({len(cands)} seen)")
            await g.ev("(() => { location.hash = '#search/' + encodeURIComponent('newer_than:10m'); location.reload(); })()")
            await asyncio.sleep(8)
    if not code:
        print("no fresh emailed code within ~90s — Okta is throttling sends for this account")
        return 1
    print("code found, length", len(code), "| mail stamp:", code_when)

    if dry:
        print("dry run: not typing the code")
        return 0

    # ---- step 3: type it into the waiting Okta tab ---------------------------------------------
    targets = json.load(urllib.request.urlopen(f"{CDP}/json/list"))
    target = next((t for t in targets if t["id"] == otab), None)
    if not target:
        print("okta tab gone:", otab)
        return 1
    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=40_000_000) as ws:
        s = Session(ws)
        typed = False
        for sel in CODE_SELECTORS:
            if await s.fill(sel, code):
                typed = True
                print("typed into", sel)
                break
        if not typed:
            print("no code field; text:", await s.snapshot(200))
            return 1
        await s.ev("""(() => { const b = [...document.querySelectorAll('button,input[type=submit]')]
                     .find(e => /verify|continue|next|sign in/i.test(e.innerText || e.value || ''));
                     if (b) b.click(); else { const f = document.querySelector('form'); if (f) f.requestSubmit(); } })()""")
        await asyncio.sleep(8)
        final = await s.ev("JSON.stringify({url: location.href, title: document.title, "
                           "text: document.body.innerText.slice(0, 220)})")
        print("landed:", final)
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main("--dry" in sys.argv)))
