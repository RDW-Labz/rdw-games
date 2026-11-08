#!/usr/bin/env python3
"""Full Bugcrowd sign-in over CDP, including the enrolled authenticator factor.

The account owner's instruction was "type it in for me": identifier, password and the TOTP
code are all supplied here, from ~/.config/rdwlabz/platform_secrets.json, inside the page's
own JS or this process's memory — never argv, never a log line, never the transcript.

Flow: identifier -> Next -> password -> TOTP -> Continue -> OAuth redirect to bugcrowd.com.

  python3 engine/okta_login.py                                  # end on the dashboard
  python3 engine/okta_login.py --url=https://bugcrowd.com/engagements/volkswagen-og
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import struct
import sys
import time
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))

from browser_login import SECRETS, Session, new_tab

SIGN_IN = "https://bugcrowd.com/user/sign_in"
DEFAULT_DEST = "https://bugcrowd.com/dashboard"


def totp(secret: str, step: int = 30, digits: int = 6) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    mac = hmac.new(key, struct.pack(">Q", int(time.time()) // step), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    return str((struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % 10 ** digits).zfill(digits)


async def body_text(s: Session, tries: int = 8) -> str:
    out = ""
    for _ in range(tries):
        out = ((await s.ev("document.body.innerText")) or "").lower()
        if out.strip():
            return out
        await asyncio.sleep(1)
    return out


async def click(s: Session, pattern: str) -> bool:
    js = """(pat) => { const re = new RegExp(pat, 'i');
        const el = [...document.querySelectorAll('button,input[type=submit],a')]
            .find(e => re.test((e.innerText || e.value || '').trim()));
        if (el) { el.click(); return true; } return false; }"""
    return bool(await s.ev(f"({js})({json.dumps(pattern)})"))


async def main(dest: str) -> int:
    c = json.loads(SECRETS.read_text())["bugcrowd"]
    secret = c.get("totp_secret") or ""
    print("totp secret present:", bool(secret))

    async with websockets.connect(new_tab(SIGN_IN), max_size=40_000_000) as ws:
        s = Session(ws)
        await asyncio.sleep(6)
        print("start:", (await s.ev("location.href") or "")[:70])

        if not await s.fill('input[name="identifier"]', c["email"]):
            print("no identifier field:", (await body_text(s))[:140])
            return 1
        await s.ev("(() => { const k = document.querySelector('input[name=rememberMe]'); if (k && !k.checked) k.click(); })()")
        await click(s, "^(next|continue)$")
        await asyncio.sleep(5)

        if not await s.fill('input[name="credentials.passcode"]', c["password"]):
            print("no password field:", (await body_text(s))[:140])
            return 1
        await click(s, "^(verify|next|sign in|continue)$")
        await asyncio.sleep(6)

        body = await body_text(s)
        if "displayed from application" in body or "enter code" in body or "authenticator" in body:
            if not secret:
                print("authenticator demanded but no stored secret")
                return 1
            sel = await s.ev("""(() => { const i = [...document.querySelectorAll('input')]
                .find(x => x.type !== 'submit' && x.type !== 'hidden'); return i ? (i.name || i.id) : ''; })()""")
            print("filling totp into:", sel)
            if not await s.fill(f'input[name="{sel}"]' if sel else "input", totp(secret)):
                print("fill failed; inputs:", await s.ev("""JSON.stringify([...document.querySelectorAll('input')].map(i=>[i.name,i.type]))"""))
                return 1
            await click(s, "^(verify|next|continue)$")
            await asyncio.sleep(7)
            body = await body_text(s)

        for _ in range(3):
            if "set up security methods" in body:
                await click(s, "^(continue|done|finish)$")
                await asyncio.sleep(6)
                body = await body_text(s)
            else:
                break

        print("post-auth:", await s.ev("JSON.stringify({url: location.href.slice(0, 90), text: document.body.innerText.slice(0, 120)})"))

        await s.ev(f"location.href = {json.dumps(dest)}")
        await asyncio.sleep(10)
        print("landed:", await s.ev("""JSON.stringify({url: location.href.slice(0, 100), title: document.title,
            text: document.body.innerText.slice(0, 180)})"""))
        return 0


if __name__ == "__main__":
    target = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--url=")), DEFAULT_DEST)
    sys.exit(asyncio.run(main(target)))
