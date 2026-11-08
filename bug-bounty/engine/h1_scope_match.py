#!/usr/bin/env python3
"""Cross-match every claimable finding against the LIVE HackerOne scope list.

bounty-targets-data (what engine/programs.py syncs) lags and only covers programmes that publish
their scope in the public JSON. This asks HackerOne directly: which of the 70 claimable hosts sit in a
bounty-paying structured scope *right now*? A hit is a filing candidate; a miss is not a bug.

The hacker API rate-limits hard (429s appear after ~50 programmes), so every programme's scope list is
cached in engine/data/h1_scopes_cache.json and a re-run resumes instead of re-fetching. 429/5xx are
retried with exponential backoff rather than silently dropped — a dropped programme is a false negative
that costs real money.

  python3 engine/h1_scope_match.py             # full run, resumable
  python3 engine/h1_scope_match.py --limit 40  # smoke test
  python3 engine/h1_scope_match.py --refresh   # ignore the cache
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from h1_api import call, show_errors  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "reports" / "h1-scope-matches.json"
CACHE = ROOT / "engine" / "data" / "h1_scopes_cache.json"


def get(path: str, size: int = 100, number: int = 1, tries: int = 6):
    """GET with backoff on 429/5xx — the hacker API throttles well below its documented limit."""
    delay, code, payload = 2.0, 0, {}
    for attempt in range(tries):
        try:
            code, payload = call("GET", f"{path}?page[size]={size}&page[number]={number}")
        except Exception as e:  # transient DNS/socket blip — resume rather than lose the programme
            wait = min(delay * (2 ** attempt), 60)
            print(f"    network error ({e}) — retry in {wait:.0f}s ({attempt + 1}/{tries})")
            time.sleep(wait)
            continue
        if code == 200:
            return code, payload
        if code in (429, 500, 502, 503, 504):
            wait = min(delay * (2 ** attempt), 60)
            print(f"    {code} — backoff {wait:.0f}s ({attempt + 1}/{tries})")
            time.sleep(wait)
            continue
        return code, payload
    return code, payload


def pages(path: str, size: int = 100):
    n = 1
    while True:
        code, payload = get(path, size=size, number=n)
        if code != 200:
            show_errors(code, payload)
            return
        data = payload.get("data") or []
        yield data
        if not data or not (payload.get("links") or {}).get("next"):
            return
        n += 1


def scope_hit(host: str, identifier: str, asset_type: str) -> bool:
    """Wildcard-aware, suffix-anchored match — the same rule the programmes use."""
    ident = identifier.strip().lower().rstrip(".")
    host = host.lower().rstrip(".")
    if asset_type and asset_type.lower() not in ("url", "domain", "wildcard"):
        return False
    if ident.startswith("*."):
        base = ident[2:]
        return host == base or host.endswith("." + base)
    if ident.startswith("*"):
        return host.endswith(ident.lstrip("*"))
    ident = ident.split("://", 1)[-1].split("/", 1)[0]
    return host == ident or host.endswith("." + ident)


def scopes_for(handle: str, cache: dict) -> list[dict]:
    if handle in cache:
        return cache[handle]
    out: list[dict] = []
    for batch in pages(f"/hackers/programs/{handle}/structured_scopes"):
        for s in batch:
            a = s.get("attributes") or {}
            if a.get("asset_identifier"):
                out.append({"id": s.get("id"), "asset": a["asset_identifier"],
                            "type": a.get("asset_type") or "",
                            "bounty": bool(a.get("eligible_for_bounty")),
                            "max_severity": a.get("max_severity")})
    cache[handle] = out
    return out


def main() -> None:
    args = sys.argv[1:]
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
    refresh = "--refresh" in args

    db = sqlite3.connect(f"file:{ROOT / 'engine' / 'state.db'}?mode=ro", uri=True)
    hosts = [r[0] for r in db.execute("select host from findings where claimable=1")]
    print(f"{len(hosts)} claimable hosts to match")

    programs: list[tuple[str, str, bool, str]] = []
    for batch in pages("/hackers/programs"):
        for p in batch:
            a = p.get("attributes") or {}
            # submission_state is the authority: a scope can stay bounty-eligible while the
            # programme itself is paused ("taking a break"), and filing then 403s.
            programs.append((a.get("handle") or "", a.get("name") or "", bool(a.get("offers_bounties")),
                             a.get("submission_state") or "unknown"))
    bounty = [p for p in programs if p[2]]
    paused = [p for p in bounty if p[3] == "paused"]
    print(f"{len(programs)} programmes visible · {len(bounty)} paying · {len(paused)} paying-but-paused")
    if limit:
        bounty = bounty[:limit]

    CACHE.parent.mkdir(parents=True, exist_ok=True)
    cache = {} if refresh else (json.loads(CACHE.read_text()) if CACHE.exists() else {})

    matches: list[dict] = []
    for i, (handle, name, _, sub_state) in enumerate(bounty, 1):
        if not handle:
            continue
        scopes = scopes_for(handle, cache)
        for s in scopes:
            for h in hosts:
                if scope_hit(h, s["asset"], s["type"]):
                    matches.append({"host": h, "program": handle, "program_name": name,
                                    "scope_id": s["id"], "asset": s["asset"],
                                    "asset_type": s["type"],
                                    "bounty": s["bounty"] and sub_state != "paused",
                                    "submission_state": sub_state,
                                    "max_severity": s["max_severity"]})
        if i % 10 == 0:
            CACHE.write_text(json.dumps(cache))
            print(f"  …{i}/{len(bounty)} programmes ({len(cache)} cached), {len(matches)} match(es)")
        time.sleep(0.4)
    CACHE.write_text(json.dumps(cache))

    uniq: dict[tuple[str, str], dict] = {}
    for m in matches:
        k = (m["host"], m["program"])
        if k not in uniq or len(m["asset"]) > len(uniq[k]["asset"]):
            uniq[k] = m
    rows = sorted(uniq.values(), key=lambda r: (not r["bounty"], r["program"], r["host"]))
    OUT.write_text(json.dumps(rows, indent=2) + "\n")

    paying = [r for r in rows if r["bounty"]]
    print(f"\n{len(rows)} host/programme matches — {len(paying)} on bounty-eligible scopes")
    for r in rows:
        flag = "PAYS" if r["bounty"] else ("PAUS" if r.get("submission_state") == "paused" else "    ")
        print(f"  {flag} {r['host']:<45} {r['program']:<28} {r['asset']}  scope={r['scope_id']}")
    print(f"\nwrote {OUT.relative_to(ROOT)} ({len(cache)} programmes cached in {CACHE.relative_to(ROOT)})")


if __name__ == "__main__":
    main()
