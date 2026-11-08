#!/usr/bin/env python3
"""Fill HackerOne's report form through CDP, on the browser the owner is already signed into.

HackerOne's submission page is a React app: setting `input.value` does nothing because React never sees
the change, and the severity/weakness pickers are react-select comboboxes rather than <select> elements.
So every write goes through the native value setter plus `input`/`change` events, and combobox choices are
made by typing into the box and clicking the rendered option.

    ./engine/h1.py dump                 # every field, its label, and the current value
    ./engine/h1.py fill <spec.json>     # title / description / impact / severity / weakness / asset
    ./engine/h1.py submit [--dry-run]   # click the submit button; --dry-run only checks readiness

Nothing here prints or stores credentials — it drives an already-authenticated session.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.request

import websockets

PORT = int(os.environ.get("CDP_PORT", "9226"))
MATCH = os.environ.get("H1_TAB", "reports/new")

JS_HELPERS = r"""
window.__h1 = {
  set(el, v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  label(el) {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const lb = el.labels && el.labels[0];
    if (lb) return lb.innerText.trim();
    const wrapper = el.closest('label, [data-testid], fieldset');
    return wrapper ? wrapper.innerText.trim().slice(0, 120) : '';
  },
};
"""

DUMP_JS = r"""
(() => {
  const rows = [];
  for (const el of document.querySelectorAll('input, textarea, [role=combobox]')) {
    if (el.type === 'hidden' || el.type === 'file') continue;
    rows.push({
      tag: el.tagName.toLowerCase(),
      type: el.type || el.getAttribute('role'),
      id: el.id || null,
      name: el.name || null,
      label: window.__h1.label(el),
      value: (el.value || '').slice(0, 60),
      checked: el.type === 'radio' || el.type === 'checkbox' ? el.checked : null,
    });
  }
  const buttons = [...document.querySelectorAll('button')]
    .map(b => ({ text: (b.innerText || '').trim().slice(0, 40), disabled: b.disabled }))
    .filter(b => b.text);
  return JSON.stringify({ url: location.href, fields: rows, buttons }, null, 1);
})()
"""


def tab() -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as r:
        for t in json.loads(r.read()):
            if t.get("type") == "page" and MATCH in t.get("url", ""):
                return t
    raise SystemExit(f"no tab with {MATCH!r} in its URL — open the report form first")


async def call(expr: str, wait: float = 0.0) -> str:
    t = tab()
    async with websockets.connect(t["webSocketDebuggerUrl"], max_size=20_000_000) as ws:
        async def send(i: int, method: str, params: dict | None = None) -> dict:
            await ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == i:
                    return m

        await send(1, "Runtime.enable")
        await send(2, "Runtime.evaluate", {"expression": JS_HELPERS})
        if wait:
            await asyncio.sleep(wait)
        r = await send(9, "Runtime.evaluate",
                       {"expression": expr, "returnByValue": True, "awaitPromise": True})
        res = r.get("result", {})
        if "exceptionDetails" in res:
            return "JS ERROR: " + json.dumps(res["exceptionDetails"].get("exception", {}))[:600]
        return res.get("result", {}).get("value")


SET_FIELD = r"""
(() => { const el = document.querySelector(%s); if (!el) return 'missing ' + %s;
  window.__h1.set(el, %s); return 'ok'; })()
"""

PICK_OPTION = r"""
(async () => {
  const box = document.querySelector(%s);
  if (!box) return 'missing combobox';
  box.focus(); box.click();
  await new Promise(r => setTimeout(r, 250));
  window.__h1.set(box, %s);
  box.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
  await new Promise(r => setTimeout(r, 900));
  const want = %s.toLowerCase();
  const opts = [...document.querySelectorAll('[role=option], .css-*-option, li[id*=option]')];
  const hit = opts.find(o => (o.innerText || '').toLowerCase().includes(want));
  if (!hit) return 'no option matching ' + want + ' among ' + opts.length;
  hit.click();
  return 'picked: ' + hit.innerText.trim().slice(0, 60);
})()
"""



async def real_click(sel_expr: str, key_after: str | None = None) -> str:
    """Click at the element's real coordinates (Input.dispatchMouseEvent).

    react-select and other custom widgets ignore synthetic .click() — they listen for mousedown on the
    rendered control — so anything that opens a menu has to be clicked like a human would.
    """
    t = tab()
    async with websockets.connect(t["webSocketDebuggerUrl"], max_size=20_000_000) as ws:
        async def send(i: int, method: str, params: dict | None = None) -> dict:
            await ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == i:
                    return m

        await send(1, "Runtime.enable")
        r = await send(2, "Runtime.evaluate", {"returnByValue": True, "expression": f"""
            (() => {{ const el = {sel_expr}; if (!el) return null;
              el.scrollIntoView({{block: 'center'}});
              const b = el.getBoundingClientRect();
              return JSON.stringify({{x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height}}); }})()"""})
        box = r.get("result", {}).get("result", {}).get("value")
        if not box:
            return "missing"
        c = json.loads(box)
        for kind in ("mousePressed", "mouseReleased"):
            await send(3, "Input.dispatchMouseEvent",
                       {"type": kind, "x": c["x"], "y": c["y"], "button": "left", "clickCount": 1})
        if key_after:
            for k in key_after.split("+"):
                await send(4, "Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": k, "code": k})
                await send(4, "Input.dispatchKeyEvent", {"type": "keyUp", "key": k, "code": k})
        return f"clicked at {c['x']:.0f},{c['y']:.0f}"


def j(v) -> str:
    return json.dumps(v)


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "dump"
    if cmd == "dump":
        print(asyncio.run(call(DUMP_JS)))
        return
    if cmd == "fill":
        spec = json.load(open(sys.argv[2]))
        for sel, val in (spec.get("text") or {}).items():
            print(sel, "->", asyncio.run(call(SET_FIELD % (j(sel), j(sel), j(val)))))
        for sel, val in (spec.get("pick") or {}).items():
            print(sel, "=>", asyncio.run(call(PICK_OPTION % (j(sel), j(val), j(val)), wait=1.0)))
        print("asset:", asyncio.run(call(PICK_OPTION % (j(spec["asset_selector"]), j(spec["asset_value"]), j(spec["asset_value"])), wait=1.0))
              if spec.get("asset_selector") else "skipped")
        return
    if cmd == "click":
        want = sys.argv[2]
        js = r"""
        (() => {
          const t = %s;
          const els = [...document.querySelectorAll('button, a, [role=option], [role=button]')];
          const hit = els.find(e => (e.innerText || '').trim() === t) || els.find(e => (e.innerText || '').includes(t));
          if (!hit) return 'no element with text ' + t;
          hit.scrollIntoView({block: 'center'});
          hit.click();
          return 'clicked: ' + (hit.innerText || '').trim().slice(0, 50);
        })()
        """ % j(want)
        print(asyncio.run(call(js)))
        return
    if cmd == "set":
        sel, path = sys.argv[2], sys.argv[3]
        val = open(path).read() if os.path.exists(path) else path
        print(asyncio.run(call(SET_FIELD % (j(sel), j(sel), j(val)))))
        return
    if cmd == "type":
        # type into a box to open a react-select menu, without choosing anything yet
        sel, val = sys.argv[2], sys.argv[3]
        js = r"""
        (async () => {
          const el = document.querySelector(%s);
          if (!el) return 'missing';
          el.scrollIntoView({block: 'center'}); el.focus(); el.click();
          await new Promise(r => setTimeout(r, 250));
          window.__h1.set(el, %s);
          return 'typed: ' + el.value;
        })()
        """ % (j(sel), j(val))
        print(asyncio.run(call(js)))
        return
    if cmd == "rclick":
        # rclick <selector-js> [keys]   e.g. rclick "document.querySelector('#react-select-3-input')" ArrowDown+Enter
        print(asyncio.run(real_click(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)))
        return
    if cmd == "jclick":
        # jclick <selector-js> — dispatch mousedown/mouseup/click. react-select v5 opens on mousedown only.
        js = r"""
        (() => {
          const el = %s;
          if (!el) return 'missing';
          el.scrollIntoView({block: 'center'});
          const o = {bubbles: true, cancelable: true, view: window, button: 0};
          el.dispatchEvent(new MouseEvent('mousedown', o));
          el.dispatchEvent(new MouseEvent('mouseup', o));
          el.dispatchEvent(new MouseEvent('click', o));
          return 'jclicked';
        })()
        """ % sys.argv[2]
        print(asyncio.run(call(js)))
        return
    if cmd == "rtext":
        # rtext <selector-js> <text> — real click, then Input.insertText (what a human typing looks like)
        sel, val = sys.argv[2], sys.argv[3]
        print(asyncio.run(real_click(sel)))
        print(asyncio.run(call(r"""
        (() => { const el = %s; if (!el) return 'missing'; el.focus(); return 'focused'; })()
        """ % sel)))
        t = tab()
        async def _insert():
            async with websockets.connect(t["webSocketDebuggerUrl"], max_size=20_000_000) as ws:
                await ws.send(json.dumps({"id": 1, "method": "Input.insertText", "params": {"text": val}}))
                return json.loads(await ws.recv()).get("id")
        print("inserted:", asyncio.run(_insert()))
        return
    if cmd == "opts":
        print(asyncio.run(call("JSON.stringify([...document.querySelectorAll('[role=option]')].map(o=>o.innerText.trim().slice(0,60)))")))
        return
    if cmd == "submit":
        dry = "--dry-run" in sys.argv
        js = r"""
        (() => {
          const b = [...document.querySelectorAll('button')].find(x => /^submit( report)?$/i.test((x.innerText||'').trim()));
          if (!b) return 'no submit button';
          if (b.disabled) return 'submit disabled';
          if (%s) return 'ready (dry run)';
          b.click(); return 'clicked submit';
        })()
        """ % ("true" if dry else "false")
        print(asyncio.run(call(js)))
        return
    raise SystemExit("commands: dump | fill <spec.json> | submit [--dry-run]")


if __name__ == "__main__":
    main()
