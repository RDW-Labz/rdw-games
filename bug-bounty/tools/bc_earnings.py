"""Read Bugcrowd's own money page so the earnings answer comes from the platform, not our ledger."""
import asyncio
import json
import urllib.parse
import urllib.request

PORT = 9226
URL = "https://bugcrowd.com/h/reward_claims"
READ = """JSON.stringify({path: location.pathname, text: document.body.innerText.replace(/\\n{2,}/g,'\\n').slice(0,1200)})"""


async def main():
    import websockets
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?{urllib.parse.quote(URL, safe='')}", method="PUT")
    url = json.load(urllib.request.urlopen(req))["webSocketDebuggerUrl"]
    await asyncio.sleep(9)
    async with websockets.connect(url, max_size=2 ** 23) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                                  "params": {"expression": READ, "returnByValue": True}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("id") == 1:
                print((m.get("result") or {}).get("result", {}).get("value"))
                return


asyncio.run(main())
