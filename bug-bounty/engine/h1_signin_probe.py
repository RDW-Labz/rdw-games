#!/usr/bin/env python3
"""One-off: attempt a HackerOne sign-in on the bounty lane browser and report exactly what the page says.

browser_login.py's single-page path fills and submits and then prints a short snapshot, which hides the
thing that matters when a submit bounces: the form's own error line. This walks the same form and prints
every alert/error node, whether the password field is still there, and the URL after submit.
"""
import asyncio
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import websockets

CDP = "http://127.0.0.1:9226"
SECRETS = Path.home() / ".config/rdwlabz/platform_secrets.json"
JS_SET = """(sel, val) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, val);
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
  return true;
}"""


async def main() -> int:
    url = "https://hackerone.com/users/sign_in?type=user"
    req = urllib.request.Request(f"{CDP}/json/new?{urllib.parse.quote(url, safe='')}", method="PUT")
    wsurl = json.load(urllib.request.urlopen(req))["webSocketDebuggerUrl"]
    async with websockets.connect(wsurl, max_size=2 ** 24) as ws:
        n = 0

        async def ev(expr, await_promise=False):
            nonlocal n
            n += 1
            await ws.send(json.dumps({"id": n, "method": "Runtime.evaluate",
                                      "params": {"expression": expr, "returnByValue": True,
                                                 "awaitPromise": await_promise}}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == n:
                    return (m.get("result") or {}).get("result", {}).get("value")

        await asyncio.sleep(9)
        print("form:", await ev("""JSON.stringify({
          inputs: [...document.querySelectorAll('input')].map(i=>({n:i.name,id:i.id,t:i.type})),
          buttons: [...document.querySelectorAll('button,[type=submit]')].map(b=>(b.innerText||b.value||'').trim()),
          cf: !!document.querySelector('iframe[src*=challenges], iframe[src*=turnstile], .cf-turnstile')})"""))

        c = json.loads(SECRETS.read_text())["hackerone"]
        print("fill:", await ev(f"JSON.stringify({{email: ({JS_SET})('input[name=\"user[email]\"]', {json.dumps(c['email'])}), "
                                    f"pass: ({JS_SET})('input[name=\"user[password]\"]', {json.dumps(c['password'])})}})"))
        await asyncio.sleep(1)
        print("submit:", await ev("""(() => {
          const b=[...document.querySelectorAll('button,[type=submit]')].find(x=>/sign in/i.test(x.innerText||x.value||''));
          if(b){b.click();return 'clicked'} const f=document.querySelector('form'); if(f){f.submit();return 'form'} return 'none' })()"""))
        await asyncio.sleep(12)
        print("after:", await ev("""JSON.stringify({
          url: location.href, title: document.title,
          still_pw: !!document.querySelector('input[type=password]'),
          errors: [...document.querySelectorAll('[role=alert],.error,[class*=error],[class*=Error],[data-testid*=error]')]
                  .map(e=>(e.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,6),
          text: document.body.innerText.replace(/\\s+/g,' ').slice(0,500)})"""))
    return 0


sys.exit(asyncio.run(main()))
