#!/usr/bin/env python3
"""Does any published scope actually cover each claimable host?

The old gate matched on a two-label suffix, so `www.cbn.com.bo` was grouped under a "domain" called
`com.bo` and inherited whatever programme happened to list `www.visa.com.bo` — a scope that has
nothing to do with CBN. Filing that report would have been an out-of-scope submission against Visa
and MercadoLibre, which is the sort of thing that ends an account. So coverage is decided here by the
only rule that matters to a triager: the asset is the host, or a wildcard the host sits under.

  python3 engine/scope_cover.py            # table of host -> programme, exact/wildcard only
  python3 engine/scope_cover.py --json     # machine-readable, for the queue
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine" / "state.db"


def host_of(asset: str) -> str:
    """Asset text -> bare hostname. Assets arrive as URLs, with paths, ports or stray schemes."""
    a = (asset or "").strip().lower()
    if "://" in a:
        try:
            a = urllib.parse.urlsplit(a).hostname or ""
        except ValueError:
            return ""          # bracket-oddity in the corpus; nothing to match against
    else:
        a = a.split("/")[0].split(":")[0]
    return a.rstrip(".")


def covers(asset: str, host: str) -> str | None:
    """'exact' / 'wildcard' when the asset reaches the host, else None. No suffix guessing."""
    a = host_of(asset)
    h = host.lower().rstrip(".")
    if not a:
        return None
    if a == h:
        return "exact"
    if a.startswith("*."):
        base = a[2:]
        if h.endswith("." + base):
            return "wildcard"
    return None


def load_state() -> dict:
    p = ROOT / "engine" / "data" / "h1_program_state.json"
    if not p.exists():
        return {}
    d = json.loads(p.read_text())
    return d.get("programs", {})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    hosts = c.execute("SELECT host, target, provider FROM findings WHERE claimable=1").fetchall()
    scopes = c.execute("SELECT platform, handle, asset, asset_type, bounty FROM scopes").fetchall()
    state = load_state()

    hits = []
    for host, target, provider in hosts:
        for platform, handle, asset, atype, bounty in scopes:
            how = covers(asset, host)
            if not how:
                continue
            st = state.get(handle, {}) if platform == "h1" else {}
            hits.append({
                "host": host,
                "target": target,
                "provider": provider,
                "platform": platform,
                "handle": handle,
                "asset": asset,
                "asset_type": atype,
                "match": how,
                "bounty": bool(bounty),
                "submission_state": st.get("submission_state"),
                "max_bounty": None,
            })

    # one row per host+programme: prefer an exact match, then a wildcard
    best: dict[tuple, dict] = {}
    for h in hits:
        k = (h["host"], h["platform"], h["handle"])
        cur = best.get(k)
        if cur is None or (cur["match"] == "wildcard" and h["match"] == "exact"):
            best[k] = h
    rows = sorted(best.values(), key=lambda r: (r["platform"], r["handle"], r["host"]))

    if a.json:
        print(json.dumps(rows, indent=1))
        return

    if not rows:
        print("no claimable host sits inside any published scope")
        return
    cur_key = None
    for r in rows:
        k = (r["platform"], r["handle"])
        if k != cur_key:
            st = r["submission_state"] or "-"
            print(f"\n{r['platform']}:{r['handle']}  (state={st}, bounty={r['bounty']})")
            cur_key = k
        print(f"   {r['match']:8} {r['host']:52} via {r['asset']}")
    print(f"\n{len(rows)} host/programme pair(s) with real coverage")


if __name__ == "__main__":
    main()
