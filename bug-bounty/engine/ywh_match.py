#!/usr/bin/env python3
"""Cross-match claimable dangling records against YesWeHack scopes — by asset, never by domain.

The previous version matched on the registrable domain: any host ending in `teamviewer.com` counted as
"inside TeamViewer's programme". Every one of those programmes publishes the opposite rule in as many
words — TeamViewer lists three web hosts and adds *"All domains not listed In-Scope"* under
`out_of_scope`; Harman and VFS say the same. So the ten hosts this script used to report (dev-rc2/
dev-rc3/dev-rc5/console-datacollector on teamviewer.com, four myvoice hosts on harman.com, two on
tasheer.com) were all out of scope, and filing any of them would have been a rule violation, not a
bounty.

Matching is therefore exact: an in-scope entry covers a host only when it names that host or is a
wildcard the host sits under. YesWeHack writes some scopes as a grouped regex — `*.vfsglobal.(com|
co.uk|ca)` — so those are expanded rather than silently dropped. A host matching an explicit
`out_of_scope` entry is removed even when an in-scope wildcard would have reached it.

  python3 engine/ywh_match.py            # verified hits only
  python3 engine/ywh_match.py --all      # include records that no longer verify, with the reason
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from verify_finding import check  # noqa: E402

DATA = HERE / "data"
OUT = ROOT / "reports" / "ywh-matches.json"

IGNORE_PREFIX = ("device:", "mobile", "hardware", "other", "all domains", "all other")


def expand(asset: str) -> list[str]:
    """Scope entry -> the host patterns it really covers. Empty list = not a host rule."""
    a = (asset or "").strip().lower()
    if not a or a.startswith(IGNORE_PREFIX):
        return []
    a = re.sub(r"^[a-z][a-z0-9+.-]*://", "", a)
    a = a.split("/")[0].split("?")[0].split("#")[0].strip()
    a = a.replace(" ", "")
    if not a or "." not in a:
        return []
    # `*.vfsglobal.(com|co.uk|ca)` -> one pattern per alternative
    m = re.search(r"\(([^)]+)\)", a)
    if m:
        alts = [x.strip() for x in m.group(1).split("|") if x.strip()]
        head, tail = a[: m.start()], a[m.end():]
        return [f"{head}{x}{tail}" for x in alts]
    return [a.rstrip(".")]


def reaches(pattern: str, host: str) -> bool:
    host = host.lower().rstrip(".")
    if pattern.startswith("*."):
        root = pattern[2:]
        return bool(root) and (host == root or host.endswith("." + root))
    return host == pattern


def main() -> int:
    src = DATA / "yeswehack.json"
    if not src.exists():
        print("no engine/data/yeswehack.json — refresh the platform data first")
        return 1
    programs = json.loads(src.read_text())

    c = sqlite3.connect(HERE / "state.db")
    rows = c.execute("SELECT DISTINCT host, target, provider FROM findings WHERE claimable=1").fetchall()

    hits, seen = [], set()
    for host, target, provider in rows:
        for p in programs:
            if p.get("disabled") or not p.get("public"):
                continue
            slug = p.get("id") or p.get("name")
            ins = [pat for t in p.get("targets", {}).get("in_scope", []) for pat in expand(t.get("target"))]
            oos = [pat for t in p.get("targets", {}).get("out_of_scope", []) for pat in expand(t.get("target"))]
            if not any(reaches(pat, host) for pat in ins):
                continue
            if any(reaches(pat, host) for pat in oos):
                continue                     # explicit exclusion beats a wildcard
            if (host, slug) in seen:
                continue
            seen.add((host, slug))
            rc, msg = check(host, target)
            hits.append({"host": host, "target": target, "provider": provider,
                         "program": slug, "title": p.get("name"),
                         "grid_min": p.get("min_bounty"), "grid_max": p.get("max_bounty"),
                         "verified": rc, "evidence": msg})

    valid = [h for h in hits if h["verified"] == 0]
    keep = hits if "--all" in sys.argv else valid
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(keep, indent=1))

    print(f"{len(rows)} claimable hosts · {len(programs)} YWH programmes · "
          f"{len(hits)} asset-level matches · {len(valid)} verified live")
    for h in keep:
        flag = "OK " if h["verified"] == 0 else "?? "
        print(f"  [{flag}] {h['host']:<45} {h['program']:<45} via asset scope")
    print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
