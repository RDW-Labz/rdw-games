"""Live HackerOne structured-scope lookup, cached on disk.

The lesson this module exists to encode: the local `scopes` table (one row per asset with a bare
`apex` column) is good enough to *find* a candidate programme, but it is not good enough to *file*
one. It over-claims — a host under `starbucks.com` matches the Starbucks programme's apex, while
none of Starbucks' 16 live assets actually contains it — and that mismatch is exactly how a report
gets closed "informative" an hour after filing. Anything that decides in-scope/out-of-scope must ask
HackerOne itself, paginated, with the eligibility flags read from the asset.

Usage:
    python3 engine/h1_scope.py spotify ellen.withspotify.com
    python3 engine/h1_scope.py --refresh spotify      # ignore the 24h cache
    python3 engine/h1_scope.py --all marriott         # dump every live asset
"""

from __future__ import annotations

import json
import re
import sys
import time
from fnmatch import fnmatch
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "engine" / "data" / "h1_scopes"
TTL = 24 * 3600
sys.path.insert(0, str(ROOT / "engine"))


def _norm(asset: str) -> str:
    """`https://gateway.marriott.com/v1/` -> `gateway.marriott.com`."""
    a = (asset or "").strip().lower()
    a = re.sub(r"^[a-z]+://", "", a)
    a = a.split("/")[0].split("?")[0]
    return a.rstrip(".")


def _row(r: dict) -> dict:
    a = r.get("attributes") or {}
    return {
        "id": str(r.get("id")),
        "asset": a.get("asset_identifier") or "",
        "type": a.get("asset_type") or "",
        "bounty": bool(a.get("eligible_for_bounty")),
        "submission": bool(a.get("eligible_for_submission")),
        "max_severity": a.get("max_severity") or "",
        "instruction": a.get("instruction") or "",
    }


SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def _slug_ok(handle: str) -> bool:
    """`scopes.handle` mixes real HackerOne handles with display names such as "Chipotle Managed Bug
    Bounty Engagement" (Bugcrowd programmes seeded from a different table). Interpolating a display
    name into a URL raises InvalidURL; a handle is a single URL-safe token, so anything else is not
    a HackerOne programme at all."""
    return bool(SLUG.match(handle or ""))


def fetch(handle: str) -> list[dict]:
    """Every structured scope on a programme. Paged: marriott has 99, twilio 112, epicgames 188 —
    a single `page[size]=100` call silently truncates two of those three."""
    import h1_api

    if not _slug_ok(handle):
        return []
    out: list[dict] = []
    page = 1
    while page <= 20:
        code, payload = h1_api.call(
            "GET", f"/hackers/programs/{quote(handle, safe='')}"
                   f"/structured_scopes?page[size]=100&page[number]={page}")
        if code != 200 or not isinstance(payload, dict):
            break
        rows = payload.get("data") or []
        out.extend(_row(r) for r in rows if isinstance(r, dict))
        if len(rows) < 100:
            break
        page += 1
    return out


def list_scopes(handle: str, refresh: bool = False) -> list[dict]:
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{handle}.json"
    if f.exists() and not refresh:
        try:
            blob = json.loads(f.read_text())
            if time.time() - blob.get("fetched_epoch", 0) < TTL:
                return blob["scopes"]
        except Exception:
            pass
    scopes = fetch(handle)
    if scopes:
        f.write_text(json.dumps({"fetched_epoch": int(time.time()), "handle": handle,
                                 "scopes": scopes}, indent=1) + "\n")
    return scopes


def covers(host: str, asset: str) -> bool:
    """Wildcard-aware containment. Exact match beats `*.suffix`; internal `*` is a glob."""
    h = host.strip().lower().rstrip(".")
    a = _norm(asset)
    if not h or not a:
        return False
    if "*" not in a:
        return h == a
    if a.startswith("*."):
        base = a[2:]
        return h == base or h.endswith("." + base)
    return fnmatch(h, a)


def match(handle: str, host: str, need_bounty: bool = False,
          refresh: bool = False) -> dict | None:
    """The live asset that contains `host`, preferring eligible ones and the most specific pattern.

    Returns None when the programme does not actually list this host — callers must treat that as
    "do not file", not as "file anyway"."""
    best: dict | None = None
    for s in list_scopes(handle, refresh=refresh):
        if not covers(host, s["asset"]):
            continue
        if not s["submission"]:
            continue
        if need_bounty and not s["bounty"]:
            continue
        key = (len(_norm(s["asset"])), 1 if "*" not in s["asset"] else 0, 1 if s["bounty"] else 0)
        if best is None or key > best["_key"]:
            s = dict(s, _key=key)
            best = s
    if best:
        best.pop("_key", None)
    return best


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    refresh = "--refresh" in argv
    argv = [a for a in argv if a != "--refresh"]
    if argv[0] == "--all":
        handle = argv[1] if len(argv) > 1 else ""
        for s in list_scopes(handle, refresh=refresh):
            print(f"  {s['id']:>9} {'B' if s['bounty'] else '-'}{'S' if s['submission'] else '-'} "
                  f"{s['max_severity']:<8} {s['asset']}")
        return 0
    if len(argv) < 2:
        print(__doc__)
        return 2
    handle, host = argv[0], argv[1]
    s = match(handle, host, refresh=refresh)
    if not s:
        total = len(list_scopes(handle))
        print(f"OUT  {host} is not covered by any eligible asset on {handle} ({total} live scopes)")
        return 1
    print(f"IN   {host} -> scope {s['id']} {s['asset']} "
          f"(bounty={s['bounty']} submission={s['submission']} max={s['max_severity']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
