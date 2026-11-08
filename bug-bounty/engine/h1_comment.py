#!/usr/bin/env python3
"""Post a comment on a HackerOne report through the signed-in browser (CDP :9224).

  python3 engine/h1_comment.py <report_id> <body_file>

React's comment box needs a native-setter write plus a real trusted click (or Ctrl+Enter); a plain
element.click() leaves the composer unchanged. Verifies by reloading and looking for the body text.
"""
import sys
import json
import pathlib
import time

sys.path.insert(0, "engine")
import cdp_tab  # noqa: E402

REPORT, BODY = sys.argv[1], pathlib.Path(sys.argv[2]).read_text()
PROBE = next((ln.strip("# ").strip() for ln in BODY.splitlines() if len(ln.strip()) > 60), BODY[:60])


def fill(tab) -> int:
    return int(tab.ev("""(function(){const t=document.querySelector('textarea[id="comment[message]"]');
      if(!t) return -1;
      const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      set.call(t, %s); t.dispatchEvent(new Event('input',{bubbles:true}));
      t.focus(); return t.value.length;})()""" % json.dumps(BODY)) or -1)


def real_click(tab, label: str) -> str:
    tab.ev("""(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>new RegExp('^'+%s+'$','i').test(b.innerText.trim()));
      if(b) b.scrollIntoView({block:'center'});})()""" % json.dumps(label))
    time.sleep(1)
    box = tab.ev("""JSON.stringify((()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>new RegExp('^'+%s+'$','i').test(b.innerText.trim()));
      if(!b) return null; const r=b.getBoundingClientRect();
      return {x:r.x+r.width/2, y:r.y+r.height/2, dis:b.disabled};})())""" % json.dumps(label))
    if not box or box == "null":
        return "missing"
    d = json.loads(box)
    if d["dis"]:
        return "disabled"
    for typ in ("mouseMoved", "mousePressed", "mouseReleased"):
        tab.send("Input.dispatchMouseEvent", type=typ, x=d["x"], y=d["y"], button="left", clickCount=1)
        time.sleep(0.15)
    return "clicked"


def main() -> None:
    tab = cdp_tab.Tab("about:blank")
    try:
        tab.goto(f"https://hackerone.com/reports/{REPORT}", wait=1)
        time.sleep(10)
        print("filled:", fill(tab))
        time.sleep(1.5)
        print("click:", real_click(tab, "Post comment"))
        for _ in range(6):
            time.sleep(3)
            if BODY.split("\n\n")[0][:40] in (tab.ev("document.body.innerText") or ""):
                break
        tab.goto(f"https://hackerone.com/reports/{REPORT}", wait=1)
        time.sleep(8)
        txt = tab.ev("document.body.innerText") or ""
        print("verified:", PROBE[:50], "->", PROBE in txt)
        i = txt.find("rdwlabz")
        print("tail:", txt[-600:].replace("\n", " | ")[:600])
    finally:
        tab.close()


if __name__ == "__main__":
    main()
