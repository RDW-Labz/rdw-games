#!/usr/bin/env python3
"""File a written report through the owner's signed-in browser, using the skill's proven selector chain.

The API route died on custom fields — programmes with required fields reject every payload shape — so
the only reliable path is the web form. The skill ships `templates/h1_web_form_fill.py`, which is the
actual sequence that filed a report: ArrowDown opens the pickers, options are selected by visible text
because `aria-activedescendant` lies, and React inputs need the native value setter. This is that
sequence, plus three things a repo needs:

  * port discovery — the owner's profile browser is Brave on 9234; the daemon's Chromium sits on
    9222/9223, where nobody is signed in and every run dies at the login wall;
  * a login precheck that says "not signed in" instead of filling nothing and reporting success;
  * `--from-report`, which builds the spec out of the report markdown we already wrote, so the text that
    gets filed is the text that was reviewed and committed.

Dry run is the default and it prints what it would fill. `--submit` files once, and refuses if a login
wall, a missing asset card, or a modal stands in the way.

Usage:
  ./h1_fill.py --from-report reports/h1-Playtika-dangling-cname.md --team playtika --dry
  ./h1_fill.py --spec reports/specs/playtika.json --submit
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parent.parent
# 9226 first: the bounty lane's own signed-in browser on the bounty bot screen. The rest are historical —
# 9224/9234 are Michael's Brave (his session, his cursor) and 9222/9223 are agent daemons with no logins.
PORTS = (9226, 9224, 9234, 9222, 9223)


def devtools_port() -> int:
    for p in PORTS:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{p}/json/version", timeout=3) as r:
                if b"Browser" in r.read():
                    return p
        except Exception:
            continue
    raise SystemExit(f"no DevTools endpoint on {PORTS} — start the owner's browser with --remote-debugging-port")


class Tab:
    def __init__(self, port: int, url: str = "about:blank"):
        self.base = f"http://127.0.0.1:{port}"
        # Chrome 111+ refuses GET /json/new (405); the tab endpoint is PUT-only now.
        req = urllib.request.Request(self.base + "/json/new?" + urllib.parse.quote(url, safe=""), method="PUT")
        with urllib.request.urlopen(req, timeout=20) as r:
            t = json.loads(r.read().decode())
        self.ws = connect(t["webSocketDebuggerUrl"], max_size=None, open_timeout=20, legacy=True)
        self.i = 0

    def send(self, method: str, **params):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.i:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def ev(self, expr: str):
        r = self.send("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        return r.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def key(tab: Tab, name: str) -> None:
    code, vk = {"down": ("ArrowDown", 40), "up": ("ArrowUp", 38), "enter": ("Enter", 13)}[name]
    for kind in ("keyDown", "keyUp"):
        tab.send("Input.dispatchKeyEvent", type=kind, key=code, code=code,
                 windowsVirtualKeyCode=vk, nativeVirtualKeyCode=vk)
        time.sleep(0.2)


def click_text(tab: Tab, text: str, selector: str) -> str:
    return str(tab.ev(f"""(function(){{
      const o = Array.from(document.querySelectorAll({json.dumps(selector)}))
        .find(e => e.innerText.replace(/\\s+/g,' ').includes({json.dumps(text)}));
      if (!o) return 'missing';
      o.dispatchEvent(new MouseEvent('mousedown', {{bubbles:true, cancelable:true}}));
      o.click();
      return 'clicked';
    }})()"""))


def set_value(tab: Tab, selector: str, value: str) -> int:
    return int(tab.ev(f"""(function(){{
      const sel = {json.dumps(selector)};
      const el = sel.startsWith('[id="') ? document.getElementById(sel.slice(5, -2)) : document.querySelector(sel);
      if (!el) return -1;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, {json.dumps(value)});
      el.dispatchEvent(new Event('input', {{bubbles:true}}));
      el.dispatchEvent(new Event('change', {{bubbles:true}}));
      return el.value.length;
    }})()""") or -1)


def section(md: str, start: str, stops: tuple[str, ...]) -> str:
    i = md.index(start) + len(start)
    tail = md[i:]
    cut = min([tail.index(s) for s in stops if s in tail] or [len(tail)])
    return tail[:cut].strip()


def spec_from_report(path: Path, team: str, asset_type: str = "OtherAsset",
                     asset_hint: str = "Subdomain Takeover (SDTO)",
                     weakness: str = "Access Control") -> dict:
    md = path.read_text()
    title = md.splitlines()[0].lstrip("# ").strip()
    body = section(md, "## Summary", ("## Impact",))
    impact = section(md, "## Impact", ("## Remediation",))
    # The form has no room for the evidence appendix, but a takeover report without the DNS/CNAME proof
    # is the thing that gets closed informative. Fold the evidence into the description.
    evidence = section(md, "## Evidence", ("## Steps to reproduce",))
    return {
        "team_handle": team,
        "title": title,
        "asset_type": asset_type,
        "asset_hint": asset_hint,
        "weakness": weakness,
        "vulnerability_information": f"{body}\n\n## Evidence\n\n{evidence}",
        "impact": impact,
        "source_report": str(path.resolve().relative_to(ROOT) if path.is_absolute() else path),
    }


def in_scope(host: str, ident: str) -> bool:
    """A wildcard scope is written `*.playticorp.com`, so `host in ident` is backwards and always false —
    the check that matters is whether the host sits *under* the wildcard, or matches it exactly."""
    if not ident:
        return False
    if ident == host:
        return True
    return ident.startswith("*.") and host.endswith(ident[1:])


def api_spec(report: Path, team: str, host: str, severity: str = "medium",
             weakness: str = "Access Control", need_bounty: bool = True) -> Path:
    """Same report, API shape. The web form and the API want different field names, and the API needs two
    live ids that must never be guessed: the structured scope the host sits in, and the weakness leaf.
    Both are resolved here from the programme itself, so a filing can never cite a stale id."""
    sys.path.insert(0, str(ROOT / "engine"))
    import h1_api

    # Paginated + eligibility-aware: `page[size]=100` truncates twilio (112 assets), marriott (99) and
    # epicgames (188), and an asset listed but not eligible for submission must not be cited.
    import h1_scope
    # A draft can exist for a record whose CNAME names the provider zone itself
    # (`login-mediaspace.unrealengine.com CNAME azurewebsites.net`). There is no app name in that record,
    # so no third party can claim anything and the report would be a false positive — refuse to spec it.
    import h1_autofile
    cname = __import__("subprocess").run(["dig", "+short", "+time=3", host, "CNAME"],
                                         capture_output=True, text=True, timeout=20).stdout.strip().rstrip(".")
    if cname and h1_autofile.is_provider_apex(cname):
        raise SystemExit(f"{host} CNAMEs to the provider zone itself ({cname}) — no name to claim, "
                         f"not fileable")
    # `need_bounty=False` files a report against an asset that accepts submissions but pays nothing. That is
    # a real report on a real asset — a programme's VDP side — and refusing it made every free-to-file host
    # look unfilable. The flag is explicit so nothing starts hitting non-paying assets by accident.
    live = h1_scope.match(team, host, need_bounty=need_bounty)
    if not live:
        raise SystemExit(f"no live eligible scope on {team} contains {host} — do not file")
    s = {"id": live["id"], "attributes": {
        "asset_identifier": live["asset"], "eligible_for_bounty": live["bounty"],
        "eligible_for_submission": live["submission"], "max_severity": live["max_severity"]}}
    code, p = h1_api.call("GET", f"/hackers/programs/{team}/weaknesses?page[size]=100")
    wrows: list[dict] = list(p.get("data") or []) if isinstance(p, dict) else []
    weak = [r for r in wrows
            if "access control" in (r.get("attributes", {}).get("name") or "").lower()][:1]
    md = report.read_text()
    spec = {
        "team_handle": team,
        "structured_scope_id": s["id"],
        "weakness_id": weak[0]["id"] if weak else None,
        "severity_rating": severity,
        "report_type": "vulnerability",
        "title": md.splitlines()[0].lstrip("# ").strip(),
        "vulnerability_information": f"{section(md, '## Summary', ('## Impact',))}\n\n## Evidence\n\n"
                                    f"{section(md, '## Evidence', ('## Steps to reproduce',))}",
        "impact": section(md, "## Impact", ("## Remediation",)),
    }
    out = ROOT / "reports" / "specs" / f"{team}-api.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(spec, indent=2) + "\n")
    print(f"api spec -> {out.relative_to(ROOT)}")
    attrs: dict = s.get("attributes") or {}
    print(f"  scope {s['id']} {attrs.get('asset_identifier')} "
          f"(eligible={attrs.get('eligible_for_bounty')})")
    print(f"  weakness {spec['weakness_id']} · severity {severity}")
    return out


def main() -> int:
    a = sys.argv[1:]
    submit = "--submit" in a
    if "--api-spec" in a:
        host = a[a.index("--host") + 1] if "--host" in a else ""
        sev = a[a.index("--severity") + 1] if "--severity" in a else "medium"
        if not host:
            raise SystemExit("--host <hostname> is required so the scope can be matched live")
        api_spec(Path(a[a.index("--api-spec") + 1]), a[a.index("--team") + 1], host, sev)
        return 0
    if "--from-report" in a:
        rep = Path(a[a.index("--from-report") + 1])
        team = a[a.index("--team") + 1] if "--team" in a else ""
        if not team:
            raise SystemExit("--team <handle> is required")
        spec = spec_from_report(rep, team)
        out = ROOT / "reports" / "specs" / f"{team}-{rep.stem.split('-', 2)[-1]}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(spec, indent=2) + "\n")
        print(f"spec -> {out.relative_to(ROOT)}  ({len(spec['vulnerability_information'])} chars description)")
    elif "--spec" in a:
        spec = json.loads(Path(a[a.index("--spec") + 1]).read_text())
    else:
        print(__doc__)
        return 2

    port = devtools_port()
    url = f"https://hackerone.com/{spec['team_handle']}/reports/new?type=team&report_type=vulnerability"
    tab = Tab(port, "about:blank")
    try:
        tab.ev(f"location.href = {json.dumps(url)}")
        mounted = False
        for _ in range(12):
            time.sleep(2)
            here = tab.ev("location.href") or ""
            if re.search(r"sign_in|login|cloudflare|challenge", here):
                print(f"NOT SIGNED IN on port {port}: {here}")
                print("  -> sign in to HackerOne in this browser, then re-run. Nothing was filled.")
                return 1
            if tab.ev("document.querySelectorAll('#report_title').length"):
                mounted = True
                break
        if not mounted:
            print(f"form never mounted on port {port}: {tab.ev('location.href')}")
            return 1

        if spec.get("asset_type"):
            tab.ev("document.querySelector('#react-select-2-input').focus()")
            key(tab, "down")
            time.sleep(1.5)
            off = tab.ev("JSON.stringify(Array.from(document.querySelectorAll('[class*=daisy-dropdown__option]'))"
                         ".map(e=>e.innerText.trim()))") or "[]"
            if spec["asset_type"] not in json.loads(off):
                print("asset type not offered:", json.loads(off)[:12])
                return 1
            print("type  :", click_text(tab, spec["asset_type"], "[class*=daisy-dropdown__option]"))
            time.sleep(2.5)
            if spec.get("asset_hint"):
                print("asset :", click_text(tab, spec["asset_hint"], ".spec-asset-suggestion"))
                time.sleep(1.5)
        if spec.get("weakness"):
            tab.ev("document.querySelector('#react-select-3-input').focus()")
            key(tab, "down")
            time.sleep(1.5)
            print("weak  :", click_text(tab, spec["weakness"], "[class*=daisy-dropdown__option]"))
            time.sleep(1.5)

        for field, value in (("#report_title", spec["title"]),
                             ("#report_vulnerability_information", spec["vulnerability_information"]),
                             ("#report_impact", spec["impact"])):
            print(f"{field:<38} {set_value(tab, field, value)} chars")

        st = json.loads(tab.ev("JSON.stringify({url: location.href, "
                               "chosen: Array.from(document.querySelectorAll('[class*=daisy-dropdown__single-value]'))"
                               ".map(e=>e.innerText.trim()), "
                               "selected: (document.body.innerText.match(/Currently selected[\\s\\S]{0,60}/)||[''])[0]})"))
        print(json.dumps(st, indent=1))
        if not submit:
            print("dry run — left open for you to read:", st.get("url"))
            return 0
        if spec.get("asset_hint") and not st.get("selected"):
            print("asset card not confirmed selected — not submitting")
            return 1
        tab.ev("(()=>{const b=Array.from(document.querySelectorAll('button'))"
               ".find(x=>/^submit/i.test(x.innerText.trim())&&!x.disabled); if(b) b.click(); return !!b})()")
        time.sleep(3)
        for _ in range(15):
            time.sleep(2)
            u = tab.ev("location.href") or ""
            if "/reports/" in u and "reports/new" not in u:
                print("FILED ->", u)
                return 0
        print("still on the form:", tab.ev("location.href"))
        return 1
    finally:
        tab.close()


if __name__ == "__main__":
    raise SystemExit(main())
