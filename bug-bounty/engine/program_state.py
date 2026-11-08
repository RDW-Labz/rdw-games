#!/usr/bin/env python3
"""Record each HackerOne programme's `submission_state` so paused programmes stop looking payable.

A scope row saying `eligible_for_bounty: true` is not an invitation: Expedia Group is `paused`, eToro is
`paused`, and a POST to a paused programme returns a bare `403 {"errors":[{"status":403}]}` with no
explanation — after the report has already been written. The programme-level flag lives on the
programme, not the scope, and it changes without the scope data changing at all, so it has to be read
from the API and cached next to the matches it qualifies.

  python3 engine/program_state.py            # refresh the cache
  python3 engine/program_state.py etoro_bbp  # print one programme's state
"""
from __future__ import annotations

import base64
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "engine" / "data" / "h1_program_state.json"
CFG = Path.home() / ".config" / "rdwlabz"
API = "https://api.hackerone.com/v1"
UA = "rdwlabz-recon/1.0"


def auth() -> str:
    u = (CFG / "hackerone_api.user").read_text().strip()
    t = (CFG / "hackerone_api.token").read_text().strip()
    return base64.b64encode(f"{u}:{t}".encode()).decode()


def call(path: str) -> dict:
    # `links.next` is a full URL; prefixing it with API again is a guaranteed 404.
    url = path if path.startswith("http") else f"{API}{path}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Basic {auth()}", "Accept": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read())


def refresh() -> dict:
    state: dict[str, dict] = {}
    path = "/hackers/programs"          # no page[size] param: the API 404s on it
    pages = 0
    while path and pages < 60:
        payload = call(path)
        for p in payload.get("data", []):
            a = p.get("attributes", {})
            h = a.get("handle")
            if not h:
                continue
            state[h] = {
                "submission_state": a.get("submission_state"),
                "triage_active": a.get("triage_active"),
                "offers_bounties": a.get("offers_bounties"),
                "state": a.get("state"),
            }
        path = (payload.get("links") or {}).get("next")
        pages += 1
    OUT.write_text(json.dumps({
        "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "programs": state}, indent=0, sort_keys=True))
    counts: dict[str, int] = {}
    for v in state.values():
        counts[v["submission_state"] or "unknown"] = counts.get(v["submission_state"] or "unknown", 0) + 1
    print(f"{len(state)} programmes cached from {pages} page(s) -> {OUT.relative_to(ROOT)}")
    print("  " + "  ".join(f"{k}={v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1])))
    return state


def load() -> dict:
    if not OUT.exists():
        return {}
    return json.loads(OUT.read_text()).get("programs", {})


def is_open(handle: str) -> bool | None:
    """True only when the platform says the programme is accepting submissions right now."""
    st = load().get(handle)
    if not st:
        return None
    return st.get("submission_state") == "open"


def main() -> int:
    a = sys.argv[1:]
    if a and a[0] not in ("refresh", "all"):
        st = load().get(a[0])
        print(f"{a[0]}: {st or 'not cached (run with no arguments to refresh)'}")
        return 0
    refresh()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
