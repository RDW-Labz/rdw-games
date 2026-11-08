#!/usr/bin/env python3
"""Report HackerOne reports whose state has moved, so a blocked filing pipeline can tell you when the
trial-report window reopens without saying the same thing every fifteen minutes.

Why a state file instead of printing every tick: the 15-minute cron speaks only when something changed.
A report sitting in `new` for a week is not news; `new` -> `triaged` is, because triage returns the
trial reports that every Signal-gated programme currently refuses.

Two read paths, because the stored API token currently returns 401 in both Basic and Bearer mode:
the API first (cheap, no browser), then the bounty lane's own signed-in browser on :9226 (the only session that can
see the report pages through Cloudflare).
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_PATH = os.path.expanduser("~/.config/rdwlabz/hackerone_api.token")
USER_PATH = os.path.expanduser("~/.config/rdwlabz/hackerone_api.user")
STATE = os.path.join(HERE, ".triage-state.json")


def _filed_ids() -> list[str]:
    """Read the register, not a hand-typed list.

    The constant below went stale the moment a third report was filed, so its state was never watched:
    a hardcoded id list is the same drift the register was supposed to prevent.
    """
    try:
        data = json.load(open(os.path.join(HERE, "..", "reports", "filed.json")))
    except Exception:
        return []
    ids = []
    for row in data if isinstance(data, list) else data.values():
        rid = str(row.get("id") if isinstance(row, dict) else row)
        if rid.isdigit():
            ids.append(rid)
    return ids


REPORTS = _filed_ids() or ["4168910", "4179852"]

# States HackerOne renders on a report page. Order matters: the first hit wins, because a triaged
# report also mentions "submitted" in its activity feed.
BROWSER_STATES = ["Closed", "Resolved", "Informative", "Duplicate", "Needs more info",
                  "Triaged", "Pending program review", "Submitted", "New"]


def api(path: str) -> dict:
    """HackerOne personal tokens authenticate as HTTP Basic (username + token); OAuth tokens use
    Bearer. Try Basic first when a username file exists, then fall back, so one dead mode does not
    look like a dead token."""
    with open(TOKEN_PATH) as fh:
        token = fh.read().strip()
    username = ""
    if os.path.exists(USER_PATH):
        with open(USER_PATH) as fh:
            username = fh.read().strip()
    auths = ["Bearer " + token]
    if username:
        auths.insert(0, "Basic " + base64.b64encode(f"{username}:{token}".encode()).decode())
    last = None
    for auth in auths:
        req = urllib.request.Request(
            f"https://api.hackerone.com/v1/{path}",
            headers={"Accept": "application/json", "Authorization": auth})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in (401, 403):
                raise
    raise last  # type: ignore[misc]


def browser_state(rid: str) -> str | None:
    sys.path.insert(0, os.path.expanduser("~/Projects/bug-bounty/tools"))
    try:
        import h1_brave  # noqa: WPS433
        tab = h1_brave.Tab(target_id=h1_brave.first_page_id())
        tab.goto(f"https://hackerone.com/reports/{rid}", wait=6)
        text = tab.text(limit=2500) or ""
    except Exception:
        return None
    for state in BROWSER_STATES:
        if state.lower() in text.lower():
            return state
    return None


def main() -> int:
    prev = json.load(open(STATE)) if os.path.exists(STATE) else {}
    now, notes = {}, []
    for rid in REPORTS:
        state = None
        err = ""
        try:
            attrs = api(f"hackers/reports/{rid}")["data"]["attributes"]
            state = attrs.get("state")
            title = (attrs.get("title") or "")[:60]
        except Exception as exc:
            err = str(exc)[:80]
            title = ""
            state = browser_state(rid)
            if state is None:
                notes.append(f"  report {rid}: unreadable (API: {err or 'no detail'}; "
                             f"no browser session on the bounty lane, :9226)")
                continue
        now[rid] = {"state": state, "title": title}
        before = prev.get(rid, {}).get("state")
        if before != state:
            arrow = f"{before} -> {state}" if before else state
            notes.append(f"  report {rid} {arrow}: {title or '(state via browser)'}")

    json.dump(now, open(STATE, "w"), indent=1)
    if not notes:
        return 0
    print("HackerOne report state changed:")
    print("\n".join(notes))
    if any(v.get("state") not in (None, "New", "new", "Submitted") for v in now.values()):
        print("A triaged report restores trial submissions on Signal-gated programmes — "
              "re-run: engine/h1_autofile.py --apply")
    return 0


if __name__ == "__main__":
    sys.exit(main())
