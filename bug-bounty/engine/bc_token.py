#!/usr/bin/env python3
"""Bugcrowd token lifecycle: verify, capture, and remember.

Why this exists: `bc.py health` printing 401 does not tell anyone unless somebody runs it. The
pipeline then spends weeks quietly reporting "0 Bugcrowd leads" while the two highest-paying
reports in the corpus ($4,500 Chipotle, $2,500 Volkswagen) sit undeliverable. A credential that
can rot silently is a credential that will.

**STATUS 2026-11-06: do not chase this yet.** Bugcrowd support confirmed the Hacker API is
pre-GA ("finalizing our Hacker-facing API within the next few weeks"), which is why every token
answers `invalid_token` — there is no token to mint, and `settings/api_credentials` is only
offered to accounts with API access. Until GA, submissions go through the web form
(`engine/bc_web.py`) driven by the signed-in browser, and `engine/bc_session.py` is the watchdog.
Keep this file for the day the API lands.

Bugcrowd issues API tokens with **no expiration** (Settings -> API Credentials, expiration
"No expiration"). One such token ends the re-mint cycle entirely; a 30/60/90-day token recreates
it. This tool assumes the former and treats any 401 as an alarm, not a chore.

  python3 engine/bc_token.py status              # is the token alive, and what may it do
  python3 engine/bc_token.py capture             # read the freshly generated token from the
                                                 # open API Credentials tab and store it 0600
  python3 engine/bc_token.py watch                # cron: silent when healthy, loud when not
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
CRED = HOME / ".config/rdwlabz/bugcrowd_hacker.cred"    # precedence: this one wins over _api.cred
LEGACY = HOME / ".config/rdwlabz/bugcrowd_api.cred"
META = HOME / ".config/rdwlabz/bugcrowd_token.json"
BASE = "https://hacker-api.bugcrowd.com/v1"
SCOPES = ("read:engagement_list", "read:submissions", "write:draft_submissions")


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_token() -> str | None:
    env = os.environ.get("BUGROWD_TOKEN")
    if env and env.strip():
        return env.strip()
    for p in (CRED, LEGACY):
        if p.exists():
            t = p.read_text().strip()
            if t:
                return t
    return None


def probe() -> tuple[int, dict, str]:
    """One call that answers 'is this token good', and three that answer 'may it file'.

    /v1/engagements needs read:engagement_list. The scope probe is deliberately cheap and
    read-only; a 403 insufficient_scope on a write route is the only honest way to know whether
    submission is possible without creating anything.
    """
    tok = read_token()
    if not tok:
        return 0, {}, "no token on disk"

    def hit(path: str, method: str = "GET", body: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(BASE + path, data=data, method=method)
        req.add_header("Authorization", "Token " + tok)
        req.add_header("Accept", "application/json")
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except Exception:
                return e.code, {}
        except Exception as e:                                  # network, DNS, TLS
            return -1, {"error": str(e)[:200]}

    code, payload = hit("/engagements")
    if code != 200:
        detail = payload.get("errors") or payload.get("error") or payload.get("errorSummary") or payload
        return code, payload, json.dumps(detail)[:300]

    n = len(payload.get("engagements") or payload.get("data") or [])
    # An empty draft is the cheapest scope test that writes nothing; a missing scope answers 403
    # before any object exists, so this cannot pollute the account or the programme's inbox.
    wcode, wpayload = hit("/submissions", "POST", {"submission": {"title": "", "description": ""}})
    can_write = wcode not in (401, 403)
    meta = {"scopes": {"read:engagement_list": True, "read:submissions": True,
                       "write:draft_submissions": can_write},
            "engagements_visible": n, "write_probe": wcode}
    return 200, meta, f"ok ({n} engagements)"


def remember(ok: bool, note: str = "") -> None:
    try:
        m = json.loads(META.read_text()) if META.exists() else {}
    except Exception:
        m = {}
    m["last_check"] = now()
    m["healthy"] = ok
    if ok:
        m["last_ok"] = m["last_check"]
    else:
        m["last_failure"] = m["last_check"]
        m["last_failure_note"] = note[:300]
    META.write_text(json.dumps(m, indent=1) + "\n")


def status() -> int:
    code, meta, note = probe()
    ok = code == 200
    print(f"{now()} bugcrowd token: {'OK' if ok else 'FAIL'} ({code}) {note}")
    if ok:
        print(f"  engagements visible: {meta.get('engagements_visible')}")
        sc = meta.get("scopes") or {}
        print("  scopes: " + ", ".join(f"{k}={'yes' if v else 'NO'}" for k, v in sc.items()))
        if not sc.get("write:draft_submissions"):
            print("  ! cannot create submission drafts — Researcher Success has to enable write")
    else:
        print("  next: log in, then `python3 engine/bc_token.py capture`")
    remember(ok, note)
    return 0 if ok else 1


def _scan(tab) -> str:
    """Find the one-time secret anywhere the page might be holding it.

    Generated tokens appear as text, inside a readonly input, and inside a "copy" button's payload
    depending on which build of the page is live. All three are checked because a capture that only
    works on one markup revision is the re-mint chore wearing a costume.
    """
    import re
    pat = re.compile(r"[A-Za-z0-9_\-]{6,}:[A-Za-z0-9_\-./+=]{20,}")
    blobs = [tab.ev("document.body.innerText") or ""]
    for sel in ("input", "textarea"):
        vals = tab.ev(f"[...document.querySelectorAll('{sel}')].map(e=>e.value||'').join('\n')") or ""
        blobs.append(vals)
    blobs.append(tab.ev("[...document.querySelectorAll('[data-clipboard-text],[data-token],[data-value]')]"
                        ".map(e=>e.dataset.clipboardText||e.dataset.token||e.dataset.value||'').join('\n')") or "")
    for b in blobs:
        m = pat.search(b or "")
        if m:
            return m.group(0)
    return ""


def capture() -> int:
    """Pull the token out of the open API Credentials tab.

    The secret is displayed exactly once, on the page that generated it. Rather than have a human
    copy-paste it into a file (and into a chat window), read it from the DOM, store it 0600, and
    print only its shape. Requires the tab to be open on bugcrowd.com/settings/api_credentials.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from cdp_tab import Tab          # the desktop browser that holds the signed-in session

    tab = Tab("https://bugcrowd.com/settings/api_credentials")
    try:
        import time
        time.sleep(6)
        if "login.hackers.bugcrowd.com" in (tab.ev("location.href") or ""):
            print("not signed in: the API Credentials page bounced to Okta. Sign in in Brave first.",
                  file=sys.stderr)
            return 2
        tok = _scan(tab)
    finally:
        tab.close()
    if ":" not in tok or len(tok) < 30:
        print("no token on the page — generate one (expiration: No expiration) and re-run capture",
              file=sys.stderr)
        return 1
    CRED.parent.mkdir(parents=True, exist_ok=True)
    CRED.write_text(tok + "\n")
    CRED.chmod(0o600)
    user, secret = tok.split(":", 1)
    print(f"stored {CRED} (mode 600) — user {user!r}, secret {len(secret)} chars")
    return status()


def watch() -> int:
    """Cron entry point: says nothing when the token works, one line when it does not."""
    code, meta, note = probe()
    ok = code == 200
    remember(ok, note)
    if ok:
        return 0
    print(f"Bugcrowd token is dead ({code}) {note}")
    print("The Chipotle ($4,500) and Volkswagen ($2,500) drafts cannot be delivered until it is "
          "replaced. Log in to bugcrowd.com, open Settings -> API Credentials, generate a token "
          "with **No expiration** and scopes read:engagement_list, read:submissions, "
          "write:draft_submissions, then run: python3 engine/bc_token.py capture")
    return 1


def main() -> int:
    cmd = (sys.argv[1] if len(sys.argv) > 1 else "status").lower()
    if cmd == "status":
        return status()
    if cmd == "capture":
        return capture()
    if cmd == "watch":
        return watch()
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
