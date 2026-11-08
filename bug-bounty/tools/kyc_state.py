"""Read the identity-verification gate: is Bugcrowd verified, pending, or not started?

`--write` stamps engine/.kyc.json, which board.py's `bugcrowd:kyc` rail reads. The stamp matters because the
vendor only lets you look so often: the rail carries the stamp's age instead of probing on every board draw.
"""
import argparse
import asyncio
import datetime as dt
import json
import urllib.request
from pathlib import Path

PORT = 9226
STAMP = Path(__file__).resolve().parent.parent / "engine" / ".kyc.json"


def classify(text: str) -> tuple:
    if "Start identity verification" in text:
        return False, "not started — Start identity verification is still offered"
    if "verified" in text.lower() and "Identity verification" in text:
        return True, "verified"
    return False, "state unclear"


async def main():
    import websockets
    pages = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=6).read())
    tabs = [p for p in pages if "identity_verification" in (p.get("url") or "")]
    if not tabs:
        print("no identity tab open")
        return
    async with websockets.connect(tabs[0]["webSocketDebuggerUrl"], max_size=2 ** 23) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
            "expression": "JSON.stringify({url: location.href, text: document.body.innerText.replace(/\\n{2,}/g,'\\n').slice(0, 1400),"
                          " buttons: [...document.querySelectorAll('button,a[role=button]')].map(b => (b.innerText||'').trim()).filter(Boolean).slice(0,10)})",
            "returnByValue": True}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("id") == 1:
                raw = (m.get("result") or {}).get("result", {}).get("value")
                d = json.loads(raw)
                verified, why = classify(d["text"])
                print(json.dumps({"verified": verified, "detail": why, "url": d["url"],
                                  "buttons": d["buttons"]}, indent=1))
                if AP.write:
                    STAMP.write_text(json.dumps({"verified": verified, "detail": why,
                                                 "checked": dt.datetime.now(dt.timezone.utc).isoformat()},
                                                indent=1))
                    print(f"stamped {STAMP}")
                break


AP = argparse.ArgumentParser()
AP.add_argument("--write", action="store_true", help="stamp engine/.kyc.json for the board's kyc rail")
ARGS = AP.parse_args()
AP = ARGS
asyncio.run(main())
