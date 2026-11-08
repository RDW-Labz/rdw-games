"""Fire every staged Bugcrowd draft, and say plainly which ones the platform refused and why.

Each draft is opened in its own tab, its control set is read, and the submit control is clicked only if one
actually exists. Since 2026-11 the three staged repos each replace the submit button with
"Verify your identity to submit this repo" and leave "Save draft" disabled, so a refusal is the expected
result on an unverified account — the point of this script is that the refusal is recorded per draft with the
servers own wording, never inferred from a missing button.

Writes reports/out/firing.json. Exit code 0 when at least one draft left the account, 3 when every draft was
refused (so a cron lane can tell "nothing to do" from "blocked").
"""
import asyncio
import base64
import json
import time
from pathlib import Path

PORT = 9226
ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "reports" / "out" / "drafts.json"
LEDGER = ROOT / "reports" / "out" / "firing.json"

GATE = """(() => {
  const txt = document.body.innerText;
  const submit = [...document.querySelectorAll('button,a[role=button]')]
    .find(e => /^submit( report)?$/i.test((e.innerText || '').trim().replace(/\\s+/g, ' ')));
  const gate = [...document.querySelectorAll('a,button')]
    .map(e => (e.innerText || '').trim())
    .find(t => /verify your identity/i.test(t));
  return JSON.stringify({
    has_submit: !!submit,
    submit_disabled: submit ? !!submit.disabled : null,
    gate: gate || null,
    save_disabled: !!document.querySelector('button.bc-btn--disabled'),
    text: txt.replace(/\\s+/g, ' ').slice(0, 160)
  });
})()"""

CLICK = """(() => {
  const b = [...document.querySelectorAll('button,a[role=button]')]
    .find(e => /^submit( report)?$/i.test((e.innerText || '').trim().replace(/\\s+/g, ' ')));
  if (!b) return 'no submit control';
  if (b.disabled) return 'submit disabled';
  b.scrollIntoView({block: 'center'}); b.click(); return 'clicked';
})()"""


async def ev(ws, expr, mid=1):
    await ws.send(json.dumps({"id": mid, "method": "Runtime.evaluate",
                              "params": {"expression": expr, "returnByValue": True}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == mid:
            return (m.get("result") or {}).get("result", {}).get("value")


async def fire(websockets, urllib_parse, urllib_req, row):
    url = (f"https://bugcrowd.com/engagements/{row['engagement']}"
           f"/submissions/{row['draft_id']}/edit")
    req = urllib_req.Request(f"http://127.0.0.1:{PORT}/json/new?{urllib_parse.quote(url, safe='')}", method="PUT")
    ws_url = json.load(urllib_req.urlopen(req))["webSocketDebuggerUrl"]
    await asyncio.sleep(10)
    out = {"engagement": row["engagement"], "draft_id": row["draft_id"], "target": row["target"]}
    async with websockets.connect(ws_url, max_size=2 ** 23) as ws:
        state = json.loads(await ev(ws, GATE) or "{}")
        out["page"] = state
        if not state.get("has_submit") or state.get("submit_disabled"):
            out["result"] = "refused_before_click"
            out["reason"] = state.get("gate") or "no submit control on the draft"
            return out
        out["click"] = await ev(ws, CLICK)
        await asyncio.sleep(10)
        after = await ev(ws, "JSON.stringify({url: location.pathname, text: document.body.innerText"
                             ".replace(/\\s+/g,' ').slice(0,300)})")
        out["after"] = json.loads(after or "{}")
        out["result"] = "submitted" if "/submissions/" not in out["after"].get("url", "/edit") else "still_draft"
        await ws.send(json.dumps({"id": 91, "method": "Page.captureScreenshot", "params": {"format": "png"}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("id") == 91:
                data = (m.get("result") or {}).get("data")
                if data:
                    p = ROOT / "evidence-takeover" / "shots" / f"fire_{row['engagement']}.png"
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_bytes(base64.b64decode(data))
                    out["shot"] = str(p)
                break
    return out


async def main():
    import urllib.parse
    import urllib.request

    import websockets
    rows = json.loads(MANIFEST.read_text())
    results = []
    for row in rows:
        try:
            results.append(await fire(websockets, urllib.parse, urllib.request, row))
        except Exception as exc:
            results.append({"engagement": row["engagement"], "draft_id": row["draft_id"],
                            "result": "error", "reason": f"{type(exc).__name__}: {exc}"[:200]})
        print(json.dumps(results[-1])[:400])
    LEDGER.write_text(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "results": results}, indent=1))
    sent = [r for r in results if r.get("result") == "submitted"]
    print(f"\n{len(sent)}/{len(results)} left the account; ledger {LEDGER}")
    return 0 if sent else 3


raise SystemExit(asyncio.run(main()))
