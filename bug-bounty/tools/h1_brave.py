"""Minimal CDP driver, defaulting to the bounty lane's own browser on :9226.

It used to point at Michael's real Brave on :9224, because a default Chromium could not pass Cloudflare
and his session could. The lane now runs its own Chromium on the bounty bot screen with a persistent
profile (software GL so Turnstile has WebGL) and passes the wall itself, so nothing here should reach
into his desktop any more. Override with CDP_PORT when driving another browser deliberately.

Only used to read page state and type into forms we are allowed to type into. It never reads
cookie values and never handles credentials.
"""
import json
import asyncio
import os
import urllib.parse
import urllib.request

import websockets

PORT = int(os.environ.get("CDP_PORT", "9226"))


def _pages():
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as r:
        return [t for t in json.load(r) if t["type"] == "page"]


def first_page_id(prefer="hackerone.com"):
    """Return the target id of an existing page, preferring one already on HackerOne."""
    pages = _pages()
    if not pages:
        raise RuntimeError(f"no browser pages open on :{PORT} — start the lane: systemctl --user start bounty-browser")
    for p in pages:
        if prefer in (p.get("url") or ""):
            return p["id"]
    return pages[0]["id"]


def new_target(url="about:blank"):
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/json/new?{urllib.parse.quote(url, safe='')}", method="PUT")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


class Tab:
    def __init__(self, target_id=None, url=None):
        if url:
            target_id = new_target(url)["id"]
        self.target_id = target_id

    async def _ws(self):
        info = next(t for t in _pages() if t["id"] == self.target_id)
        return await websockets.connect(info["webSocketDebuggerUrl"], max_size=2 ** 25)

    async def send(self, method, **params):
        ws = await self._ws()
        try:
            await ws.send(json.dumps({"id": 1, "method": method, "params": params}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == 1:
                    return msg
        finally:
            await ws.close()

    def eval(self, expr):
        r = self.send("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=True, userGesture=True)
        res = asyncio.run(r)
        if "error" in res:
            return {"error": res["error"]}
        out = res["result"]["result"]
        return out.get("value", out)

    def goto(self, url, wait=4.0):
        asyncio.run(self.send("Page.navigate", url=url))
        import time
        time.sleep(wait)
        return self.eval("location.href")

    def click(self, js_expr):
        """Click whatever the expression resolves to (dispatch a real MouseEvent)."""
        return self.eval(f"(()=>{{const e={js_expr}; if(!e) return 'no-element';"
                         f" e.scrollIntoView({{block:'center'}}); e.click(); return 'clicked';}})()")

    def type_text(self, text):
        asyncio.run(self.send("Input.insertText", text=text))

    def press(self, key):
        codes = {"Enter": 13, "Tab": 9, "Escape": 27, "ArrowDown": 40, "Backspace": 8}
        for kind in ("keyDown", "keyUp"):
            asyncio.run(self.send("Input.dispatchKeyEvent", type=kind, key=key,
                                  windowsVirtualKeyCode=codes.get(key, 0),
                                  nativeVirtualKeyCode=codes.get(key, 0)))
        return key

    def set_value(self, selector, value):
        """Set a React-controlled input/textarea through the native setter so its state updates."""
        expr = (
            "(()=>{const el=document.querySelector(%r);"
            "const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;"
            "Object.getOwnPropertyDescriptor(proto,'value').set.call(el,%r);"
            "el.dispatchEvent(new Event('input',{bubbles:true}));"
            "el.dispatchEvent(new Event('change',{bubbles:true}));"
            "return el.value.length;})()" % (selector, value))
        return self.eval(expr)

    def set_value_by_id(self, el_id, value):
        """Same native-setter trick, but by element id (unquoted numeric ids break querySelector)."""
        expr = (
            "(()=>{const el=document.getElementById(%r); if(!el) return 'missing';"
            "const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;"
            "Object.getOwnPropertyDescriptor(proto,'value').set.call(el,%r);"
            "el.dispatchEvent(new Event('input',{bubbles:true}));"
            "el.dispatchEvent(new Event('change',{bubbles:true}));"
            "return el.value.length;})()" % (el_id, value))
        return self.eval(expr)

    def viewport(self, w=1400, h=1000, scale=1):
        return asyncio.run(self.send("Emulation.setDeviceMetricsOverride", width=w, height=h,
                                     deviceScaleFactor=scale, mobile=False))

    def full_shot(self, path):
        """Screenshot the whole scrollable document, not just the 560px default viewport."""
        h = self.eval("Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)")
        asyncio.run(self.send("Emulation.setDeviceMetricsOverride", width=1400, height=int(h) + 40,
                              deviceScaleFactor=1, mobile=False))
        shot = asyncio.run(self.send("Page.captureScreenshot", format="png"))
        data = shot.get("data")
        if not data:
            return "no-data"
        import base64
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(data))
        return path

    def title(self):
        return self.eval("document.title")

    def text(self, selector="body", limit=1200):
        return self.eval(f"(document.querySelector({selector!r})||document.body).innerText.slice(0,{limit})")

    def shot(self, path):
        import base64
        res = asyncio.run(self.send("Page.captureScreenshot", format="png"))
        data = res["result"]["data"]
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        return path
