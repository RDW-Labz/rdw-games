#!/usr/bin/env python3
"""Drive platform logins in a private automation tab of the user's Brave, over CDP.

Two rules this file exists to enforce:
  * it opens its OWN tab for every run, so the human's live tabs are never navigated or
    clicked underneath them;
  * credentials come out of ~/.config/rdwlabz/platform_secrets.json inside the page's own
    JavaScript — they never appear in argv, a log line, or an agent transcript.

Modes
  state <url>      open a tab, report where it landed (auth probe)
  inspect <plat>   open the platform's login page, list its form fields
  okta <plat>      two-step Okta login (email -> Next -> passcode)
  login <plat>     single-page email+password login

  python3 engine/browser_login.py okta bugcrowd
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.request
from pathlib import Path

import websockets

# 9226 is the bounty lane's own browser on the bounty bot screen. 9224 was Michael's real Brave, which
# meant every sign-in was his click on his desktop; the lane now signs itself in.
CDP = os.environ.get("CDP_URL") or f"http://127.0.0.1:{os.environ.get('CDP_PORT', '9226')}"
SECRETS = Path.home() / ".config/rdwlabz/platform_secrets.json"

TARGETS = {
    "hackerone": {"url": "https://hackerone.com/users/sign_in?type=user",
                  "email": ['input[name="user[email]"]', 'input[type="email"]', "#user_email"],
                  "pass": ['input[name="user[password]"]', 'input[type="password"]', "#user_password"],
                  "submit": ['input[type="submit"]', 'button[type="submit"]']},
    "bugcrowd": {"url": "https://bugcrowd.com/user/sign_in",  # Okta: identifier -> passcode
                 "email": ['input[name="identifier"]'],
                 "pass": ['input[name="credentials.passcode"]'],
                 "submit": ['button[type="submit"]', 'input[type="submit"]']},
    "intigriti": {"url": "https://login.intigriti.com/account/login",  # email -> Password
                  "email": ["#Input_Email"],
                  "pass": ["#Input_Password", 'input[type="password"]'],
                  "submit": ['button[type="submit"]', 'input[type="submit"]']},
}

JS_SET = """(sel, val) => {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el) return false;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, val);
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
  return true;
}"""


def new_tab(url: str) -> str:
    req = urllib.request.Request(f"{CDP}/json/new?{urllib.parse.quote(url, safe='')}", method="PUT")
    return json.load(urllib.request.urlopen(req))["webSocketDebuggerUrl"]


class Session:
    def __init__(self, ws):
        self.ws, self.n = ws, 0

    async def send(self, method: str, **params):
        self.n += 1
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == self.n:
                return msg.get("result", {})

    async def ev(self, expr: str, await_promise: bool = False):
        r = await self.send("Runtime.evaluate", expression=expr, returnByValue=True,
                            awaitPromise=await_promise)
        return r.get("result", {}).get("value")

    async def fill(self, selector: str, value: str) -> bool:
        return bool(await self.ev(f"({JS_SET})({json.dumps(selector)}, {json.dumps(value)})"))

    async def snapshot(self, chars: int = 220) -> str:
        return await self.ev(
            "JSON.stringify({url: location.href, title: document.title, "
            f"text: document.body.innerText.replace(/\\s+/g,' ').slice(0,{chars})}})")

    async def fields(self) -> str:
        return await self.ev("""JSON.stringify({
          url: location.href, title: document.title,
          inputs: [...document.querySelectorAll('input')].map(i=>({n:i.name,id:i.id,t:i.type})),
          buttons: [...document.querySelectorAll('button,[type=submit]')].map(b=>(b.innerText||b.value||'').trim().slice(0,24)),
          text: document.body.innerText.replace(/\\s+/g,' ').slice(0,200)})""")


def _creds(plat: str) -> dict:
    return json.loads(SECRETS.read_text())[plat]


async def run(mode: str, plat: str) -> int:
    if plat.startswith("http"):
        cfg = {"url": plat, "email": [], "pass": [], "submit": []}
    else:
        cfg = TARGETS.get(plat) if mode != "state" else {"url": plat}
    if cfg is None:
        print(f"unknown platform {plat}")
        return 2
    wsurl = new_tab(cfg["url"])
    async with websockets.connect(wsurl, max_size=2 ** 24) as ws:
        s = Session(ws)
        await s.send("Page.enable")
        await asyncio.sleep(7)

        if mode == "state":
            print(await s.snapshot(160))
            print("signin:", await s.ev("""JSON.stringify([...document.querySelectorAll('a,button')]
              .filter(e=>/sign ?in|log ?in/i.test((e.innerText||'')+(e.getAttribute('href')||'')))
              .map(e=>({tag:e.tagName, text:(e.innerText||'').trim().slice(0,20), href:e.href||'', cls:(e.className||'').toString().slice(0,30)})).slice(0,8))"""))
            return 0
        if mode == "inspect":
            print(await s.fields())
            return 0

        if mode == "okta":
            c = _creds(plat)
            # A cookie banner sits over the form and swallows the Next click: the button is found and
            # `.click()` returns true, the page simply does not change, which reads exactly like a wrong
            # password. Clear the banner before touching anything.
            print("cookies:", await s.ev("""(() => {
              const b=[...document.querySelectorAll('button')].find(x=>/accept all|reject all/i.test(x.innerText||''));
              if(b){b.click();return 'dismissed'} return 'none' })()"""))
            await asyncio.sleep(1)
            if not await s.fill(cfg["email"][0], c["email"]):
                print("identifier field missing:", await s.snapshot(160))
                return 0
            await s.ev("""(() => {
              const c = document.querySelector('input[name=rememberMe]');
              if (c && !c.checked) { c.click(); return 'remember-me on'; } return 'already on';
            })()""")
            await asyncio.sleep(0.4)
            print("next:", await s.ev("""(() => {
              const b=[...document.querySelectorAll('button,input[type=submit]')].find(x=>/next|sign in/i.test(x.innerText||x.value||''));
              if(b){b.click();return 'clicked'} return 'none' })()"""))
            await asyncio.sleep(3)
            # A click that lands before the SPA hydrates leaves the page on step 1. Fall back to the form's
            # own submit, which is what the button does anyway, and only then treat "still step 1" as real.
            if not await s.ev('!!document.querySelector(\'input[type="password"]\')'):
                print("retry:", await s.ev("""(() => {
                  const f=document.querySelector('form'); if(!f) return 'no form';
                  f.requestSubmit(); return 'requestSubmit' })()"""))
                await asyncio.sleep(4)
            await asyncio.sleep(4)
            print("step2:", await s.snapshot(200))
            page_text = (await s.ev("document.body.innerText") or "").lower()
            if "verification code" in page_text or "verify with your email" in page_text:
                print("HANDOFF: email-code screen reached — tab left open, nothing submitted.")
                return 0
            has_field = await s.ev(f'!!document.querySelector({json.dumps(cfg["pass"][0])})')
            sel = cfg["pass"][0] if has_field else 'input[type="password"]'
            if not has_field and not await s.ev('!!document.querySelector(\'input[type="password"]\')'):
                print("no password field -> stopping; state:", await s.snapshot(200))
                return 0
            if not await s.fill(sel, c["password"]):
                print("passcode fill failed")
                return 0
            await asyncio.sleep(0.6)
            print("verify:", await s.ev("""(() => {
              const b=[...document.querySelectorAll('button,input[type=submit]')].find(x=>/verify|sign in|next|continue/i.test(x.innerText||x.value||''));
              if(b){b.click();return 'clicked'} const f=document.querySelector('form'); if(f){f.submit();return 'form'} return 'none' })()"""))
            await asyncio.sleep(12)
            print("after:", await s.snapshot(280))
            return 0

        # single-page login
        c = _creds(plat)
        em, pm = cfg["email"][0], cfg["pass"][0]
        print("fill:", await s.ev(
            f"JSON.stringify({{email: ({JS_SET})({json.dumps(em)}, {json.dumps(c['email'])}), "
            f"pass: ({JS_SET})({json.dumps(pm)}, {json.dumps(c['password'])})}})"))
        await asyncio.sleep(0.6)
        print("submit:", await s.ev("""(() => {
          const b=[...document.querySelectorAll('button,input[type=submit]')].find(x=>/sign in|log in|submit|continue/i.test(x.innerText||x.value||''));
          if(b){b.click();return 'clicked'} const f=document.querySelector('form'); if(f){f.submit();return 'form'} return 'none' })()"""))
        await asyncio.sleep(12)
        print("after:", await s.snapshot(280))
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: F401  (used in new_tab)
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(1)
    raise SystemExit(asyncio.run(run(sys.argv[1], sys.argv[2])))