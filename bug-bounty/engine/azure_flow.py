#!/usr/bin/env python3
"""Walk the Azure self-serve sign-up until the payment form, then hand the keyboard over.

One BiDi session does the whole trip, because Firefox refuses a second session while one is attached
and this flow cannot be resumed: the MFA prompt is tied to the page that asked for it.

It navigates to the pay-as-you-go offer, waits for the identity check, clicks "Send notification" so the
phone prompt goes out, then watches the page. When payment fields appear it prints them, stops touching
the page, and leaves the browser open for a human to key the card — this script never reads, types or
logs a card number, and `document.querySelector` results are deliberately limited to labels.

  python3 engine/azure_flow.py                # full run, parks at the card form
  python3 engine/azure_flow.py --text         # just print what the page says now
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

import websockets

from bidi import PORT, Bidi

SIGNUP = "https://signup.azure.com/signup?offer=ms-azr-0003P"

READ = "document.body.innerText"
CLICK_SEND = """(() => {
  const els = [...document.querySelectorAll('button,a,input[type=submit],div[role=button]')];
  const pick = els.find(e => /send notification/i.test(e.innerText || e.value || ''))
            || els.find(e => /^\\s*(verify|next|continue|sign in)\\s*$/i.test((e.innerText||'').trim()))
            || els.find(e => /send (a )?(push|notification)/i.test(e.innerText || ''));
  if (!pick) return 'NOT_FOUND';
  pick.scrollIntoView({block:'center'});
  pick.click();
  return 'CLICKED: ' + (pick.innerText || pick.value || '').trim().slice(0, 60);
})()"""

# labels only: never collects input values, so a card field can be described without being read
FIELDS = """(() => [...document.querySelectorAll('input,select,button')].map(e => {
  const lab = (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label')
            || e.getAttribute('placeholder') || e.name || e.id || '';
  return (e.tagName.toLowerCase() + ':' + (e.type || '') + ' ' + lab.trim()).slice(0, 80);
}))()"""


async def run(a) -> int:
    async with websockets.connect(f"ws://127.0.0.1:{PORT}/session", max_size=8 << 20) as ws:
        b = await Bidi(ws).open()
        try:
            if a.text:
                print(await b.js(READ))
                return 0

            await b.send("browsingContext.navigate",
                         {"context": b.ctx, "url": SIGNUP, "wait": "complete"})
            print("opened", await b.js("location.href"))
            for _ in range(24):
                await asyncio.sleep(2)
                body = await b.js(READ)
                print("  …", body[:150].replace("\n", " | "))
                if "send notification" in body.lower() or "verify your identity" in body.lower():
                    print(await b.js(CLICK_SEND))
                    print("→ approve the prompt on your phone")
                    break

            for i in range(a.wait // 5):
                await asyncio.sleep(5)
                body = await b.js(READ)
                low = body.lower()
                if any(k in low for k in ("card number", "payment method", "credit card", "cvv")):
                    print("\n=== CARD FORM IS UP — your keyboard ===")
                    print(json.dumps(await b.js(FIELDS), indent=1)[:1200])
                    print("\nbrowser left open; nothing else is touched from here.")
                    return 0
                if i % 6 == 0:
                    print(f"  [{i*5:>3}s]", body[:130].replace("\n", " | "))
            print("\ntimed out waiting for the payment step")
            return 1
        finally:
            await b.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", action="store_true")
    ap.add_argument("--wait", type=int, default=420)
    return asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
