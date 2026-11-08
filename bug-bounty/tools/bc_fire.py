"""Fire a staged Bugcrowd draft: open it, find the real submit control, click it, and report what the server said.

Bugcrowd's draft editor only shows "Save draft" among the obvious form buttons, so this walks every
button/anchor/role=button on the page and prints the candidates when nothing matches — the submit step may
sit behind a review panel or be gated on identity verification.
"""
import asyncio
import base64
import json
import sys
import urllib.parse
import urllib.request

PORT = 9226
DRAFT = sys.argv[1]
DRY = "--dry" in sys.argv

CANDIDATES = """JSON.stringify([...document.querySelectorAll('button,a[role=button],a,button[type=submit]')]
  .map((b,i) => [i, (b.innerText||b.value||'').trim().replace(/\\s+/g,' ').slice(0,40), b.tagName,
                 b.disabled, (b.className||'').toString().slice(0,50)])
  .filter(x => x[1]))"""
STATE = """JSON.stringify({url: location.pathname, text: document.body.innerText.replace(/\\n{2,}/g,'\\n').slice(0,600)})"""


async def ev(ws, expr, mid=1):
    await ws.send(json.dumps({"id": mid, "method": "Runtime.evaluate",
                              "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            return (m.get("result") or {}).get("result", {}).get("value")


async def shot(ws, path):
    await ws.send(json.dumps({"id": 90, "method": "Page.captureScreenshot", "params": {"format": "png"}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == 90:
            data = (m.get("result") or {}).get("data")
            if data:
                open(path, "wb").write(base64.b64decode(data))
                print("shot:", path)
            return


async def main():
    import websockets
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?{urllib.parse.quote(DRAFT, safe='')}", method="PUT")
    url = json.load(urllib.request.urlopen(req))["webSocketDebuggerUrl"]
    await asyncio.sleep(10)
    async with websockets.connect(url, max_size=2 ** 23) as ws:
        print("page:", await ev(ws, "location.pathname"))
        print("buttons:", await ev(ws, CANDIDATES))
        if DRY:
            await shot(ws, "/tmp/bc_draft.png")
            return
        hit = await ev(ws, """(() => {
            const b = [...document.querySelectorAll('button,a[role=button]')]
              .find(e => /^submit( report)?$/i.test((e.innerText||'').trim().replace(/\\s+/g,' ')));
            if (!b) return 'no submit control';
            if (b.disabled) return 'submit disabled';
            b.scrollIntoView({block:'center'}); b.click(); return 'clicked';
        })()""")
        print("submit:", hit)
        await asyncio.sleep(9)
        print("state:", await ev(ws, STATE))
        await shot(ws, "/tmp/bc_submit_result.png")


asyncio.run(main())
