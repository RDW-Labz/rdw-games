#!/usr/bin/env python3
"""Finish a HackerOne password reset end to end, without the operator touching anything.

Establishing the rail was the hard part: the account's address is `jmacluer@gmail.com`, not the
`security@rdwlabz.com` in the vault — a reset request for the vault address is silently dropped (HackerOne
never confirms whether an address exists), and only the Gmail one lands. The mailbox is readable through the
Firefox profile copy, so the link can be collected and walked.

  python3 tools/h1_password.py            # collect link, set a new secret, write it to the vault
  python3 tools/h1_password.py --dry-run  # collect the link and prove it is live, set nothing

The new secret is written to `~/.config/rdwlabz/platform_secrets.json` (0600) and never printed. A reset
token is a live credential: it is printed truncated and never persisted. If the token page refuses — expired,
already used, or asking for a second factor — the script reports that instead of retrying, because a second
reset burns the first link and looks like an attack to the platform.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import secrets
import string
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

CDP = "http://127.0.0.1:9226"
BB = Path(__file__).resolve().parent.parent
SECRETS = Path.home() / ".config/rdwlabz/platform_secrets.json"
ALPHABET = string.ascii_letters + string.digits + "!@#$%^&*-_=+"

# One reset flow, two platforms. HackerOne's link is Devise (`users/password/edit?reset_password_token=`),
# Intigriti's is its own account app (`login.intigriti.com/account/...password...`), so the link matcher and
# the "did it land" check are per site — the mechanism (forgot form -> mailbox -> tokenised link -> set) is not.
SITES = {
    "hackerone": {"mail": "from:hackerone reset", "subject": "Reset password instructions",
                  "link": ("users/password/edit", "reset_password_token"),
                  "landed": "sign_in", "login": "https://hackerone.com/users/sign_in",
                  "forgot": [(r"forgot your password", "a,button")]},
    "intigriti": {"mail": "from:intigriti", "subject": "password",
                  "link": ("password",), "landed": "login.intigriti.com",
                  "login": "https://login.intigriti.com/account/login",
                  "forgot": [(r"forgot your password", "a,button")]},
}


def vault_email(site: str, fallback: str) -> str:
    try:
        return json.loads(SECRETS.read_text())[site]["email"]
    except Exception:
        return fallback


async def tab(websockets, url, settle=9):
    req = urllib.request.Request(f"{CDP}/json/new?{urllib.parse.quote(url, safe='')}", method="PUT")
    wsurl = json.load(urllib.request.urlopen(req))["webSocketDebuggerUrl"]
    await asyncio.sleep(settle)
    ws = await websockets.connect(wsurl, max_size=2 ** 24)
    ws.n = 0
    return ws


async def ev(ws, expr):
    ws.n += 1
    await ws.send(json.dumps({"id": ws.n, "method": "Runtime.evaluate",
                              "params": {"expression": expr, "returnByValue": True}}))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == ws.n:
            return (m.get("result") or {}).get("result", {}).get("value")


async def collect_link(websockets, subject: str, site: str = "hackerone") -> str | None:
    """Pull the tokenised URL out of the reset mail.

    The message must be opened inside the already-signed-in Gmail tab: a fresh tab pointed at
    `mail.google.com/mail/u/0/#search/...` renders an empty list because the hash route only runs on a
    page that Gmail already bootstrapped. `mail_search.py --open` drives the authenticated tab and returns
    every anchor in the body, which includes the token link.
    """
    cfg = SITES[site]
    r = subprocess.run([str(BB / ".venv/bin/python"), str(BB / "tools/mail_search.py"),
                        cfg["mail"], "--open", "--json"],
                       capture_output=True, text=True, timeout=420)
    try:
        d = json.loads(r.stdout)
    except Exception:
        print("mail read failed:", (r.stdout or r.stderr or "")[-300:])
        return None
    links = d.get("links") or []
    hits = [x for x in links if all(part in x for part in cfg["link"])]
    return hits[0] if hits else None


async def set_password(websockets, url: str, new_pw: str, dry: bool) -> dict:
    async with await tab(websockets, url, settle=10) as ws:
        state = {}
        state["url"] = await ev(ws, "location.href")
        state["title"] = await ev(ws, "document.title")
        state["has_pw_field"] = bool(await ev(ws, "!!document.querySelector('input[type=password]')"))
        if dry or not state["has_pw_field"]:
            state["body"] = (await ev(ws, "document.body.innerText.replace(/\\s+/g,' ').slice(0,300)"))
            return state
        filled = await ev(ws, """(() => {
          const els = [...document.querySelectorAll('input[type=password]')];
          const set = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el, v);
            el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
          els.forEach(el => set(el, %s));
          return els.length; })()""" % json.dumps(new_pw))
        state["fields_filled"] = filled
        await asyncio.sleep(1)
        await ev(ws, """(() => { const b=[...document.querySelectorAll('button,[type=submit]')]
            .find(x=>/change|update|reset|save/i.test((x.innerText||x.value||'').trim())); if(b){b.click();return 1}
          const f=document.querySelector('form'); if(f){f.submit();return 1} return 0 })()""")
        await asyncio.sleep(14)
        state["after_url"] = await ev(ws, "location.href")
        state["after_text"] = await ev(ws, "document.body.innerText.replace(/\\s+/g,' ').slice(0,320)")
        return state


def save_secret(email: str, pw: str, site: str = "hackerone") -> None:
    data = json.loads(SECRETS.read_text())
    data.setdefault(site, {})
    data[site]["email"] = email
    data[site]["password"] = pw
    data[site]["rotated_by"] = "tools/h1_password.py"
    fd, tmp = tempfile.mkstemp(dir=str(SECRETS.parent))
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, SECRETS)
    print(f"vault: {SECRETS} updated (0600) — {site}.email={email}, password rotated")


async def request_reset(websockets, site: str, email: str) -> dict:
    """Submit the forgotten-password form. Silence here is not proof of anything — the platform never says
    whether an address exists — so this returns the page's own words and the caller goes looking in the mail."""
    cfg = SITES[site]
    async with await tab(websockets, cfg["login"], settle=8) as ws:
        out = {}
        out["cookies"] = await ev(ws, """(() => { const b=[...document.querySelectorAll('button')]
            .find(x=>/accept all|reject all/i.test(x.innerText||'')); if(b){b.click();return 'dismissed'} return 'none' })()""")
        await asyncio.sleep(1)
        # The "Forgot your password?" link is not on step 1 — it renders on the password step, so the email has
        # to be submitted first. Clicking it from the first screen silently does nothing.
        async def fill_email():
            return bool(await ev(ws, """(() => { const el=document.querySelector('input[type=email],input[name*=mail i],#Input_Email');
                if(!el) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el, %s);
                el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true })()"""
                                 % json.dumps(email)))

        async def click(regex_js: str):
            return await ev(ws, """(() => { const b=[...document.querySelectorAll('a,button,[type=submit]')]
                .find(x=>/%s/i.test((x.innerText||x.value||'').trim())); if(b){b.click();return 'clicked'} return 'none' })()""" % regex_js)

        await fill_email()
        out["step1"] = await click("next|continue")
        await asyncio.sleep(4)
        out["forgot"] = await click("forgot your password")
        await asyncio.sleep(6)
        out["reset_email_field"] = await fill_email()
        out["filled"] = bool(await ev(ws, """(() => { const el=document.querySelector('input[type=email],input[name*=mail i],#Input_Email');
            if(!el) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el, %s);
            el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true })()"""
                                 % json.dumps(email)))
        await asyncio.sleep(1)
        out["submit"] = await ev(ws, """(() => { const b=[...document.querySelectorAll('button,[type=submit]')]
            .find(x=>/reset|send|instructions|continue|next/i.test((x.innerText||x.value||'').trim()));
            if(b){b.click();return 'clicked'} const f=document.querySelector('form'); if(f){f.requestSubmit();return 'form'} return 'none' })()""")
        await asyncio.sleep(10)
        out["page_says"] = (await ev(ws, "document.body.innerText.replace(/\\s+/g,' ').slice(0,320)"))
        return out


async def main() -> int:
    import websockets
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--site", default="hackerone", choices=sorted(SITES))
    ap.add_argument("--request", action="store_true", help="submit the forgot form first")
    ap.add_argument("--email", default=None)
    a = ap.parse_args()
    cfg = SITES[a.site]
    a.email = a.email or vault_email(a.site, "jmacluer@gmail.com")

    if a.request:
        print("request:", json.dumps(await request_reset(websockets, a.site, a.email), indent=1)[:500])

    link = await collect_link(websockets, cfg["subject"], a.site)
    if not link:
        print("no reset mail with a link — request one with tools/h1_reset.py request %s" % a.email)
        return 3
    print("link:", re.sub(r"(token=)[^&]+", r"\1<redacted>", link)[:110])

    pw = a.email and "".join(secrets.choice(ALPHABET) for _ in range(24))
    st = await set_password(websockets, link, pw, a.dry_run)
    print(json.dumps({k: v for k, v in st.items()}, indent=1)[:700])
    if a.dry_run:
        return 0
    if cfg["landed"] in (st.get("after_url") or ""):
        save_secret(a.email, pw, a.site)
        return 0
    print("token page did not accept the change — not saving, not retrying")
    return 4


raise SystemExit(asyncio.run(main()))
