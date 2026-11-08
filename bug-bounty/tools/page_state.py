"""Prove what a HackerOne page actually says: text markers plus a screenshot you can look at.

`h1_login.py --whoami` answers "no password field on /dashboard", which is not the same question as
"signed in" — a signed-out dashboard can render a marketing wall with no password input at all. This
prints the identity markers a signed-in session must carry (handle, submissions link, sign-out) and writes
a PNG so the page can be read with vision_analyze instead of inferred.
"""
from __future__ import annotations

import asyncio
import base64
import json
import sys
import urllib.parse
import urllib.request

CDP = "http://127.0.0.1:9226"
URL = sys.argv[1] if len(sys.argv) > 1 else "https://hackerone.com/dashboard"
SHOT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/h1_state.png"

MARKERS = """JSON.stringify({
  url: location.href,
  title: document.title,
  has_signin_link: [...document.querySelectorAll('a,button')].some(e => /^sign in$/i.test((e.innerText||'').trim())),
  has_signout: [...document.querySelectorAll('a,button')].some(e => /sign out|log out/i.test(e.innerText||'')),
  password_field: !!document.querySelector('input[type=password]'),
  body: document.body.innerText.replace(/\\n{2,}/g,'\\n').slice(0, 900)
})"""


async def main() -> int:
    import websockets
    req = urllib.request.Request(f"{CDP}/json/new?{urllib.parse.quote(URL, safe='')}", method="PUT")
    wsurl = json.load(urllib.request.urlopen(req))["webSocketDebuggerUrl"]
    await asyncio.sleep(10)
    async with websockets.connect(wsurl, max_size=2 ** 24) as ws:
        n = 0

        async def ev(expr, mid=None):
            nonlocal n
            n += 1
            await ws.send(json.dumps({"id": n, "method": "Runtime.evaluate",
                                      "params": {"expression": expr, "returnByValue": True}}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == n:
                    return (m.get("result") or {}).get("result", {}).get("value")

        print(await ev(MARKERS))
        await ws.send(json.dumps({"id": 999, "method": "Page.captureScreenshot", "params": {"format": "png"}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("id") == 999:
                data = (m.get("result") or {}).get("data")
                if data:
                    open(SHOT, "wb").write(base64.b64decode(data))
                    print("shot:", SHOT)
                break
    return 0


raise SystemExit(asyncio.run(main()))
