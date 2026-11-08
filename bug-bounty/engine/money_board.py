#!/usr/bin/env python3
"""Rank every claimable finding by whether anyone can actually be paid for it.

Discovery was never the constraint. Two reports filed 2026-11-03 (GitHub 4168910, Starbucks 4169021) both
closed `informative`, and the names still claimable in `reports/azure-available.json` all sit in
`bounty=False` VDPs — CBRE and Aon pay $0 for takeover, so a perfect proof there buys a thank-you.

This pass answers one question per finding: *who pays, is the name still free, and does the victim still
point at it?*

Attribution is `scope_cover.covers()` — the asset is the host, or a wildcard the host sits under. Joining
on the registrable apex instead (the old behaviour) counted any host under a domain with *any* in-scope
asset: `blog.luva.bet.br` inherited Superbet's `superbet.bet.br` listing and looked payable when nothing
covers it. A shared apex is not a scope.

  .venv/bin/python engine/money_board.py [--json reports/money-board.json] [--no-azure]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine" / "state.db"
SUB = "d21b2b11-a93f-47f7-a5eb-d1d9dd2e74a9"
sys.path.insert(0, str(ROOT / "engine"))


def dig(*args: str) -> str:
    try:
        out = subprocess.run(["dig", "+short", "+time=3", "+tries=2", *args],
                             capture_output=True, text=True, timeout=12).stdout
        return out.strip().splitlines()[0].rstrip(".").lower() if out.strip() else ""
    except Exception:
        return ""


def azure_available(token: str, label: str) -> bool | None:
    sys.path.insert(0, str(ROOT / "engine"))
    import azure_arm as aa
    code, res = aa.arm(token, "POST",
                       f"/subscriptions/{SUB}/providers/Microsoft.Web/checkNameAvailability?api-version=2022-03-01",
                       {"name": label, "type": "Microsoft.Web/sites"})
    if code != 200:
        return None
    return bool(res.get("nameAvailable"))


def load() -> tuple[list[dict], list[dict], dict]:
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    cur = db.execute("select host, target, provider, claim from findings where claimable = 1 "
                     "group by host, target order by host")
    finds = [{"host": r[0], "target": r[1], "provider": r[2], "claim": r[3]} for r in cur.fetchall()]
    scopes = [{"platform": r[0], "handle": r[1], "asset": r[2], "bounty": r[3]}
              for r in db.execute("select platform, handle, asset, bounty from scopes")]
    progs = {}
    for plat, handle, name, offers, mx in db.execute(
            "select platform, handle, name, offers_bounty, max_bounty from programs"):
        progs[(plat, handle)] = {"name": name, "offers": offers, "max_bounty": mx}
    return finds, scopes, progs


def attribute(host: str, scopes: list[dict]) -> dict:
    """Best scope covering this host: exact beats wildcard; paying beats a VDP at the same rank."""
    from scope_cover import covers
    best = None
    for s in scopes:
        kind = covers(s["asset"], host)
        if not kind:
            continue
        rank = (kind != "exact", not s["bounty"])
        if best is None or rank < best[0]:
            best = (rank, s, kind)
    if best is None:
        return {"platform": "", "handle": "", "asset": "", "bounty": 0, "match": ""}
    _, s, kind = best
    return {**s, "match": kind}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="")
    ap.add_argument("--no-azure", action="store_true", help="skip the availability API (offline ranking)")
    a = ap.parse_args()

    token = ""
    if not a.no_azure:
        sys.path.insert(0, str(ROOT / "engine"))
        try:
            import azure_web_claim as awc
            token = awc.token()
        except Exception as e:  # noqa: BLE001
            print(f"warning: no Azure token ({type(e).__name__}) — availability unchecked\n")

    finds, scopes, progs = load()
    out, cache = [], {}
    for f in finds:
        target = (f["target"] or "").lower().rstrip(".")
        cname_live = bool(target) and dig("CNAME", f["host"]) == target
        label = target.split(".")[0]
        avail = None
        if token and "azurewebsites.net" in target:
            if label not in cache:
                cache[label] = azure_available(token, label)
            avail = cache[label]
        att = attribute(f["host"], scopes)
        prog = progs.get((att["platform"], att["handle"])) or {}
        pays = bool(att["bounty"]) and bool(prog.get("offers", True))
        mx = prog.get("max_bounty") or 0
        if not att["match"]:
            verdict = "out-of-scope"
        elif not pays:
            verdict = "no-money"
        elif avail is False:
            verdict = "name-taken"
        elif not cname_live:
            verdict = "cname-dead"
        else:
            verdict = "PAYABLE" if avail is not False else "verify"
        out.append({**f, **att, "label": label, "cname_live": cname_live, "available": avail,
                    "pays": pays, "max_bounty": mx, "program": prog.get("name", ""), "verdict": verdict})

    order = {"PAYABLE": 0, "verify": 1, "cname-dead": 2, "name-taken": 3, "no-money": 4, "out-of-scope": 5}
    out.sort(key=lambda x: (order[x["verdict"]], -float(x["max_bounty"] or 0), x["host"]))
    for r in out:
        plat = r["platform"] or "-"
        handle = (r["handle"] or "-")[:16]
        print(f"{r['verdict']:12} {r['host'][:42]:42} {r['label'][:26]:26} "
              f"pays={int(r['pays'])} avail={r['available']} live={int(bool(r['cname_live']))} "
              f"{plat:3}:{handle:16} max={str(r['max_bounty'] or '-'):>6} via={r['match'] or '-':8}")

    tally: dict[str, int] = {}
    for r in out:
        tally[r["verdict"]] = tally.get(r["verdict"], 0) + 1
    print("\n" + "  ".join(f"{k}={v}" for k, v in sorted(tally.items())))
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=1))
        print(f"wrote {a.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
