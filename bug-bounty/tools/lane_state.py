"""Ask the lane browser what it actually is: identity, tab count, and who is signed in."""
import asyncio
import json
import urllib.request

PORT = 9226


def http(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=6) as r:
        return json.loads(r.read())


async def ev(ws_url, expr, timeout=12):
    import websockets
    async with websockets.connect(ws_url, max_size=2 ** 23) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                                  "params": {"expression": expr, "returnByValue": True,
                                             "awaitPromise": True}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("id") == 1:
                return (m.get("result") or {}).get("result", {}).get("value")


async def main():
    ver = http("/json/version")
    print("browser:", ver.get("Browser"), "| ua:", ver.get("User-Agent", "")[:60])
    pages = [t for t in http("/json/list") if t.get("type") == "page"]
    print("pages:", len(pages))
    from collections import Counter
    hosts = Counter((p.get("url") or "").split("/")[2] if "//" in (p.get("url") or "") else p.get("url")
                    for p in pages)
    for h, n in hosts.most_common(8):
        print(f"   {n:3d}  {h}")

    # cookies: who is signed in, by session cookie presence
    import websockets
    target = pages[0]
    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=2 ** 22) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Network.getCookies", "params": {"urls": [
            "https://hackerone.com", "https://bugcrowd.com", "https://accounts.google.com",
            "https://mail.google.com", "https://login.hackers.bugcrowd.com"]}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("id") == 1:
                names = sorted({c["name"] for c in (m.get("result") or {}).get("cookies") or []})
                break
    print("cookie names:", ", ".join(names) if names else "(none)")

    # live page truth on whichever bugcrowd tab is furthest along
    for p in pages:
        u = p.get("url") or ""
        if "bugcrowd.com/h/" in u or "bugcrowd.com/engagements" in u:
            t = await ev(p["webSocketDebuggerUrl"],
                          "(() => [location.pathname, document.title, !!document.querySelector('[data-testid*=avatar],a[href*=logout],a[href*=sign_out]')])()")
            print(f"   probe {u[:58]:60s} -> {t}")
            break


asyncio.run(main())
