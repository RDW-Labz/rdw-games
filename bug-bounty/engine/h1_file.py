#!/usr/bin/env python3
"""File the Starbucks SDTO report through the human's signed-in Brave session (CDP :9224).

The HackerOne create-report API cannot supply required custom fields, so this drives the real web
form: react-select dropdowns take keyboard selection (focus → ArrowDown opens → arrows → Enter), and
React-controlled inputs are written through the native value setter plus an `input` event.

  python3 engine/h1_file.py --fill      # fill and report state, do not submit
  python3 engine/h1_file.py --submit    # fill, verify, submit
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time

sys.path.insert(0, "engine")
import cdp_tab  # noqa: E402

SPEC = pathlib.Path("reports/drafts/starbucks-h1.json")
URL = "https://hackerone.com/starbucks/reports/new?type=team&report_type=vulnerability"

KEYS = {
    "down": ("ArrowDown", "ArrowDown", 40),
    "up": ("ArrowUp", "ArrowUp", 38),
    "enter": ("Enter", "Enter", 13),
    "esc": ("Escape", "Escape", 27),
    "tab": ("Tab", "Tab", 9),
}


def key(tab, name: str, n: int = 1) -> None:
    k, code, vk = KEYS[name]
    for _ in range(n):
        tab.send("Input.dispatchKeyEvent", type="keyDown", key=k, code=code,
                 windowsVirtualKeyCode=vk, nativeVirtualKeyCode=vk)
        tab.send("Input.dispatchKeyEvent", type="keyUp", key=k, code=code,
                 windowsVirtualKeyCode=vk, nativeVirtualKeyCode=vk)
        time.sleep(0.15)


def wait_for(tab, sel: str, tries: int = 20) -> bool:
    for _ in range(tries):
        time.sleep(1.5)
        if tab.ev(f"document.querySelectorAll({json.dumps(sel)}).length"):
            return True
    return False


def options(tab) -> list[str]:
    raw = tab.ev("JSON.stringify(Array.from(document.querySelectorAll('[class*=daisy-dropdown__option]'))"
                 ".map(e=>e.innerText.trim()))")
    return json.loads(raw) if raw else []


def highlighted(tab, input_id: str) -> str:
    return tab.ev(f"""(()=>{{const i=document.querySelector('#{input_id}');
      const id=i.getAttribute('aria-activedescendant');
      const e=id?document.getElementById(id):null; return e?e.innerText.trim():''}})()""") or ""


def click_text(tab, text: str, cls: str) -> str:
    js = f"""(function(){{
      const o = Array.from(document.querySelectorAll({json.dumps(cls)}))
        .find(e => e.innerText.replace(/\\s+/g,' ').includes({json.dumps(text)}));
      if (!o) return 'missing';
      o.dispatchEvent(new MouseEvent('mousedown', {{bubbles:true, cancelable:true}}));
      o.click();
      return 'clicked';
    }})()"""
    return str(tab.ev(js))


def open_select(tab, input_id: str) -> list[str]:
    tab.ev(f"document.querySelector('#{input_id}').focus()")
    key(tab, "down")
    time.sleep(1.5)
    return options(tab)


def choose_asset_type(tab, want: str) -> str:
    opts = open_select(tab, "react-select-2-input")
    if want not in opts:
        return f"NOT-FOUND {want} in {opts}"
    r = click_text(tab, want, "[class*=daisy-dropdown__option]")
    time.sleep(2.5)
    chosen = tab.ev("JSON.stringify(Array.from(document.querySelectorAll('[class*=daisy-dropdown__single-value]')).map(e=>e.innerText.trim()))")
    return f"{r} -> {chosen}"


def set_value(tab, selector: str, text: str) -> str:
    """Write a React-controlled input/textarea without losing the framework's state."""
    js = f"""(function(){{
      const sel = {json.dumps(selector)};
      const el = sel.startsWith('[id="') ? document.getElementById(sel.slice(5, -2)) : document.querySelector(sel);
      if (!el) return 'MISSING';
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, {json.dumps(text)});
      el.dispatchEvent(new Event('input', {{bubbles: true}}));
      el.dispatchEvent(new Event('change', {{bubbles: true}}));
      el.blur();
      return el.value.length;
    }})()"""
    return str(tab.ev(js))


def state(tab) -> dict:
    raw = tab.ev("""JSON.stringify({
      chosen: Array.from(document.querySelectorAll('[class*=daisy-dropdown__single-value]')).map(e=>e.innerText.trim()),
      title: (document.querySelector('#report_title')||{}).value,
      desc: (document.querySelector('#report_vulnerability_information')||{}).value?.length || 0,
      impact: (document.querySelector('#report_impact')||{}).value?.length || 0,
      cf: ['1076','1970','5267'].map(id => ((document.getElementById(id)||{}).value||'').length),
      severity: Array.from(document.querySelectorAll('input[type=radio]')).filter(r=>r.checked).map(r=>r.id||r.value),
      submit: Array.from(document.querySelectorAll('button')).filter(b=>/^Submit report/i.test(b.innerText.trim())).map(b=>b.disabled),
      url: location.href
    })""")
    return json.loads(raw) if raw else {}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--submit", action="store_true")
    args = ap.parse_args()
    spec = json.loads(SPEC.read_text())

    tab = cdp_tab.Tab("about:blank")
    try:
        tab.goto(URL, wait=1)
        if not wait_for(tab, "#report_title"):
            print("FORM NEVER LOADED")
            return
        print("form loaded")
        print(" asset type:", choose_asset_type(tab, "OtherAsset"))
        print(" asset     :", click_text(tab, "Subdomain Takeover (SDTO)", ".spec-asset-suggestion"))
        time.sleep(1.5)
        print(" selected  :", tab.ev("(()=>{const t=document.body.innerText;const i=t.indexOf('Currently selected');return t.slice(i,i+90).replace(/\\n/g,' | ')})()"))
        wopts = open_select(tab, "react-select-3-input")
        print(" weakness  :", f"{len(wopts)} options",
              click_text(tab, "Access Control", "[class*=daisy-dropdown__option]"))
        time.sleep(1.5)
        print(" sev ctrl  :", tab.ev("""JSON.stringify(Array.from(document.querySelectorAll('input[type=radio]')).map(r=>[r.id||r.name||r.value,(r.closest('label')?.innerText||'').replace(/\\n/g,' ').slice(0,40),r.checked]))""")[:300])
        print(" state after selects:", json.dumps(state(tab))[:300])
        print(" title:", set_value(tab, "#report_title", spec["title"]))
        print(" desc :", set_value(tab, "#report_vulnerability_information", spec["vulnerability_information"]))
        print(" impact:", set_value(tab, "#report_impact", spec["impact"]))
        print(" cf1076 (IP):", set_value(tab, '[id="1076"]', "153.66.73.182"))
        print(" cf5267 (codeword):", set_value(tab, '[id="5267"]', "coffee"))
        st = state(tab)
        print(" PRE-SUBMIT STATE:", json.dumps(st)[:600])
        if not args.submit:
            print("(fill only — no submit)")
            return
        if not (st.get("title") and st.get("desc") and st.get("impact") and st["cf"][0] and st["cf"][2]):
            print("REFUSING TO SUBMIT: a required field is empty")
            return
        clicked = tab.ev("""(()=>{const b=Array.from(document.querySelectorAll('button'))
            .find(b=>/^Submit report$/i.test(b.innerText.trim()) && !b.disabled);
            if(!b) return 'NO-BUTTON'; b.click(); return 'clicked'})()""")
        print(" submit:", clicked)
        # a confirmation dialog usually follows the first click
        time.sleep(3)
        modal = tab.ev("""JSON.stringify(Array.from(document.querySelectorAll('[role=dialog], [class*=modal]'))
            .map(d=>d.innerText.trim().slice(0,200)).filter(Boolean).slice(0,3))""")
        print(" dialog:", str(modal)[:400])
        if modal and modal != "[]":
            again = tab.ev("""(()=>{const btns=Array.from(document.querySelectorAll('[role=dialog] button, [class*=modal] button'))
                .filter(b=>!b.disabled && /submit|confirm|yes|ok/i.test(b.innerText));
                if(!btns.length) return 'NO-CONFIRM';
                btns[0].click(); return 'confirmed:'+btns[0].innerText.trim().slice(0,30)})()""")
            print(" confirm:", again)
        for i in range(15):
            time.sleep(2)
            u = tab.ev("location.href")
            if "/reports/" in u and "reports/new" not in u:
                print(" FILED ->", u)
                break
            err = tab.ev("JSON.stringify(Array.from(document.querySelectorAll('[class*=error],[role=alert]')).map(e=>e.innerText.trim().slice(0,120)).filter(Boolean).slice(0,4))")
            if err and err != "[]":
                print(i, "errors:", err[:300])
        print(" final url:", tab.ev("location.href"))
        print(" final state:", json.dumps(state(tab))[:400])
        print(" body tail:", repr(tab.ev("document.body.innerText.slice(0,400)")))
    finally:
        tab.close()


if __name__ == "__main__":
    main()
