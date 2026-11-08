#!/usr/bin/env python3
"""Talk WebDriver BiDi to a Firefox that is already running.

Selenium launches and owns a browser; this does the opposite. When a login flow has to survive between
calls — an MFA prompt waiting for a phone, a form a human has to finish — the browser must outlive the
driver process, so it is started once with `--remote-debugging-port` and driven over BiDi here.

  python3 engine/bidi.py text                     # document.body.innerText of the first tab
  python3 engine/bidi.py click "Send notification"
  python3 engine/bidi.py eval "document.title"
  python3 engine/bidi.py tabs
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.request

import websockets

PORT = 59873


def endpoint() -> str:
    return f"ws://127.0.0.1:{PORT}/session"


class Bidi:
    def __init__(self, ws):
        self.ws, self.id, self.ctx = ws, 0, None

    async def send(self, method: str, params: dict | None = None) -> dict:
        self.id += 1
        mid = self.id
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=60))
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    async def close(self) -> None:
        """Releasing the session matters: Firefox refuses a second session.new while one is attached."""
        try:
            await self.send("session.end", {})
        except Exception:
            pass

    async def open(self) -> "Bidi":
        r = await self.send("session.new", {"capabilities": {}})
        tree = await self.send("browsingContext.getTree")
        ctxs = tree.get("contexts", [])
        if not ctxs:
            raise RuntimeError("no tabs")
        self.ctx = ctxs[0]["context"]
        return self

    async def tab(self) -> dict:
        tree = await self.send("browsingContext.getTree")
        return tree["contexts"][0]

    async def js(self, expr: str) -> object:
        r = await self.send("script.evaluate", {
            "expression": expr, "target": {"context": self.ctx},
            "awaitPromise": True, "resultOwnership": "none"})
        res = r.get("result", {})
        if r.get("type") == "exception":
            raise RuntimeError(res.get("description", "js error"))
        return res.get("value")


async def amain(a) -> int:
    async with websockets.connect(endpoint(), max_size=8 << 20) as ws:
        b = await Bidi(ws).open()
        try:
            return await dispatch(b, a)
        finally:
            await b.close()


async def dispatch(b: "Bidi", a) -> int:
    if True:
        if a.cmd == "tabs":
            tree = await b.send("browsingContext.getTree")
            for c in tree["contexts"]:
                print(" ", c["context"], c.get("url", "")[:100])
        elif a.cmd == "text":
            print(await b.js("document.body.innerText"))
        elif a.cmd == "eval":
            print(json.dumps(await b.js(a.arg), indent=1, default=str))
        elif a.cmd == "goto":
            await b.send("browsingContext.navigate",
                         {"context": b.ctx, "url": a.arg, "wait": "complete"})
            print("at", await b.js("location.href"))
        elif a.cmd == "click":
            label = a.arg.replace("'", "\\'")
            expr = f"""(() => {{
              const t = '{label}'.toLowerCase();
              const els = [...document.querySelectorAll('button,a,input[type=submit],div[role=button]')];
              const el = els.find(e => ((e.innerText||e.value||'').trim().toLowerCase() === t))
                      || els.find(e => ((e.innerText||e.value||'').toLowerCase().includes(t)));
              if (!el) return 'NOT_FOUND';
              el.scrollIntoView({{block:'center'}}); el.click();
              return 'CLICKED: ' + ((el.innerText||el.value||'').trim().slice(0,60));
            }})()"""
            print(await b.js(expr))
        return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["text", "click", "eval", "tabs", "goto"])
    ap.add_argument("arg", nargs="?", default="document.title")
    return asyncio.run(amain(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
