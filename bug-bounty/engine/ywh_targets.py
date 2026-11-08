#!/usr/bin/env python3
"""Pull every public YesWeHack programme *with its scopes* — no API token needed.

`api.yeswehack.com/programs` is public, and so is `api.yeswehack.com/programs/<slug>` (only
`/scopes` is JWT-gated, and the detail endpoint already embeds the same list). Each programme detail
carries `scopes[]` with `asset_value` / `scope_type`, plus the reward grid and `type` — so this yields a
bounty-eligible target corpus instead of guesses.

  python3 engine/ywh_targets.py              # write engine/data/ywh_domains.txt + ywh_programs.json
  python3 engine/ywh_targets.py --seed 120   # also insert the first N new domains into state.db
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from h1_targets import registrable  # noqa: E402

import urllib.request  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "engine" / "data"
OUT = DATA / "ywh_domains.txt"
STATE = DATA / "ywh_programs.json"
API = "https://api.yeswehack.com"


def get_json(url: str, tries: int = 4) -> dict:
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json",
                                                       "User-Agent": "rdwlabz-recon/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            if attempt == tries - 1:
                print(f"  ! {url} -> {e}")
                return {}
            time.sleep(2 * (attempt + 1))
    return {}


def main() -> None:
    seed = 0
    if "--seed" in sys.argv:
        seed = int(sys.argv[sys.argv.index("--seed") + 1])

    programs: list[dict] = []
    page = 1
    while True:
        d = get_json(f"{API}/programs?page={page}")
        items = d.get("items") or []
        programs += items
        nb = (d.get("pagination") or {}).get("nb_pages") or 1
        if page >= nb or not items:
            break
        page += 1
        time.sleep(0.5)
    print(f"{len(programs)} public YesWeHack programmes")

    keep, domains = [], {}
    for i, p in enumerate(programs, 1):
        slug = p.get("slug")
        if not slug or p.get("archived") or p.get("disabled"):
            continue
        if p.get("type") != "bug-bounty" or not p.get("bounty"):
            continue
        det = get_json(f"{API}/programs/{slug}")
        scopes = det.get("scopes") or []
        if not scopes:
            continue
        keep.append({"slug": slug, "title": p.get("title"), "min": p.get("bounty_reward_min"),
                     "max": p.get("bounty_reward_max"), "scopes": len(scopes),
                     "first_response_days": p.get("average_first_response_time")})
        for s in scopes:
            # `asset_value` is the reward tier ("CRITICAL"); the host lives in `scope`
            asset = (s.get("scope") or "").strip()
            if not asset:
                continue
            host = asset.lstrip("*.").split("://")[-1].split("/")[0].split(":")[0]
            if not host or not host.rsplit(".", 1)[-1].isalpha():
                continue
            try:
                d2 = registrable(host)
            except ValueError:  # oddities like IPv6 literals in a scope list
                continue
            if d2.count(".") < 1:
                continue
            domains.setdefault(d2, []).append(slug)
        if i % 10 == 0:
            print(f"  …{i}/{len(programs)}")
        time.sleep(0.4)

    DATA.mkdir(parents=True, exist_ok=True)
    OUT.write_text("".join(f"{d}\n" for d in sorted(domains)))
    STATE.write_text(json.dumps({"programs": keep, "domains": {k: sorted(set(v)) for k, v in domains.items()}},
                                indent=2) + "\n")
    print(f"{len(keep)} bounty programmes with scopes · {len(domains)} unique domains -> {OUT.relative_to(ROOT)}")

    if seed:
        db = sqlite3.connect(ROOT / "engine" / "state.db")
        have = {r[0] for r in db.execute("select domain from domains")}
        added = 0
        for d in sorted(domains):
            if d in have:
                continue
            slug = sorted(set(domains[d]))[0]
            db.execute("insert into domains(domain, org, policy, contact, tier, last_enum) "
                       "values(?,?,?,?,?,NULL)",
                       (d, slug, f"https://yeswehack.com/programs/{slug}", "", "bounty:ywh"))
            added += 1
            if added >= seed:
                break
        db.commit()
        print(f"seeded {added} new domain(s) into state.db (tier bounty:ywh)")


if __name__ == "__main__":
    main()
