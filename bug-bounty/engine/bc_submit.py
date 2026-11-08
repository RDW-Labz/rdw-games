#!/usr/bin/env python3
"""Fill a Bugcrowd submission form from a drafted report, then (optionally) submit.

The Hacker API is pre-GA, so this drives the same form a human would. `inspect` inventories
the real fields after the submission agreement gate; `fill` types a report in and stops;
`submit` fills and then clicks the final button — the account owner authorised that.

  python3 engine/bc_submit.py inspect etoro-mbb-og
  python3 engine/bc_submit.py fill    etoro-mbb-og --report reports/out/x.md
  python3 engine/bc_submit.py submit  etoro-mbb-og --report reports/out/x.md

Never bypasses the gate: if Bugcrowd asks to agree/join first, that is clicked and the run
reports it, because no form exists before it.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))

from browser_login import SECRETS, Session, new_tab

BASE = "https://bugcrowd.com/engagements"


async def settle(s: Session, seconds: float = 4.0) -> None:
    await asyncio.sleep(seconds)


async def click_text(s: Session, pattern: str, tag: str = "button,input[type=submit],a") -> bool:
    js = """([pat, tag]) => { const re = new RegExp(pat, 'i');
        const el = [...document.querySelectorAll(tag)]
            .find(e => re.test((e.innerText || e.value || '').trim()));
        if (el) { el.click(); return true; } return false; }"""
    return bool(await s.ev(f"({js})([{json.dumps(pattern)}, {json.dumps(tag)}])"))


async def open_form(s: Session, slug: str) -> str:
    await s.ev(f"location.href = {json.dumps(f'{BASE}/{slug}/submissions/new')}")
    await settle(s, 8)
    body = (await s.ev("document.body.innerText") or "").lower()
    if "agree and continue" in body:
        await click_text(s, "^agree and continue$")
        await settle(s, 7)
    return (await s.ev("location.href") or "")


async def inventory(s: Session) -> list[dict]:
    raw = await s.ev("""JSON.stringify([...document.querySelectorAll('input,select,textarea')]
        .filter(e => e.name && !/collaborator|^_|authenticity/.test(e.name))
        .map(e => ({tag: e.tagName.toLowerCase(), type: e.type, name: e.name,
                    label: (e.getAttribute('aria-label') || e.placeholder || '').slice(0, 40),
                    opts: e.tagName === 'SELECT' ? [...e.options].map(o => [o.value, o.textContent.trim().slice(0, 40)]).slice(0, 40) : []})))""")
    return json.loads(raw or "[]")


def pick_target(pairs: list, hint: str):
    """Choose the scope entry a host belongs to.

    Programmes list both exact hosts and wildcards, and a substring match picks the wrong one the moment the
    programme name shares a token with a host — 'epam' matched *.epam.com while the finding was on
    *.emakina.at, which files a true finding against the wrong asset. Membership is decided by suffix, and
    an exact pattern beats a wildcard that covers it.
    """
    h = (hint or "").strip().lower()
    if not h:
        return None
    for v, t in pairs:
        if t.strip().lower() == h:
            return v
    for v, t in pairs:                                  # wildcard that covers the host
        tt = t.strip().lower()
        if tt.startswith("*.") and (h == tt[2:] or h.endswith(tt[1:])):
            return v
    for v, t in pairs:                                  # exact host listed somewhere in scope
        if h.endswith(t.strip().lower()) and t.strip():
            return v
    return None


def asset_from_report(path: str) -> str:
    """The asset line the report itself declares: `**Asset:** donau.devweb.emakina.at`."""
    try:
        m = re.search(r"\*\*Asset:\*\*\s*`?([A-Za-z0-9._*-]+)`?", Path(path).read_text())
        return m.group(1) if m else ""
    except Exception:
        return ""


async def fill_form(s: Session, title: str, desc: str, url: str, target_hint: str) -> dict:
    done = {}
    done["title"] = await s.fill('input[name="submission[caption]"]', title)

    if target_hint:
        opts = await s.ev("""JSON.stringify([...document.querySelectorAll('select[name="submission[target_id]"] option')]
            .map(o => [o.value, o.textContent.trim()]))""")
        pairs = json.loads(opts or "[]")
        match = pick_target(pairs, target_hint)
        if match:
            await s.ev(f"""(() => {{ const el = document.querySelector('select[name="submission[target_id]"]');
                const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
                d.set.call(el, {json.dumps(match)});
                el.dispatchEvent(new Event('change', {{bubbles: true}})); }})()""")
        done["target"] = [target_hint, match, len(pairs)]

    if url:
        done["url"] = await s.fill('input[name="submission[bug_url]"]', url)
    done["description"] = await s.fill('textarea[name="submission[description]"]', desc)
    done["consents"] = await s.ev("""(() => { const out = {};
        for (const n of ['hacker_privacy_policy', 'hacker_disclosure_terms']) {
            const el = document.querySelector(`input[name="${n}"]`);
            if (!el) { out[n] = 'missing'; continue; }
            if (!el.checked) el.click();
            out[n] = el.checked ? 'checked' : 'NOT checked';
        } return JSON.stringify(out); })()""")
    return done


async def type_keys(s: Session, selector: str, text: str) -> bool:
    """Type like a human: real keyDown/char/keyUp per character.

    The VRT picker filters on keyboard handlers, so setting .value (what Session.fill does)
    leaves the list unfiltered — genuine key events are the only thing that works.
    """
    if not await s.ev(f"(() => {{ const e = document.querySelector({json.dumps(selector)}); "
                     f"if (!e) return false; e.focus(); e.value = ''; return true; }})()"):
        return False
    for ch in text:
        for kind in ("keyDown", "char", "keyUp"):
            params = {"type": kind, "text": ch if kind == "char" else "",
                      "key": ch, "unmodifiedText": ch}
            if kind != "char":
                params.pop("text")
            await s.send("Input.dispatchKeyEvent", **params)
        await asyncio.sleep(0.02)
    return True


async def set_vrt(s: Session, want: str) -> dict:
    """Open the VRT picker, filter by typing, and take the matching entry."""
    await s.ev("(() => { const e = document.querySelector('.vrt-dropdown__select'); if (e) e.click(); })()")
    await asyncio.sleep(2)
    typed = await type_keys(s, ".vrt-dropdown__input", want)
    await asyncio.sleep(2.5)
    shown = await s.ev("""JSON.stringify([...document.querySelectorAll('#vrt-categories li')]
        .map(e => (e.innerText || '').trim().slice(0, 50)).filter(Boolean).slice(0, 10))""")
    picked = await s.ev(f"""(() => {{
        const el = [...document.querySelectorAll('#vrt-categories li')]
            .find(e => new RegExp({json.dumps(want)}, 'i').test(e.innerText || ''));
        if (!el) return '';
        const r = el.getBoundingClientRect();
        const o = {{bubbles: true, clientX: r.x + 4, clientY: r.y + 4}};
        el.dispatchEvent(new MouseEvent('mousedown', o));
        el.dispatchEvent(new MouseEvent('mouseup', o));
        el.click();
        return (el.innerText || '').trim().slice(0, 50); }})()""")
    await asyncio.sleep(2)
    value = await s.ev("(() => { const e = document.querySelector('#vrt-form-input'); return e ? e.value : 'none'; })()")
    return {"typed": typed, "results": json.loads(shown or "[]"), "picked": picked, "value": value}


def ap_parse():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["inspect", "fill", "draft", "submit"])
    ap.add_argument("slug")
    ap.add_argument("--report")
    ap.add_argument("--target", default="")
    ap.add_argument("--vrt", default="Subdomain Takeover")
    ap.add_argument("--url", default="")
    return ap.parse_args()


async def run(args) -> int:
    title = desc = ""
    if args.report:
        text = Path(args.report).read_text()
        m = re.search(r"^#\s+(.+)$", text, re.M)
        title = m.group(1).strip() if m else Path(args.report).stem
        desc = text

    async with websockets.connect(new_tab(f"{BASE}/{args.slug}"), max_size=40_000_000) as ws:
        s = Session(ws)
        await settle(s, 5)
        url_now = await s.ev("location.href") or ""
        print("opened:", url_now[:90])
        if "login.hackers.bugcrowd.com" in url_now:
            print("session died mid-run; re-run engine/okta_login.py")
            return 1
        print("form url:", (await open_form(s, args.slug))[:90])
        fields = await inventory(s)
        for f in fields:
            print(f"  {f['tag']:8} {f['type']:9} name={f['name'][:45]:45} label={f['label'][:32]!r}")
            for v, t in f["opts"][:6]:
                print(f"      opt {v:>8} {t}")
        if args.mode == "inspect":
            return 0

        hint = args.target or asset_from_report(args.report or "")
        done = await fill_form(s, title, desc, args.url, hint)
        print("filled:", json.dumps(done)[:300])
        vrt = await set_vrt(s, args.vrt)
        print("vrt:", json.dumps(vrt)[:300])
        await settle(s, 2)
        summary = await s.ev("""JSON.stringify({caption: (document.querySelector('input[name=\"submission[caption]\"]')||{}).value || '',
            desc_len: ((document.querySelector('textarea[name=\"submission[description]\"]')||{}).value || '').length,
            vrt: (document.querySelector('input[name=\"submission[original_vrt_id]\"]')||{}).value || '',
            target: (document.querySelector('select[name=\"submission[target_id]\"]')||{}).value || ''})""")
        print("form state:", summary)
        if args.mode == "draft":
            print("save draft:", await click_text(s, "^save draft$"))
            await settle(s, 6)
            print("after draft:", await s.ev("JSON.stringify({url: location.href.slice(0, 120)})"))
            return 0
        if args.mode != "submit":
            print("stopped before submit (fill mode)")
            return 0
        clicked = await click_text(s, "^(submit report|submit)$")
        print("submit clicked:", clicked)
        await settle(s, 10)
        print("after submit:", await s.ev("JSON.stringify({url: location.href.slice(0, 110), "
                                          "text: document.body.innerText.slice(0, 220)})"))
        return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(ap_parse())))
