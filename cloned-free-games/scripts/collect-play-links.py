#!/usr/bin/env python3
"""Resolve a "go play it" link for every catalog row.

A card that opens `github.com/owner/repo` sends someone to a source tree, not a game. This
builds `.queue/play-links.json`, mapping each upstream URL to the best destination we can
actually justify, in this order:

  1. the project's own homepage (GitHub `homepage` field from the sweeps) — the game's site,
  2. the F-Droid package page — one tap to install on the phone the catalog targets,
  3. the repo's latest release — prebuilt binaries when there is no site or store page.

Nothing is guessed: a row with no homepage, no package id and no releases keeps no play link,
and the card simply stays unlinked. Run before make-catalog-site.py; it reads what
fetch-sources.py already cached in `.queue/` and needs no network.
"""
from __future__ import annotations

import argparse
import glob
import json
import re
from pathlib import Path
from urllib.parse import urlparse

# Forges and docs hosts make a useless "play" target — the point is to get off the repo.
NOT_A_GAME_SITE = (
    "github.com", "gitlab.com", "codeberg.org", "git.sr.ht", "bitbucket.org",
    "sourceforge.net", "readthedocs.io", "readthedocs.org", "wikipedia.org",
)
# F-Droid-adjacent hosts: fine as a homepage, but the package page is strictly better.
STORE_HOSTS = ("f-droid.org", "play.google.com", "apps.apple.com", "itch.io")


def norm(url: str) -> str:
    u = (url or "").strip().rstrip("/")
    if u.endswith(".git"):
        u = u[:-4]
    p = urlparse(u)
    if not p.netloc:
        return u.lower()
    host = p.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    path = p.path.rstrip("/")
    return f"{host}{path}".lower()


def is_game_site(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    if not host:
        return False
    return not any(host == d or host.endswith("." + d) for d in NOT_A_GAME_SITE)


def load_homepages(qdir: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for f in sorted(glob.glob(str(qdir / "raw-*.json"))):
        try:
            data = json.loads(Path(f).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for item in data.get("items", []) or []:
            repo, home = item.get("html_url"), (item.get("homepage") or "").strip()
            if repo and home and is_game_site(home):
                out[norm(repo)] = home if home.startswith(("http://", "https://")) else "https://" + home
    return out


def load_pids(qdir: Path) -> dict[str, str]:
    """F-Droid package id per source repo, straight from the fetch cache."""
    try:
        games = json.loads((qdir / "fdroid-games.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    out: dict[str, str] = {}
    for key, meta in games.items():
        pid = (meta or {}).get("pid")
        src = (meta or {}).get("src") or key
        if pid and src:
            out.setdefault(norm(src), pid)
    return out


def norm_name(name: str) -> str:
    """Case/punctuation-insensitive name key: '2048 (Privacy Friendly)' -> '2048'."""
    s = re.sub(r"\([^)]*\)", " ", name or "")
    s = s.split("—")[0]
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def load_store_by_name(qdir: Path) -> dict[str, str]:
    """F-Droid package page per *game name*, for catalog rows that lost their clone.

    The judged rows in CATALOG.md carry no URL, and a few of them (Luanti, Shattered Pixel
    Dungeon, SuperTuxKart, Unciv) are the highest-scored cards on the page — pointing those at
    nothing is the worst case. The index knows the package id, so an exact normalised name match
    is enough; anything ambiguous is dropped rather than guessed.
    """
    try:
        apps = json.loads((qdir / "fdroid-index-v1.json").read_text(encoding="utf-8"))["apps"]
    except (OSError, json.JSONDecodeError, KeyError):
        return {}
    seen: dict[str, list[str]] = {}
    for a in apps:
        name = ((a.get("localized") or {}).get("en-US") or {}).get("name") or ""
        pid = a.get("packageName")
        key = norm_name(name)
        if key and pid:
            seen.setdefault(key, []).append(pid)
    return {k: v[0] for k, v in seen.items() if len(v) == 1}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=".", help="repo root holding .queue/")
    ap.add_argument("--out", default="", help="output path (default <src>/.queue/play-links.json)")
    args = ap.parse_args()

    src = Path(args.src).resolve()
    qdir = src / ".queue"
    dest = Path(args.out) if args.out else qdir / "play-links.json"

    homes = load_homepages(qdir)
    pids = load_pids(qdir)

    links: dict[str, dict[str, str]] = {}
    for key, home in homes.items():
        links[key] = {"play": home, "kind": "web", "label": "Play"}
    store = 0
    for key, pid in pids.items():
        if key in links:  # own site beats the store page
            continue
        links[key] = {"play": f"https://f-droid.org/packages/{pid}/", "kind": "store", "label": "Install"}
        store += 1

    # Release pages cover GitHub rows with no site and no F-Droid build.
    for f in sorted(glob.glob(str(qdir / "raw-*.json"))):
        try:
            data = json.loads(Path(f).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for item in data.get("items", []) or []:
            repo = norm(item.get("html_url") or "")
            if not repo or repo in links:
                continue
            slug = repo.split("github.com/", 1)[-1] if repo.startswith("github.com/") else ""
            if slug and "/" in slug:
                links[repo] = {"play": f"https://github.com/{slug}/releases/latest",
                               "kind": "releases", "label": "Download"}

    dest.parent.mkdir(parents=True, exist_ok=True)
    by_name = load_store_by_name(qdir)
    payload = {
        "byUrl": links,
        "byName": {k: {"play": f"https://f-droid.org/packages/{pid}/", "kind": "store", "label": "Install"}
                   for k, pid in by_name.items()},
    }
    dest.write_text(json.dumps(payload, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")
    kinds: dict[str, int] = {}
    for v in links.values():
        kinds[v["kind"]] = kinds.get(v["kind"], 0) + 1
    print(f"wrote {dest} — {len(links)} play links ({', '.join(f'{k} {v}' for k, v in sorted(kinds.items()))})"
          f", {len(by_name)} name-keyed store pages; homepages {len(homes)}, f-droid pids {len(pids)} ({store} used)")


if __name__ == "__main__":
    main()
