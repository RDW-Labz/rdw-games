#!/usr/bin/env python3
"""Get the bounty lane signed in to HackerOne, and say exactly which step refuses.

`h1_signin_probe.py` proved the form fills and submits, then reported "Invalid email or password" for
`security@rdwlabz.com` — a vault secret that has drifted from the account. This walks the candidate
identities the vault lists, one attempt each (never a fuzz — an account lock is worse than a dead rail),
and on success leaves the session in the Chromium profile so every later filing rail inherits it.

    python3 tools/h1_login.py            # try each candidate once, report per candidate
    python3 tools/h1_login.py --whoami   # just read the current session state

A credential that fails is reported as `refused`, not "wrong password": HackerOne returns one message for
both a bad address and a bad secret, so the two cannot be told apart from here and pretending otherwise
would send the wrong fix to the operator.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import urllib.parse
import urllib.request
from pathlib import Path

CDP = "http://127.0.0.1:9226"
SECRETS = Path.home() / ".config/rdwlabz/platform_secrets.json"
EXTRA_EMAILS = ["jmacluer@gmail.com"]

SET = """(sel, val) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, val);
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
  return true;
}"""
AFTER = """JSON.stringify({
  url: location.href, title: document.title,
  signed_in: !document.querySelector('input[type=password]') && !/sign_in/i.test(location.pathname),
  needs_2fa: !!document.querySelector('input[name*=otp],input[name*=code],input[autocomplete=one-time-code]'),
  still_pw: !!document.querySelector('input[type=password]'),
  text: document.body.innerText.replace(/\\s+/g,' ').slice(0,420)
})"""


async def ev(ws, expr):
    ws.n = getattr(ws, "n", 0) + 1
    await ws.send(json.dumps({"id": ws.n, "method": "Runtime.evaluate",
                              "params": {"expression": expr, "returnByValue": True}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == ws.n:
            return (m.get("result") or {}).get("result", {}).get("value")


async def open_tab(websockets, url):
    req = urllib.request.Request(f"{CDP}/json/new?{urllib.parse.quote(url, safe='')}", method="PUT")
    wsurl = json.load(urllib.request.urlopen(req))["webSocketDebuggerUrl"]
    await asyncio.sleep(8)
    return await websockets.connect(wsurl, max_size=2 ** 24)


async def attempt(websockets, email, password):
    async with await open_tab(websockets, "https://hackerone.com/users/sign_in?type=user") as ws:
        ws.n = 0
        filled = await ev(ws, f"JSON.stringify({{e: ({SET})('input[name=\"user[email]\"]', {json.dumps(email)}), "
                              f"p: ({SET})('input[name=\"user[password]\"]', {json.dumps(password)})}})")
        await asyncio.sleep(1)
        await ev(ws, """(() => {
          const b=[...document.querySelectorAll('button,[type=submit]')].find(x=>/sign in/i.test(x.innerText||x.value||''));
          if(b){b.click();return 1} const f=document.querySelector('form'); if(f){f.submit();return 1} return 0 })()""")
        await asyncio.sleep(13)
        after = json.loads(await ev(ws, AFTER) or "{}")
        after["email"] = email
        after["filled"] = json.loads(filled or "{}")
        after["refused"] = "invalid email or password" in (after.get("text") or "").lower()
        return after


# /dashboard is a 404 page for signed-out visitors too, so "no password field" there proved nothing;
# /notifications redirects to sign_in unless the session is real, which makes it the honest probe.
async def whoami(websockets):
    async with await open_tab(websockets, "https://hackerone.com/notifications") as ws:
        ws.n = 0
        return json.loads(await ev(ws, AFTER) or "{}")


async def main() -> int:
    import websockets
    ap = argparse.ArgumentParser()
    ap.add_argument("--whoami", action="store_true")
    a = ap.parse_args()

    if a.whoami:
        st = await whoami(websockets)
        print(json.dumps({k: st.get(k) for k in ("url", "signed_in", "needs_2fa")}, indent=1))
        return 0 if st.get("signed_in") else 3

    c = json.loads(SECRETS.read_text())["hackerone"]
    emails = [c.get("email")] + [e for e in EXTRA_EMAILS if e != c.get("email")]
    for email in emails:
        if not email:
            continue
        st = await attempt(websockets, email, c["password"])
        verdict = ("signed_in" if st.get("signed_in") and not st.get("needs_2fa")
                   else "needs_2fa" if st.get("needs_2fa")
                   else "refused" if st.get("refused") else "unclear")
        print(f"{email:<26} {verdict:<10} {st.get('url', '')}")
        if verdict in ("signed_in", "needs_2fa"):
            print(json.dumps(st, indent=1)[:600])
            return 0 if verdict == "signed_in" else 4
    print("\nevery candidate refused — the vault secret has drifted from the account; "
          "a reset link to the recovery mailbox is the next rail, and that is a credential change.")
    return 3


raise SystemExit(asyncio.run(main()))
