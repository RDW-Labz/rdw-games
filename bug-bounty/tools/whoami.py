"""Who is the lane browser signed in as, on each platform, proven by loading a real page."""
import asyncio
import json
import urllib.request

PORT = 9226


def http(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=6) as r:
        return json.loads(r.read())


async def new_page(url):
    import websockets
    async with websockets.connect(http("/json/version")["webSocketDebuggerUrl"], max_size=2 ** 23) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Target.createTarget", "params": {"url": url}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("id") == 1:
                tid = (m.get("result") or {}).get("targetId")
                break
    for _ in range(30):
        await asyncio.sleep(1)
        for t in http("/json/list"):
            if t.get("id") == tid or t.get("targetId") == tid:
                if t.get("webSocketDebuggerUrl"):
                    return tid, t["webSocketDebuggerUrl"]
    return tid, None


async def ev(ws_url, expr):
    import websockets
    async with websockets.connect(ws_url, max_size=2 ** 23) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                                  "params": {"expression": expr, "returnByValue": True,
                                             "awaitPromise": True}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("id") == 1:
                return (m.get("result") or {}).get("result", {}).get("value")


IDENT = """(async () => {
  const r = await fetch(location.origin + '/h/api/v1/me', {credentials:'include'}).catch(() => null);
  const hdr = document.querySelector('header')?.innerText?.slice(0,120) || '';
  return {url: location.pathname, title: document.title, me_api: r ? r.status : 'no-response', header: hdr};
})()"""

CHECKS = [
    ("bugcrowd", "https://bugcrowd.com/h/engagements", IDENT),
    ("hackerone", "https://hackerone.com/hackers", """(() => ({url: location.pathname, title: document.title,
      signed_in: !/sign_in/.test(location.pathname),
      who: (document.querySelector('[data-testid*=navigation] a[href*="hackers/"], a[href*="/@"]')?.textContent||'').trim(),
      body: document.body.innerText.slice(0, 160)}))()"""),
    ("gmail", "https://mail.google.com/mail/u/0/#inbox", """(() => ({url: location.pathname + location.hash,
      title: document.title, signed_in: /Inbox|^Gmail/.test(document.title)}))()"""),
]


async def main():
    for name, url, expr in CHECKS:
        tid, ws = await new_page(url)
        await asyncio.sleep(6)
        if not ws:
            print(f"{name}: tab never came up")
            continue
        try:
            print(f"{name}: {await ev(ws, expr)}")
        except Exception as e:
            print(f"{name}: evaluate failed ({type(e).__name__})")
        finally:
            try:
                async with __import__("websockets").connect(http("/json/version")["webSocketDebuggerUrl"]) as ws2:
                    await ws2.send(json.dumps({"id": 1, "method": "Target.closeTarget", "params": {"targetId": tid}}))
                    await asyncio.wait_for(ws2.recv(), 5)
            except Exception:
                pass


asyncio.run(main())
