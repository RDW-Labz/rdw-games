#!/usr/bin/env python3
"""Refresh the scrape inputs in .queue/ — the half of the pipeline that used to be manual.

Before this script the daily job could only re-rank whatever inputs were already on disk
(the .queue/raw-*.json and fdroid-games.json files dated 2026-11-01). Now it fetches them:

  1. F-Droid   https://f-droid.org/repo/index-v1.json (~75 MB) -> every app in a game
               category whose sourceCode points at github/gitlab/codeberg/git.sr.ht.
               Written as .queue/fdroid-games.json, keyed by forge repo:
                 {repo: {pid, name, lic, src, summary, updated, cats}}
               (byte-compatible with the file build-queue.py already consumes)
  2. GitHub    search/repositories sweeps -> .queue/raw-NN.json, each the verbatim API
               response ({"total_count","incomplete_results","items"}), so the filters in
               build-queue.py see exactly the fields they were written against.

No filtering decisions live here — fetching is fetching. build-queue.py owns every rule
(NON_GAME, GENRE_TOPICS, the 800-star floor, license requirement, ranking).

Usage: scripts/fetch-sources.py [--fdroid-only|--github-only] [--github-max N]
Exit code is non-zero only if BOTH sources failed; a single failed source keeps its
previous cached inputs so the queue still builds.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUEUE = os.path.join(ROOT, ".queue")
INDEX = os.path.join(QUEUE, "fdroid-index-v1.json")
FDROID_OUT = os.path.join(QUEUE, "fdroid-games.json")

FDROID_INDEX_URL = "https://f-droid.org/repo/index-v1.json"

# F-Droid leaf categories that mean "this is a game a phone can play". Game Helper covers
# timers/scorekeepers/companions (chess clocks, board-game assistants) — the previous manual
# sweep included them, so they stay in for parity. Dice and Emulator are deliberately
# separate calls: dice-rollers are game pieces, emulators are excluded (they run games they
# don't contain).
GAME_CATS = {
    "Action Game", "Board Game", "Card Game", "Casual Game", "Dice",
    "Educational Game", "Game Helper", "Party Game", "Platformer Game", "Puzzle Game",
    "Role-Playing Game", "Shooter Game", "Sport Game", "Strategy Game",
    "Visual Novel", "Word Game",
}

FORGE = re.compile(
    r"(github\.com|gitlab\.com|codeberg\.org|git\.sr\.ht)/([\w.\-]+)/([\w.\-]+?)(?:\.git)?/?$"
)

# One query per genre topic plus two broad ones. Top 100 by stars each; build-queue.py
# then applies its own floor and genre-topic test.
QUERIES = [
    "topic:game",
    "topic:games",
    "topic:android-game",
    "topic:android",
    "topic:roguelike",
    "topic:roguelite",
    "topic:rpg-game",
    "topic:strategy-game",
    "topic:puzzle-game",
    "topic:tower-defense",
    "topic:platformer",
    "topic:metroidvania",
    "topic:shooter-game",
    "topic:card-game",
    "topic:board-game",
    "topic:sandbox-game",
    "topic:survival-game",
    "topic:arcade-game",
    "topic:fps-game",
    "topic:open-world",
    "topic:game-2d",
    "topic:game-3d",
    "game in:name",
    "offline game in:description",
]


def forge_repo(url: str) -> str | None:
    m = FORGE.search((url or "").strip())
    return f"{m.group(2)}/{m.group(3)}".lower() if m else None


def en(loc: dict, key: str) -> str:
    for tag in ("en-US", "en-GB", "en"):
        v = (loc.get(tag) or {}).get(key)
        if v:
            return v
    return ""


def fetch_fdroid() -> int:
    """Download the index and rewrite .queue/fdroid-games.json. Returns entry count."""
    tmp = INDEX + ".part"
    fresh = os.path.exists(INDEX) and (time.time() - os.path.getmtime(INDEX)) < 20 * 3600
    if fresh and "--force-download" not in sys.argv:
        print(f"fdroid: reusing index cached {time.strftime('%Y-%m-%d %H:%M', time.localtime(os.path.getmtime(INDEX)))} "
              f"({os.path.getsize(INDEX) // 1_000_000} MB)", flush=True)
    else:
        print(f"fdroid: downloading {FDROID_INDEX_URL} …", flush=True)
        rc = subprocess.run(
            ["curl", "-sS", "-m", "900", "--retry", "3", "--retry-delay", "5",
             "-o", tmp, FDROID_INDEX_URL]
        ).returncode
        if rc != 0 or not os.path.exists(tmp) or os.path.getsize(tmp) < 10_000_000:
            raise RuntimeError(f"index download failed (rc={rc})")
        os.replace(tmp, INDEX)

    with open(INDEX) as f:
        idx = json.load(f)

    out: dict[str, dict] = {}
    for a in idx.get("apps", []):
        cats = a.get("categories") or []
        if not (set(cats) & GAME_CATS):
            continue
        repo = forge_repo(a.get("sourceCode") or "")
        if not repo:
            continue
        loc = a.get("localized") or {}
        entry = dict(
            pid=a.get("packageName") or "",
            name=en(loc, "name") or (a.get("packageName") or repo),
            lic=a.get("license") or "",
            src=(a.get("sourceCode") or "").strip(),
            summary=en(loc, "summary") or "",
            updated=a.get("lastUpdated") or 0,
            cats=cats,
        )
        prev = out.get(repo)
        # same repo listed under several packages: keep the most recently updated
        if prev is None or entry["updated"] > prev["updated"]:
            out[repo] = entry

    write_atomic(FDROID_OUT, json.dumps(out, indent=1))
    print(f"fdroid: {len(out)} game repos from {len(idx.get('apps', []))} apps", flush=True)
    return len(out)


def fetch_github(max_queries: int | None = None) -> int:
    """Run the search sweeps; each response lands verbatim in .queue/raw-NN.json."""
    qs = QUERIES[:max_queries] if max_queries else QUERIES
    ok = 0
    total_items = 0
    for i, q in enumerate(qs, 1):
        url = (
            "search/repositories?q=" + q.replace(" ", "+").replace(":", "%3A").replace(">", "%3E")
            + "&sort=stars&order=desc&per_page=100"
        )
        p = subprocess.run(["gh", "api", url], capture_output=True, text=True, timeout=120)
        if p.returncode != 0:
            err = (p.stderr or "").strip().splitlines()
            print(f"github[{i}/{len(qs)}] {q!r}: FAILED {err[-1] if err else p.returncode}", flush=True)
            time.sleep(3)
            continue
        try:
            data = json.loads(p.stdout)
        except Exception:
            print(f"github[{i}/{len(qs)}] {q!r}: unparseable response", flush=True)
            continue
        items = data.get("items") or []
        write_atomic(os.path.join(QUEUE, f"raw-{i}.json"), p.stdout)
        ok += 1
        total_items += len(items)
        print(f"github[{i}/{len(qs)}] {q!r}: {len(items)} items", flush=True)
        time.sleep(2.5)  # search API allows 30 req/min authenticated
    # sweeps that vanished (query list shrank) must not linger as stale inputs
    for j in range(len(qs) + 1, 100):
        stale = os.path.join(QUEUE, f"raw-{j}.json")
        if os.path.exists(stale):
            os.remove(stale)
    print(f"github: {ok}/{len(qs)} queries ok, {total_items} items", flush=True)
    return ok


def write_atomic(path: str, text: str) -> None:
    tmp = path + ".part"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def main() -> int:
    os.makedirs(QUEUE, exist_ok=True)
    args = sys.argv[1:]
    max_q = None
    if "--github-max" in args:
        max_q = int(args[args.index("--github-max") + 1])
    want_fd = "--github-only" not in args
    want_gh = "--fdroid-only" not in args
    results = {}

    if want_fd:
        try:
            results["fdroid"] = fetch_fdroid()
        except Exception as e:  # noqa: BLE001
            print(f"WARN fdroid fetch failed, keeping cached fdroid-games.json: {e}", flush=True)
            results["fdroid"] = -1
    if want_gh:
        try:
            results["github"] = fetch_github(max_q)
        except Exception as e:  # noqa: BLE001
            print(f"WARN github sweep failed, keeping cached raw-*.json: {e}", flush=True)
            results["github"] = -1

    hard_fail = all(v < 0 for v in results.values()) if results else True
    print("sources: " + ", ".join(f"{k}={v}" for k, v in results.items()), flush=True)
    return 1 if hard_fail else 0


if __name__ == "__main__":
    sys.exit(main())
