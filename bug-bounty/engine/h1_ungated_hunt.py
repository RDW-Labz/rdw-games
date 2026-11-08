#!/usr/bin/env python3
"""Find claims we can actually file on HackerOne today.

The account is Signal-gated with no trial reports left, so a programme with a Signal requirement is
a dead end no matter how good the bug is. What is left is programmes that accept submissions from
accounts at Signal zero. This script does the two halves of that test:

  1. verify — take every recorded finding whose hostname falls inside an H1 wildcard scope and whose
     target no longer answers, then confirm that on the wire right now;
  2. gate   — ask the report form of each surviving programme whether it blocks the account.

`verify` writes `engine/ungated_candidates.json`; `gate` fills in the verdict per programme from the
logged-in browser over CDP.
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
DB = HERE / "state.db"
OUT = HERE / "ungated_candidates.json"


def dns(target: str) -> tuple[str, int]:
    try:
        out = subprocess.run(["dig", "+noall", "+comments", "+answer", target, "A"],
                             capture_output=True, text=True, timeout=8).stdout
    except Exception:
        return ("ERR", 1)
    status = "?"
    for line in out.splitlines():
        if "status:" in line:
            status = line.split("status:")[1].split(",")[0].strip()
            break
    answers = [ln for ln in out.splitlines() if ln.strip() and not ln.startswith(";")]
    return (status, len(answers))


def scope_index(db) -> dict[str, dict]:
    idx: dict[str, dict] = {}
    for row in db.execute("select handle, asset, bounty from scopes where platform='h1' and asset like '*%'"):
        asset = (row["asset"] or "").lower()
        if not asset.startswith("*."):
            continue
        suffix = asset[2:].rstrip(".")
        if suffix:
            idx.setdefault(suffix, {"handle": row["handle"], "asset": row["asset"], "bounty": row["bounty"]})
    return idx


def match(host: str, idx: dict[str, dict]) -> dict | None:
    parts = host.split(".")
    for i in range(1, len(parts)):
        hit = idx.get(".".join(parts[i:]))
        if hit:
            return hit
    return None


def verify(limit_per_program: int = 25) -> dict:
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    idx = scope_index(db)
    by_program: dict[str, list[tuple[str, str]]] = defaultdict(list)
    seen = set()
    for row in db.execute("select host, target from findings"):
        host = (row["host"] or "").strip().lower().rstrip(".")
        target = (row["target"] or "").strip().lower().rstrip(".")
        if not host or "." not in host or "." not in target or host in seen:
            continue
        hit = match(host, idx)
        if not hit:
            continue
        seen.add(host)
        if len(by_program[hit["handle"]]) < limit_per_program:
            by_program[hit["handle"]].append((host, target))

    rows = [(h, host, target) for h, pairs in by_program.items() for host, target in pairs]
    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(lambda r: dns(r[2]), rows))

    alive: dict[str, list[dict]] = defaultdict(list)
    checked = defaultdict(int)
    for (handle, host, target), (status, n) in zip(rows, results):
        checked[handle] += 1
        if n == 0:
            alive[handle].append({"host": host, "target": target, "status": status})
    return {"checked": dict(checked), "dead": dict(alive)}


def gate(handles: list[str]) -> dict:
    """Load each programme's report form in the logged-in browser and read the blocking modal."""
    sys.path.insert(0, str(HERE.parent / "tools"))
    import h1_brave as B

    tab = B.Tab(target_id=B.first_page_id())
    verdict = {}
    for handle in handles:
        tab.goto(f"https://hackerone.com/{handle}/reports/new?type=team&report_type=vulnerability", wait=6)
        text = (tab.text(limit=2500) or "")
        # H1 words this two ways; match the stable fragment rather than the whole sentence.
        blocked = "enforces a Signal Requirement that you do not currently meet" in text
        trialfree = "No trial reports left" in text
        verdict[handle] = {"blocked": blocked, "no_trial_reports": trialfree,
                           "signal_hint": "Signal Required" in text}
        print(f"{handle:24} blocked={blocked} no_trials={trialfree}")
    return verdict


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "verify"
    if mode == "verify":
        data = verify()
        OUT.write_text(json.dumps(data, indent=1))
        dead = {h: v for h, v in data["dead"].items() if v}
        print(f"programmes with verified-dead in-scope hosts: {len(dead)}")
        for h, v in sorted(dead.items(), key=lambda kv: -len(kv[1])):
            print(f"{len(v):3} {h:24} e.g. {v[0]['host']} -> {v[0]['target']} ({v[0]['status']})")
    elif mode == "gate":
        data = json.loads(OUT.read_text())
        handles = [h for h, v in data["dead"].items() if v]
        handles = sorted(handles, key=lambda h: -len(data["dead"][h]))[:20]
        verdict = gate(handles)
        data["gate"] = verdict
        OUT.write_text(json.dumps(data, indent=1))
        open_ = [h for h, v in verdict.items() if not v["blocked"]]
        print(f"\nungated: {open_}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
