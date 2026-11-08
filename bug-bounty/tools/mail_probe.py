"""Can the lane's browser see the security mailbox? The API lane is dead (invalid_grant), so replies to the
16 outreach offers are otherwise unmeasurable — and an unread reply is exactly where money would be hiding."""
import asyncio
import json
import sys
import urllib.parse
import urllib.request

PORT = 9226
URL = sys.argv[1] if len(sys.argv) > 1 else "https://mail.google.com/mail/u/0/#inbox"
READ = """JSON.stringify({path: location.pathname + location.hash, title: document.title,
  text: document.body.innerText.replace(/\\n{2,}/g,'\\n').slice(0,900)})"""


async def main():
    import websockets
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?{urllib.parse.quote(URL, safe='')}", method="PUT")
    url = json.load(urllib.request.urlopen(req))["webSocketDebuggerUrl"]
    await asyncio.sleep(12)
    async with websockets.connect(url, max_size=2 ** 23) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                                  "params": {"expression": READ, "returnByValue": True}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("id") == 1:
                print((m.get("result") or {}).get("result", {}).get("value"))
                return


asyncio.run(main())
