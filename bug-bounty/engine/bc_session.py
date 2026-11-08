#!/usr/bin/env python3
"""Is the desktop browser's Bugcrowd session alive?

Bugcrowd's Hacker API is pre-GA (support, 2026-11-06: "we're finalizing our Hacker-facing API
within the next few weeks"), so a 401 from `hacker-api.bugcrowd.com` says nothing about the
account — there is no token to mint until the programme ships. Submission therefore goes through
the web form, driven from the browser that is already signed in.

That makes the session the credential. Sessions expire silently, exactly the way tokens do, so this
probe answers one question cheaply and in the same shape as `bc_token.py watch`: exit 0 silent when
signed in, one actionable line when not.

  python3 engine/bc_session.py check       # signed in / signed out
  python3 engine/bc_session.py watch       # cron: silent when signed in
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

class ProbeUnreachable(Exception):
    """The browser could not be reached at all — which is not the same fact as a dead session.

    This distinction cost real time: `cdp_tab` was pinned to port 9224 while the desktop browser served 9226,
    so every check answered "SIGNED OUT — probe failed: Connection refused" and the board told each session
    that no Bugcrowd filing was possible. The session was fine; the probe was pointed at nothing.
    """


PROBE = "https://bugcrowd.com/dashboard"
OKTA = "login.hackers.bugcrowd.com"


def signed_in(timeout_wait: float = 6.0) -> tuple[bool, str]:
    """Open the dashboard in the desktop browser and see where it lands.

    A signed-in session stays on bugcrowd.com; a dead one is bounced to Okta's authorize endpoint.
    No credentials are involved and nothing is typed — the browser either already holds the cookie
    or it does not, which is precisely the fact worth reporting.
    """
    try:
        from cdp_tab import Tab
    except Exception as e:                          # websockets missing
        return False, f"cannot reach the browser CDP client: {e}"

    tab = None
    try:
        tab = Tab(PROBE)
        time.sleep(timeout_wait)
        url = tab.ev("location.href") or ""
        title = tab.ev("document.title") or ""
        if OKTA in url:
            return False, "bounced to Okta sign-in"
        if not url.startswith("https://bugcrowd.com"):
            return False, f"unexpected landing: {url[:80]}"
        return True, f"{title[:60]} ({url[:60]})"
    except Exception as e:
        raise ProbeUnreachable(f"probe failed: {str(e)[:120]}") from e
    finally:
        if tab is not None:
            tab.close()


def main() -> int:
    cmd = (sys.argv[1] if len(sys.argv) > 1 else "check").lower()
    try:
        ok, note = signed_in()
    except ProbeUnreachable as e:
        # Exit 2, worded as a probe failure: a caller that treats "not signed in" as "sign in again" would
        # otherwise send someone to re-authenticate an account that is still holding a live session.
        print(f"bugcrowd session: PROBE FAILED — {e}")
        return 2
    if cmd == "check":
        print(f"bugcrowd session: {'SIGNED IN' if ok else 'SIGNED OUT'} — {note}")
        return 0 if ok else 1
    if cmd == "watch":
        if ok:
            return 0
        print(f"Bugcrowd session is gone ({note}).")
        print("The Chipotle ($4,500) and Volkswagen ($2,500) drafts cannot be submitted through the "
              "web form until Brave is signed in again. The Hacker API is still pre-GA, so a token "
              "is not an option — sign in at bugcrowd.com, then: python3 engine/bc_web.py fill "
              "chipotle-mbb-og --report <draft.md>")
        return 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
