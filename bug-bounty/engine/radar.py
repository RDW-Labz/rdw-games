#!/usr/bin/env python3
"""Radar: watch the programme directories and flag the ones that just became filable.

Three public feeds are enough to notice opportunity without any API token — HackerOne open programmes
(`h1_open_programs.json`, refreshed by h1_targets.py), Bugcrowd's engagement directory
(`bc_engagements.json`, refreshed by bc_public.py) and YesWeHack's public programme list. This keeps a
snapshot, diffs it, and for every *new* programme asks the question that matters: do we already hold a
claimable finding inside its scope? A takeover found last month becomes payable the day a programme
publishes that domain.

  python3 engine/radar.py            # diff against the last snapshot, print new programmes + any hits
  python3 engine/radar.py --reset    # rebuild the baseline without reporting
"""
from __future__ import annotations

import json
import sqlite3
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "engine" / "data"
SNAP = DATA / "radar_snapshot.json"


def host_of(asset: str) -> str:
    a = (asset or "").strip().lower().split("://", 1)[-1]
    a = a.split("/", 1)[0].split(":", 1)[0].strip(".")
    return a


def hit(host: str, asset: str) -> bool:
    a = host_of(asset)
    if len(a.strip("*.")) < 3:
        return False
    if a.startswith("*."):
        b = a[2:]
        return host == b or host.endswith("." + b)
    return host == a or host.endswith("." + a)


def ywh_programmes() -> dict[str, dict]:
    out: dict[str, dict] = {}
    page = 1
    while True:
        try:
            req = urllib.request.Request(f"https://api.yeswehack.com/programs?page={page}",
                                         headers={"Accept": "application/json", "User-Agent": "rdwlabz-radar"})
            with urllib.request.urlopen(req, timeout=25) as r:
                d = json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            print(f"  ! yeswehack page {page}: {e}")
            break
        items = d.get("items") or []
        for p in items:
            if p.get("slug"):
                out[f"yw:{p['slug']}"] = {"platform": "yw", "handle": p["slug"],
                                          "name": p.get("title"), "bounty": bool(p.get("bounty")),
                                          "url": f"https://yeswehack.com/programs/{p['slug']}"}
        if page >= ((d.get("pagination") or {}).get("nb_pages") or 1) or not items:
            break
        page += 1
    return out


def main() -> None:
    current: dict[str, dict] = {}

    f = DATA / "h1_open_programs.json"
    if f.exists():
        for p in json.loads(f.read_text()).get("open_programs", []):
            h = (p.get("handle") or "").strip()
            if h:
                current[f"h1:{h}"] = {"platform": "h1", "handle": h, "name": p.get("name"),
                                      "bounty": bool(p.get("bounties")),
                                      "url": f"https://hackerone.com/{h}"}

    f = DATA / "bc_engagements.json"
    if f.exists():
        for e in json.loads(f.read_text()).get("engagements", []):
            s = (e.get("slug") or "").strip()
            if s:
                current[f"bc:{s}"] = {"platform": "bc", "handle": s, "name": e.get("name"),
                                      "bounty": (e.get("max_reward") or 0) > 0, "url": e.get("url")}

    current |= ywh_programmes()

    prev = json.loads(SNAP.read_text()) if SNAP.exists() else {}
    new = {k: v for k, v in current.items() if k not in prev}
    gone = [k for k in prev if k not in current]
    SNAP.write_text(json.dumps(current, indent=2) + "\n")

    print(f"{len(current)} programmes watched · {len(new)} new · {len(gone)} delisted"
          f"{' (baseline reset)' if '--reset' in sys.argv else ''}")
    if "--reset" in sys.argv or not prev:
        return

    db = sqlite3.connect(f"file:{ROOT / 'engine' / 'state.db'}?mode=ro", uri=True)
    hosts = [r[0] for r in db.execute("select host from findings where claimable=1")]
    for k, v in sorted(new.items(), key=lambda kv: not kv[1]["bounty"]):
        assets = []
        if v["platform"] in ("bc", "h1", "yw"):
            assets = [r[0] for r in db.execute(
                "select asset from scopes where platform=? and handle=?", (v["platform"], v["handle"]))]
        hits = sorted({h for h in hosts for a in assets if hit(h, a)})
        tag = "PAYS" if v["bounty"] else "    "
        print(f"  {tag} {k:<34} {(v['name'] or '')[:38]:<38} {len(assets):>4} assets"
              f"{'  <== MATCHES ' + ', '.join(hits[:3]) if hits else ''}")


if __name__ == "__main__":
    main()
