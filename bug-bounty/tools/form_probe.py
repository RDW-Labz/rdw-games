"""Inventory the live Bugcrowd submission form: target options, field state, submit buttons, screenshot.

Several /submissions/new tabs accumulate across runs, so the tab with the most description text is the one
that was actually filled; probing the first tab reported an empty form while a filled one sat next to it.
"""
import asyncio
import base64
import json
import urllib.request

PORT = 9226
DESC_LEN = ('document.querySelector(\'textarea[name="submission[description]"]\')?.value.length || 0')


async def ev(ws, expr, mid=1):
    await ws.send(json.dumps({"id": mid, "method": "Runtime.evaluate",
                              "params": {"expression": expr, "returnByValue": True}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            return (m.get("result") or {}).get("result", {}).get("value")


async def main():
    import websockets
    pages = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=6).read())
    forms = [p for p in pages if (p.get("url") or "").endswith("/submissions/new")]
    if not forms:
        print("no open form tab")
        return
    tab, best = None, -1
    for cand in forms:
        try:
            async with websockets.connect(cand["webSocketDebuggerUrl"], max_size=2 ** 22) as w:
                n = await ev(w, DESC_LEN) or 0
        except Exception:
            n = 0
        if n > best:
            best, tab = n, cand
    print(f"tab: {tab['url']} | description chars: {best}")
    async with websockets.connect(tab["webSocketDebuggerUrl"], max_size=2 ** 23) as ws:
        print("fields:", await ev(ws, """JSON.stringify([...document.querySelectorAll('input,select,textarea')]
            .map(e => [e.tagName, e.type || '', e.name || e.id]).filter(x => x[2]))"""))
        print("targets:", await ev(ws, """JSON.stringify([...document.querySelectorAll('select[name="submission[target_id]"] option')]
            .map(o => [o.value, o.textContent.trim()]).filter(x => /emakina|takeover/i.test(x[1])))"""))
        print("state:", await ev(ws, """JSON.stringify({
            caption: document.querySelector('input[name="submission[caption]"]')?.value?.slice(0,90),
            target: document.querySelector('select[name="submission[target_id]"]')?.selectedOptions?.[0]?.textContent,
            vrt: document.querySelector('input[name="submission[original_vrt_id]"]')?.value,
            desc_len: document.querySelector('textarea[name="submission[description]"]')?.value?.length })"""))
        print("buttons:", await ev(ws, """JSON.stringify([...document.querySelectorAll('button,input[type=submit]')]
            .map(b => [(b.innerText||b.value||'').trim().slice(0,40), b.type, b.disabled]))"""))
        print("checkboxes:", await ev(ws, """JSON.stringify([...document.querySelectorAll('input[type=checkbox]')]
            .map(e => [e.name, e.id, e.checked]))"""))
        await ws.send(json.dumps({"id": 77, "method": "Page.captureScreenshot",
                                  "params": {"format": "png"}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("id") == 77:
                data = (m.get("result") or {}).get("data")
                break
        if data:
            open("/tmp/bc_form.png", "wb").write(base64.b64decode(data))
            print("shot: /tmp/bc_form.png")


asyncio.run(main())
