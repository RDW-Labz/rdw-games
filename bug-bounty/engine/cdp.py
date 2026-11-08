#!/usr/bin/env python3
"""Tiny CDP client for the *user's own* Chromium on 127.0.0.1:9222.

The managed automation profile is a separate browser with separate cookies; when Michael signs in by
hand, the session lives here instead. This reads pages from that live browser (and can click/fill), so
work can continue in the session he already authenticated instead of asking him to log in twice.

    ./cdp.py tabs
    ./cdp.py text <tab_index_or_url_substring>
    ./cdp.py js <tab_index_or_url_substring> '<expression>'
    ./cdp.py nav <tab_index_or_url_substring> <url>
    ./cdp.py cookies <tab> <domain-substring>

Set CDP_PORT to drive a different browser (Brave via ~/bin/brave-debug listens on 9224).
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.request

import websockets

PORT = int(os.environ.get("CDP_PORT", "9222"))


def targets() -> list[dict]:
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as r:
        return [t for t in json.loads(r.read()) if t.get("type") == "page"]


def pick(sel: str) -> dict:
    ts = targets()
    if sel.isdigit():
        return ts[int(sel)]
    for t in ts:
        if sel in t["url"] or sel in t.get("title", ""):
            return t
    raise SystemExit(f"no tab matching {sel!r} — try: cdp.py tabs")


async def run(tab: dict, expr: str, do_nav: str | None = None) -> str:
    async with websockets.connect(tab["webSocketDebuggerUrl"], max_size=20_000_000) as ws:
        async def send(i: int, method: str, params: dict | None = None) -> dict:
            await ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == i:
                    return msg

        await send(1, "Runtime.enable")
        if do_nav:
            await send(2, "Page.enable")
            await send(3, "Page.navigate", {"url": do_nav})
            await asyncio.sleep(4)
        r = await send(9, "Runtime.evaluate",
                       {"expression": expr, "returnByValue": True, "awaitPromise": True})
        res = r.get("result", {}).get("result", {})
        return res.get("value") if isinstance(res.get("value"), (str, int, float, type(None))) else json.dumps(res)


async def cookie_names(tab: dict, domain_filter: str) -> str:
    """Cookie NAMES only (never values) for the tab's browser profile."""
    async with websockets.connect(tab["webSocketDebuggerUrl"], max_size=20_000_000) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Network.enable"}))
        await ws.send(json.dumps({"id": 2, "method": "Storage.getCookies"}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("id") == 2:
                if "error" in msg:
                    return json.dumps(msg["error"])
                ck = msg.get("result", {}).get("cookies", [])
                keep = [c for c in ck if domain_filter in c.get("domain", "")]
                return json.dumps([{"domain": c["domain"], "name": c["name"]} for c in keep])


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "tabs"
    if cmd == "tabs":
        for i, t in enumerate(targets()):
            print(f"{i:2} {t.get('title','')[:44]:46} {t['url'][:90]}")
        return
    if cmd == "text":
        print(asyncio.run(run(pick(sys.argv[2]), "document.body.innerText.slice(0,4000)")))
    elif cmd == "js":
        print(asyncio.run(run(pick(sys.argv[2]), sys.argv[3])))
    elif cmd == "nav":
        tab = pick(sys.argv[2])
        print(asyncio.run(run(tab, "location.href + ' | ' + document.title", sys.argv[3])))
    elif cmd == "cookies":
        tab = pick(sys.argv[2])
        dom = sys.argv[3] if len(sys.argv) > 3 else "."
        expr = ("(async () => { const c = await (await fetch('/'))(); return '' })()")
        # names only, never values
        r = asyncio.run(cookie_names(tab, dom))
        print(r)
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
