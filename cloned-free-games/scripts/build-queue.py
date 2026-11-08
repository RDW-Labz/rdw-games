#!/usr/bin/env python3
"""Build GAMES.queue — the clone work-list that scripts/queue-fetch.sh walks.

Sources (all already gathered into .queue/ by hand or by an earlier run):
  .queue/raw-*.json       GitHub search sweeps (topic:game, topic:android-game, ...)
  .queue/fdroid-games.json  every F-Droid package in a Games category that points at a
                            github/gitlab/codeberg/git.sr.ht source repo (real phone games,
                            with a declared license — 464 of them)
  ~/crg/candidates.json   the original curated shortlist

Output: GAMES.queue, tab separated:
  name \t url \t stars \t license \t est_size_kb \t source \t summary

Ranking puts genuine mobile games first (F-Droid + touch/android topics), then by stars.
Engines, frameworks, asset packs, curated lists and emulators are excluded — the queue is
for games a phone can actually play. Already-cloned repos (GAMES.lock / games/) are skipped.

Usage: scripts/build-queue.py [--refresh-stars]     (--refresh-stars hits the GitHub API)
"""
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUEUE_DIR = os.path.join(ROOT, ".queue")
OUT = os.path.join(ROOT, "GAMES.queue")

# Repo-name / description markers that mean "not a game".
NON_GAME = re.compile(
    r"(engine|framework|librar|awesome|curated list|\blist\b|tutorial|course|template|"
    r"boilerplate|starter kit|\bsdk\b|emulator|launcher|mod ?manager|editor\b|toolkit|"
    r"benchmark|dataset|reference|plugin|extension|security|fixes|cheat ?sheet|"
    r"game ?dev studio|for making|create, share|asset pack|sound pack|texture pack)",
    re.I,
)
GAMEISH = re.compile(
    r"(game|roguelike|\brpg\b|shooter|platformer|strategy|puzzle|racing|\bmmo\b|\brts\b|"
    r"metroidvania|\bfps\b|sandbox|survival|tower defen[cs]e|\bcard\b|arcade|adventure|"
    r"simulator|tycoon|dungeon|chess|mahjong|solitaire|sudoku|board game|pinball|"
    r"space|galaxy|empire|war\b|battle|tactics)",
    re.I,
)
MOBILE = re.compile(r"(android|ios\b|iphone|ipad|mobile|touch|apk|phone|f-droid|fdroid)", re.I)

# Hard exclusions: famous engines/frameworks that would otherwise match GAMEISH.
DENY_REPOS = {
    "godotengine/godot", "bevyengine/bevy", "libgdx/libgdx", "raysan5/raylib",
    "phaserjs/phaser", "pixijs/pixijs", "babylonjs/babylon.js", "aframevr/aframe",
    "ocornut/imgui", "emilk/egui", "4ian/gdevelop", "kitao/pyxel", "almasb/fxgl",
    "scottcgi/mojoc", "dkhamsing/open-source-ios-apps", "leereilly/games",
    "ellisonleao/magictools", "quiterss/quiterss", "godotengine/godot-demo-projects",
    "niklasei/bevy_game_template", "utopia-rise/godot-jvm", "marcofaziorandom/virtual-joystick-godot",
    "you-dont-need/you-dont-need-javascript", "aritraroy/ultimateandroidreference",
    "gmh5225/awesome-game-security", "thirteenag/widescreenfixespak",
    "thirteenag/widescreenfixespack", "aschearer/unitysizeexplorer",
    "airtestproject/airtest", "xtremilicious/projectlearn-project-based-learning",
    "comicsparks/pikapika", "ring-lang/ring",
}



# Hand-picked open-source games worth cloning even if they never show up in an F-Droid
# listing: deep, mobile-capable or portable, and the kind of thing this index exists for.
CURATED = [
    ("Cataclysm-DDA", "https://github.com/CleverRaven/Cataclysm-DDA.git"),
    ("Cataclysm-BN", "https://github.com/cataclysmbnteam/Cataclysm-BN.git"),
    ("DevilutionX", "https://github.com/diasurgical/devilutionX.git"),
    ("OpenMW", "https://github.com/OpenMW/openmw.git"),
    ("supertux", "https://github.com/SuperTux/supertux.git"),
    ("freedroidrpg", "https://github.com/freedroid/freedroid-src.git"),
    ("OpenDungeons", "https://github.com/OpenDungeons/OpenDungeons.git"),
    ("naev", "https://github.com/naev/naev.git"),
    ("pioneer", "https://github.com/pioneerspacesim/pioneer.git"),
    ("megaglest", "https://github.com/megaglest/megaglest-source.git"),
    ("openclonk", "https://github.com/openclonk/openclonk.git"),
    ("unknown-horizons", "https://github.com/unknown-horizons/unknown-horizons.git"),
    ("wargus", "https://github.com/Wargus/wargus.git"),
    ("dxx-rebirth", "https://github.com/dxx-rebirth/dxx-rebirth.git"),
    ("vkQuake", "https://github.com/Novum/vkQuake.git"),
    ("gzdoom", "https://github.com/ZDoom/gzdoom.git"),
    ("ioquake3", "https://github.com/ioquake/ioquake3.git"),
    ("OpenJK", "https://github.com/JACoders/OpenJK.git"),
    ("sauerbraten", "https://github.com/assaultcube/sauerbraten.git"),
    ("xonotic", "https://github.com/xonotic/xonotic.git"),
    ("Red-Eclipse", "https://github.com/redeclipse/base.git"),
    ("teeworlds", "https://github.com/teeworlds/teeworlds.git"),
    ("assaultcube", "https://github.com/assaultcube/AC.git"),
    ("OpenArena", "https://github.com/OpenArena/engine.git"),
    ("freedoom", "https://github.com/freedoom/freedoom.git"),
    ("speed-dreams", "https://github.com/speed-dreams/speed-dreams-code.git"),
    ("openblack", "https://github.com/openblack/openblack.git"),
    ("Anuto-TD", "https://github.com/mjaun/android-anuto.git"),
    ("TheXTech", "https://github.com/Wohlstand/TheXTech.git"),
    ("Pixel-Wheels", "https://github.com/agateau/pixelwheels.git"),
    ("HyperRogue", "https://github.com/zenorogue/hyperrogue.git"),
    ("OpenSurge", "https://github.com/alemart/opensurge.git"),
    ("VCMI", "https://github.com/vcmi/vcmi.git"),
    ("Principia", "https://github.com/Bithack/principia.git"),
    ("Destination-Sol", "https://github.com/MovingBlocks/DestinationSol.git"),
    ("minetest_game", "https://github.com/minetest/minetest_game.git"),
    ("Unvanquished", "https://github.com/Unvanquished/Unvanquished.git"),
    ("openspades", "https://github.com/yvt/openspades.git"),
    ("OpenRCT2-objects", "https://github.com/OpenRCT2/objects.git"),
    ("bar", "https://github.com/beyond-all-reason/Beyond-All-Reason.git"),
]

GENRE_TOPICS = {
    "game", "games", "videogame", "video-game", "gamedev-game", "roguelike", "roguelite", "rpg",
    "strategy-game", "platformer", "puzzle-game", "tower-defense", "shooter", "shooter-game",
    "racing-game", "sandbox-game", "arcade-game", "metroidvania", "survival-game", "mmorpg",
    "open-world", "fps-game", "card-game", "board-game", "dungeon-crawler", "game-2d", "game-3d",
}

QUALITY_HIGH = re.compile(
    r"(roguelike|roguelite|\brpg\b|strategy|4x\b|tower defen[cs]e|sandbox|open.world|\bmmo\b|"
    r"adventure|platformer|racing|shooter|survival|simulat|tycoon|pinball|metroidvania|voxel|"
    r"dungeon crawl|action rpg|\brts\b|grand strategy|space sim|city.?build)",
    re.I,
)
# Small-scope or non-game entries: allowed in the queue only at the bottom, and dropped
# entirely when nothing else about them says "game with depth".
QUALITY_LOW = re.compile(
    r"(sudoku|solitaire|mahjong|minesweeper|nonogram|word (search|game|puzzle)|crossword|"
    r"brain train|math|calculator|flashcard|quiz|learn |study|planner|companion|guide|"
    r"tracker|client|launcher|utility|easter egg|rom|patch|wallpaper|icon pack|"
    r"theme|widget|keyboard|clock|calculator|\bclient\b)",
    re.I,
)

def forge_repo(url: str) -> str | None:
    u = (url or "").strip().rstrip("/")
    m = re.search(
        r"(github\.com|gitlab\.com|codeberg\.org|git\.sr\.ht)/([\w.\-]+)/([\w.\-]+?)(?:\.git)?$",
        u,
    )
    return f"{m.group(2)}/{m.group(3)}".lower() if m else None


def locked_repos() -> set[str]:
    out = set()
    try:
        for line in open(os.path.join(ROOT, "GAMES.lock")):
            m = re.search(r"github\.com[:/]([\w.\-]+/[\w.\-]+?)(?:\.git)?(?:\s|$)", line)
            if m:
                out.add(m.group(1).lower())
    except FileNotFoundError:
        pass
    return out


def onboard() -> set[str]:
    p = os.path.join(ROOT, "games")
    return {d.lower() for d in os.listdir(p)} if os.path.isdir(p) else set()


def gh_token() -> str:
    try:
        return subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:
        return ""


def graphql_stars(repos: list[str], token: str, chunk: int = 40) -> dict:
    """Batch-resolve stars/license/size for github repos. Best effort: no token -> {}."""
    if not token:
        return {}
    meta: dict = {}
    for i in range(0, len(repos), chunk):
        batch = repos[i : i + chunk]
        parts = []
        for n, r in enumerate(batch):
            if "/" not in r:
                continue
            owner, name = r.split("/", 1)
            parts.append(
                f'r{n}: repository(owner: "{owner}", name: "{name}") '
                "{ stargazerCount licenseInfo { spdxId } isArchived diskUsage }"
            )
        q = "query{" + " ".join(parts) + "}"
        try:
            p = subprocess.run(
                ["curl", "-s", "-m", "30", "-X", "POST", "-H", f"Authorization: token {token}",
                 "-H", "Content-Type: application/json",
                 "-d", json.dumps({"query": q}), "https://api.github.com/graphql"],
                capture_output=True, text=True, timeout=40,
            )
            data = json.loads(p.stdout or "{}").get("data") or {}
        except Exception:
            continue
        for n, r in enumerate(batch):
            d = data.get(f"r{n}")
            if not d:
                continue
            meta[r] = dict(
                stars=d.get("stargazerCount") or 0,
                lic=(d.get("licenseInfo") or {}).get("spdxId") or "",
                archived=d.get("isArchived") or False,
                size_kb=d.get("diskUsage") or 0,
            )
    return meta


def main() -> int:
    skip = locked_repos() | onboard()
    cands: dict[str, dict] = {}

    # 1. F-Droid games — the strongest "real phone game" signal.
    fd_path = os.path.join(QUEUE_DIR, "fdroid-games.json")
    if os.path.exists(fd_path):
        for repo, g in json.load(open(fd_path)).items():
            if repo in skip:
                continue
            cands[repo] = dict(
                repo=repo, name=g.get("name") or repo.split("/")[1], url=g.get("src"),
                lic=g.get("lic") or "", summary=(g.get("summary") or "")[:120],
                source="fdroid", mobile=True, stars=0, size_kb=0, updated=g.get("updated") or 0,
            )

    # 2. GitHub sweeps (opt-in: --with-github-sweep). Off by default because topic-star
    #    queries return engines, servers, asset tools and tutorial repos far more reliably
    #    than they return playable games; vetting those by hand is not what the cron does.
    for f in (sorted(glob.glob(os.path.join(QUEUE_DIR, "raw-*.json"))) if "--with-github-sweep" in sys.argv else []):
        try:
            items = json.load(open(f)).get("items", [])
        except Exception:
            continue
        for it in items:
            repo = it["full_name"].lower()
            if repo in skip or repo in DENY_REPOS:
                continue
            desc = it.get("description") or ""
            topics = " ".join(it.get("topics") or [])
            text = repo + " " + desc + " " + topics
            if not GAMEISH.search(text):
                continue
            if NON_GAME.search(desc) or NON_GAME.search(it["full_name"].split("/")[1].replace("-", " ")):
                continue
            if (it.get("stargazers_count") or 0) < 800:
                continue
            # a repo only joins the queue on a genre/game topic, not on stars alone —
            # this is what kept "game engine", "awesome list" and "game server" repos out
            topic_set = {t.lower() for t in (it.get("topics") or [])}
            if not (topic_set & GENRE_TOPICS):
                continue
            if cands.get(repo, {}).get("source") == "fdroid":
                continue
            cands[repo] = dict(
                repo=repo, name=repo.split("/")[1], url=it["html_url"],
                lic=(it.get("license") or {}).get("spdx_id") or "",
                summary=desc[:120], source="github", mobile=bool(MOBILE.search(text)),
                stars=it.get("stargazers_count") or 0, size_kb=it.get("size") or 0,
                updated=0,
            )

    # 3. Curated shortlist.
    crg = os.path.expanduser("~/crg/candidates.json")
    if os.path.exists(crg):
        for c in json.load(open(crg)).get("candidates", []):
            repo = (c.get("repo") or "").lower()
            if not repo or repo in skip:
                continue
            e = cands.setdefault(repo, dict(repo=repo, name=c.get("name") or repo, url=f"https://github.com/{repo}",
                                            lic="", summary="",
                                            source="curated", mobile=True, stars=0, size_kb=0, updated=0))
            e["name"] = c.get("name") or e["name"]
            e["summary"] = (c.get("genre") or e["summary"])[:120]
            if e["source"] == "github":
                e["source"] = "curated+github"

    # 4. Hand-picked classics.
    for name, url in CURATED:
        repo = forge_repo(url) or name
        if repo in skip or repo.lower() in skip:
            continue
        if any(c["name"].lower() == name.lower() for c in cands.values()):
            continue
        cands[repo] = dict(repo=repo, name=name, url=url, lic="see-upstream", summary="curated open-source classic",
                           source="curated", mobile=False, stars=0, size_kb=0, updated=0)

    if "--refresh-stars" in sys.argv:
        tok = gh_token()
        gh = [r for r in cands if "/" in r and "github.com" in (cands[r].get("url") or "github.com")]
        meta = graphql_stars(gh, tok)
        for r, m in meta.items():
            if r in cands:
                cands[r].update(stars=m["stars"], lic=cands[r]["lic"] or m["lic"], size_kb=m["size_kb"] or cands[r]["size_kb"])
                if m.get("archived"):
                    cands[r]["archived"] = True

    rows = []
    for r, c in cands.items():
        if c.get("archived"):
            continue
        url = c["url"] or f"https://github.com/{r}"
        if not c["lic"]:
            continue  # an unlicensed repo is not redistributable — not a candidate
        text = c["name"] + " " + c["summary"]
        deep = bool(QUALITY_HIGH.search(text))
        shallow = bool(QUALITY_LOW.search(text))
        # rank: depth of game first, then mobile availability, then community size
        score = (2 if c["source"].startswith("fdroid") else 0) + (2 if c["mobile"] else 0)
        score += 6 if deep else 0
        score -= 8 if (shallow and not deep) else 0
        score += 8 if c["source"] == "curated" else 0
        score += min(c["stars"] / 1000.0, 12)
        # multi-gigabyte repos starve the queue: better to fetch twenty phone-sized
        # games than to spend a whole run's budget on one 4 GB RTS
        if c["size_kb"] > 2_500_000:
            score -= 10
        elif c["size_kb"] > 900_000:
            score -= 4
        rows.append(dict(
            name=re.sub(r"[^A-Za-z0-9._-]+", "-", c["name"].strip()).strip("-")[:40] or r.split("/")[1],
            url=url, stars=c["stars"], lic=c["lic"], size_kb=c["size_kb"],
            source=c["source"], summary=c["summary"].replace("\t", " ").replace("\n", " "),
            score=score,
        ))
    # de-dupe by name (clone dir names must be unique)
    seen: dict[str, dict] = {}
    for row in sorted(rows, key=lambda x: -x["score"]):
        k = row["name"].lower()
        if k in seen:
            continue
        seen[k] = row
    final = sorted(seen.values(), key=lambda x: -x["score"])

    with open(OUT, "w") as f:
        f.write("# name\turl\tstars\tlicense\test_size_kb\tsource\tsummary\n")
        for r in final:
            f.write(f"{r['name']}\t{r['url']}\t{r['stars']}\t{r['lic']}\t{r['size_kb']}\t{r['source']}\t{r['summary']}\n")
    print(f"GAMES.queue: {len(final)} repos  ({sum(1 for r in final if r['source'].startswith('fdroid'))} fdroid)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
