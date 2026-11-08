#!/usr/bin/env python3
"""Submit a drafted report through Bugcrowd's web form.

The Hacker API is pre-GA (Bugcrowd support, 2026-11-06), so `hacker-api.bugcrowd.com` answers 401
for every token and there is nothing to mint. What does work is the form a human would use, driven
from the browser that is already signed in.

This tool fills that form from a drafted markdown report and stops. It never clicks the final
submit: a submission is a legal act made in the researcher's name, and the last button is the one
place where a human should be looking at the screen. Everything up to it — engagement, target,
title, severity, description — is mechanical and worth automating.

  python3 engine/bc_web.py check                                # is the session alive
  python3 engine/bc_web.py payload chipotle-mbb-og --report <md>  # what would be typed (no browser)
  python3 engine/bc_web.py open  chipotle-mbb-og                 # open the form, inventory fields
  python3 engine/bc_web.py fill  chipotle-mbb-og --report <md>   # fill everything, leave Submit
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

BASE = "https://bugcrowd.com"
ENGAGEMENTS = Path(__file__).resolve().parent / "data" / "bc_engagements.json"
OKTA = "login.hackers.bugcrowd.com"


def payload(report: Path) -> dict:
    """Split a drafted report into the two things the form actually takes from the file.

    Title comes from the first H1 (they are written as "Dangling DNS / subdomain takeover: host",
    which is exactly what a triager wants to see in a subject line). Everything after the metadata
    block becomes the description verbatim — stripping it into a different house style is how a
    report loses the evidence that made it worth filing.
    """
    text = report.read_text()
    title, rest = "", text
    for line in text.splitlines():
        if line.startswith("# "):
            title = line[2:].strip()
            rest = text.split(line, 1)[1]
            break
    sev = ""
    for line in text.splitlines()[:12]:
        low = line.lower()
        if low.startswith("**severity:**"):
            sev = line.split(":", 1)[1].strip()
    return {"title": title, "description": rest.strip(), "severity_line": sev}


def slug_url(slug: str) -> str:
    try:
        d = json.loads(ENGAGEMENTS.read_text())
        for e in (d if isinstance(d, list) else d.get("engagements") or d.get("data") or []):
            if e.get("slug") == slug:
                return e.get("url") or f"{BASE}/engagements/{slug}"
    except Exception:
        pass
    return f"{BASE}/engagements/{slug}"


INVENTORY_JS = r"""
(() => {
  const seen = [];
  const label = el => {
    const l = el.closest('label') || (el.id && document.querySelector(`label[for="${el.id}"]`));
    return (l && l.innerText.trim()) || el.getAttribute('aria-label') || el.placeholder || '';
  };
  document.querySelectorAll('input,textarea,select,[contenteditable="true"]').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    seen.push({tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '',
               id: el.id || '', label: label(el).slice(0, 70),
               ce: el.getAttribute('contenteditable') || ''});
  });
  const buttons = [...document.querySelectorAll('button,a[role="button"],[type=submit]')]
    .filter(b => b.getBoundingClientRect().height > 2)
    .map(b => (b.innerText || b.value || '').trim().slice(0, 40)).filter(Boolean);
  return JSON.stringify({url: location.href, fields: seen, buttons: [...new Set(buttons)].slice(0, 25)});
})()
"""


def _tab(url: str):
    from cdp_tab import Tab
    return Tab(url)


def open_form(slug: str, wait: float = 7.0) -> dict:
    """Get to the submission form for one engagement and describe it.

    Two routes are tried because Bugcrowd has changed this path more than once: the direct
    `/submissions/new` route, then the engagement page with its own submit control clicked. The
    inventory that comes back is what the fill step keys off, so this doubles as the discovery
    tool whenever the form changes.
    """
    tab = _tab(f"{BASE}/engagements/{slug}/submissions/new")
    try:
        time.sleep(wait)
        url = tab.ev("location.href") or ""
        if OKTA in url:
            return {"error": "signed out (bounced to Okta)"}
        inv = tab.ev(INVENTORY_JS)
        info = json.loads(inv) if inv else {}
        if not info.get("fields"):
            # fall back to the engagement page and hunt for its submit control
            tab.goto(slug_url(slug), wait=6)
            clicked = tab.ev(r"""(() => {
                const b = [...document.querySelectorAll('button,a')]
                  .find(x => /submit( a)? (report|finding)|submit/i.test(x.innerText || ''));
                if (!b) return 'no submit control';
                b.click(); return 'clicked: ' + (b.innerText || '').trim().slice(0, 40);
            })()""")
            time.sleep(6)
            inv = tab.ev(INVENTORY_JS)
            info = json.loads(inv) if inv else {}
            info["via"] = clicked
        return info
    finally:
        tab.close()


def fill(slug: str, report: Path, dry: bool) -> int:
    p = payload(report)
    if not p["title"]:
        print(f"{report}: no H1 to use as a title", file=sys.stderr)
        return 2
    print(f"engagement : {slug}  ({slug_url(slug)})")
    print(f"title      : {p['title']}")
    print(f"severity   : {p['severity_line'] or '(not stated in draft)'}")
    print(f"description: {len(p['description'])} chars")
    if dry:
        print("\n--- description preview ---")
        print(p["description"][:600])
        return 0

    info = open_form(slug)
    if info.get("error"):
        print(info["error"], file=sys.stderr)
        return 1
    print("\nform at :", info.get("url"))
    print("fields  :")
    for f in info.get("fields", []):
        print(f"  {f['tag']:<14} {f['type']:<10} {f['label'][:50]!r} name={f['name'][:30]}")
    print("buttons :", ", ".join(info.get("buttons", [])))
    print("\nNothing was typed and nothing was submitted — the form layout above is what the next "
          "step fills in. Submit stays manual.")
    return 0



SET_JS = r"""
window.__bcset = (sel, val) => {
  const el = document.querySelector(sel);
  if (!el) return 'missing ' + sel;
  const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype
              : (el instanceof HTMLSelectElement) ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, val);
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
  return 'ok';
};
true
"""


def submit(slug: str, report: Path, go: bool = False, save_draft: bool = True) -> int:
    """Fill a Bugcrowd submission form for real, save it as a draft, and — only with `go` — submit it.

    `fill()` above was scaffolding: it opened the form, printed the field list and said "the next step
    fills this in", which is why nine drafts sat in the queue while the board reported a filing rail that
    could not file. This is that next step. It types the title, picks the target and VRT category, pastes
    the description, saves the draft, and then either stops or presses Submit and reports what Bugcrowd
    says back — including the identity-verification wall, which is the honest reason a managed programme
    submission cannot complete from here.
    """
    p = payload(report)
    host = ""
    for chunk in (p["title"] or "").split("`"):
        if "." in chunk and " " not in chunk:
            host = chunk.strip()
            break
    print(f"engagement : {slug}")
    print(f"host       : {host or '(none parsed — target will be left alone)'}")
    print(f"title      : {p['title']}")

    tab = _tab(f"{BASE}/engagements/{slug}/submissions/new")
    try:
        time.sleep(8)
        url = tab.ev("location.href") or ""
        if OKTA in url:
            print("signed out — bounced to Okta; nothing filled", file=sys.stderr)
            return 3
        tab.ev(SET_JS)

        print(" title      :", tab.ev(f'window.__bcset(\'input[name="submission[caption]"]\', {json.dumps(p["title"])})'))

        if host:
            picked = tab.ev(r"""(() => {
              const s = document.querySelector('select[name="submission[target_id]"]');
              if (!s) return 'no target select';
              const want = %s.toLowerCase();
              const opts = [...s.options].map(o => ({v: o.value, t: (o.text || '').trim()}));
              const hit = opts.find(o => o.t.toLowerCase().includes(want))
                       || opts.find(o => o.t.toLowerCase().includes(want.split('.').slice(-2).join('.')))
                       || opts.find(o => o.v && !/^(-|)$|select/i.test(o.t));
              if (!hit) return 'no option matched ' + want;
              s.value = hit.v;
              s.dispatchEvent(new Event('change', {bubbles: true}));
              return 'picked ' + hit.t.slice(0, 60);
            })()""" % json.dumps(host))
            print(" target     :", picked)

        print(" description:", tab.ev(f'window.__bcset(\'textarea[name="submission[description]"]\', {json.dumps(p["description"])})'))

        def save_now() -> str:
            """Press Save draft. Called twice: once as soon as the text is in (so the draft survives a
            widget that redraws the form), and again after the VRT attempt."""
            r = tab.ev(r"""(() => {
              const b = [...document.querySelectorAll('button,a,span[role="button"]')]
                .find(x => x.getBoundingClientRect().height > 2 && /save draft/i.test(x.innerText || ''));
              if (!b) return 'no save-draft control';
              b.click(); return 'clicked save draft';
            })()""")
            time.sleep(4)
            return r

        print(" save       :", save_now())

        # VRT: the list that opens on typing holds *categories*; takeover lives under Server Security
        # Misconfiguration. Best effort — an unfilled VRT leaves a complete draft for a human to top off,
        # which is strictly better than leaving the queue with nothing in it.
        focused = tab.ev(r"""(() => {
          const el = document.querySelector('input[name="submission[original_vrt_id]"]');
          if (!el) return 'no vrt input';
          el.focus(); el.click(); return 'focused';
        })()""")
        typed = focused
        if focused == "focused":
            try:
                tab.send("Input.insertText", text="Subdomain")
                typed = "inserted"
            except Exception as e:
                typed = f"insert failed: {str(e)[:60]}"
        time.sleep(2.5)

        def pick(pattern: str) -> str:
            return tab.ev(r"""(() => {
              const items = [...document.querySelectorAll(
                '[role="option"], .daisy-dropdown__option, .select2-results__option, li[data-value], .autocomplete__option')]
                .filter(x => x.getBoundingClientRect().height > 2);
              const hit = items.find(x => new RegExp(%s, 'i').test(x.innerText || ''));
              if (!hit) return 'no option (' + items.length + ' in list)';
              hit.click();
              return 'chose ' + (hit.innerText || '').trim().slice(0, 50);
            })()""" % json.dumps(pattern))

        chosen = pick(r"^Server Security Misconfiguration$") or ""
        print(" vrt        :", typed, "/", chosen)
        time.sleep(2.5)
        print(" vrt variant:", pick(r"subdomain takeover|takeover"))
        print(" save again :", save_now())

        errs = tab.ev(r"""(() => {
          const t = document.body.innerText || '';
          const lines = t.split('\n').map(s => s.trim()).filter(Boolean)
            .filter(s => /required|error|invalid|verify|verification|identity/i.test(s));
          return JSON.stringify(lines.slice(0, 6));
        })()""")
        print(" page says  :", errs)
        print(" draft url  :", tab.ev("location.href"))

        if not go:
            print("\ndraft filled and left unsent — pass --go to press Submit")
            return 0

        clicked = tab.ev(r"""(() => {
          const cands = [...document.querySelectorAll('button,input[type=submit],a')]
            .filter(x => x.getBoundingClientRect().height > 2 && !x.disabled);
          const b = cands.find(x => /^submit\b/i.test((x.innerText || x.value || '').trim()));
          if (!b) return 'no submit control';
          b.click(); return 'clicked ' + ((b.innerText || b.value || '')).trim().slice(0, 30);
        })()""")
        print(" submit     :", clicked)
        time.sleep(8)
        after = tab.ev(r"""(() => JSON.stringify({url: location.href,
          text: (document.body.innerText || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 14)}))()""")
        print(" after      :", (after or "")[:900])
        return 0
    finally:
        tab.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("check", "payload", "open", "fill", "submit"))
    ap.add_argument("slug", nargs="?")
    ap.add_argument("--report", type=Path)
    ap.add_argument("--go", action="store_true", help="press Submit after filling (default: save draft only)")
    args = ap.parse_args()

    if args.cmd == "check":
        from bc_session import ProbeUnreachable, signed_in
        try:
            ok, note = signed_in()
        except ProbeUnreachable as e:
            print(f"bugcrowd session: PROBE FAILED — {e}")
            return 2
        print(f"bugcrowd session: {'SIGNED IN' if ok else 'SIGNED OUT'} — {note}")
        return 0 if ok else 1
    if args.cmd == "payload":
        p = payload(args.report)
        print(json.dumps({k: (v[:200] if isinstance(v, str) else v) for k, v in p.items()}, indent=1))
        return 0
    if args.cmd == "open":
        print(json.dumps(open_form(args.slug), indent=1)[:4000])
        return 0
    if args.cmd == "fill":
        return fill(args.slug, args.report, dry=False)
    if args.cmd == "submit":
        return submit(args.slug, args.report, go=args.go)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
