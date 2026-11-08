#!/usr/bin/env python3
"""Screenshot a page in a CDP browser to a PNG file.

Used against the bounty lane's browser (port 9226, on the bounty bot screen) because the interesting
pages are the ones that refuse a plain fetch: Cloudflare interstitials, sign-in forms, report pages.
Seeing the pixels is the only way to know the bot is looking at the same thing a human would.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import urllib.request

import websockets

PORT = int(os.environ.get("CDP_PORT", "9226"))


def pick(sel: str) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as r:
        pages = [t for t in json.loads(r.read()) if t.get("type") == "page"]
    if not pages:
        raise SystemExit("no page targets")
    if sel.isdigit():
        return pages[int(sel)]
    for t in pages:
        if sel in t["url"] or sel in t.get("title", ""):
            return t
    return pages[0]


async def shot(tab: dict, out: str, full: bool) -> None:
    async with websockets.connect(tab["webSocketDebuggerUrl"], max_size=40 * 1024 * 1024) as ws:
        async def send(i: int, method: str, params: dict | None = None) -> dict:
            await ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == i:
                    return msg

        await send(1, "Page.enable")
        params = {"format": "png", "captureBeyondViewport": full}
        res = (await send(2, "Page.captureScreenshot", params)).get("result") or {}
        data = res.get("data")
        if not data:
            raise SystemExit(f"no screenshot data: {json.dumps(res)[:200]}")
        with open(out, "wb") as fh:
            fh.write(base64.b64decode(data))
        print(out)


if __name__ == "__main__":
    sel = sys.argv[1] if len(sys.argv) > 1 else "0"
    out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/shot.png"
    asyncio.run(shot(pick(sel), out, "--full" in sys.argv))
