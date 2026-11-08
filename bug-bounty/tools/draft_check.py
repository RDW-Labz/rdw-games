"""Prove a staged Bugcrowd draft is really on the server: open its edit URL and read the fields back."""
import asyncio
import json
import sys
import urllib.parse
import urllib.request

PORT = 9226
DRAFT = sys.argv[1] if len(sys.argv) > 1 else "https://bugcrowd.com/engagements/epam-mbb-og/submissions/fb947741-703e-419b-870a-fac8322092ad/edit"

READ = """JSON.stringify({
  url: location.pathname,
  caption: document.querySelector('input[name="submission[caption]"]')?.value?.slice(0,120),
  target: document.querySelector('select[name="submission[target_id]"]')?.selectedOptions?.[0]?.textContent,
  vrt: document.querySelector('input[name="submission[original_vrt_id]"]')?.value,
  desc_len: document.querySelector('textarea[name="submission[description]"]')?.value?.length,
  buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean).slice(0,6) })"""


async def main():
    import websockets
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?{urllib.parse.quote(DRAFT, safe='')}", method="PUT")
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
