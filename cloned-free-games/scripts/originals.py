"""Read original game releases and stage their versioned browser builds."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shutil
from urllib.parse import urlsplit

MANIFEST = Path(__file__).resolve().parents[2] / "originals" / "releases.json"


def load_releases(path: Path = MANIFEST) -> list[dict]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schema") != 1 or not isinstance(manifest.get("releases"), list):
        raise ValueError(f"{path}: expected a schema-1 release list")
    releases = []
    slugs = set()
    for release in manifest["releases"]:
        slug = release.get("slug", "")
        version = release.get("version", "")
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug) or slug in slugs:
            raise ValueError(f"{path}: invalid or duplicate slug {slug!r}")
        if not re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*", version):
            raise ValueError(f"{slug}: invalid release version")
        if not all(isinstance(release.get(field), str) and release[field].strip()
                   for field in ("title", "description")):
            raise ValueError(f"{slug}: title and description are required")
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", release.get("source", "")):
            raise ValueError(f"{slug}: expected an owner/repository source")
        if not re.fullmatch(r"[a-f0-9]{40}", release.get("commit", "")):
            raise ValueError(f"{slug}: expected a full source commit")
        route = f"play/{slug}/{version}"
        hosted = "url" in release
        url = release.get("url") if hosted else f"/{route}/"
        if hosted:
            parts = urlsplit(url)
            if parts.scheme != "https" or not parts.hostname or parts.username is not None:
                raise ValueError(f"{slug}: expected a hosted HTTPS play URL")
        releases.append({**release, "url": url, "bundle": None if hosted else route,
                         "desc": release["description"], "kicker": "original"})
        slugs.add(slug)
    return releases


def stage_builds(releases: list[dict], builds: Path, public: Path) -> None:
    for release in releases:
        route = release["bundle"]
        if route is None:
            continue
        source = builds / release["slug"] / release["version"]
        if not (source / "index.html").is_file():
            raise ValueError(f"Missing release entry point: {source / 'index.html'}")
        if source.resolve() != builds.resolve() / release["slug"] / release["version"]:
            raise ValueError(f"Release directory is a symbolic link: {source}")
        for item in source.rglob("*"):
            if item.is_symlink() or item.name.startswith(".") or not (item.is_file() or item.is_dir()):
                raise ValueError(f"Unexpected release entry: {item}")
        target = public / route
        shutil.copytree(source, target)
        print(f"ORIGINAL /{route}/")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--builds", type=Path, required=True)
    parser.add_argument("--public", type=Path, required=True)
    args = parser.parse_args()
    try:
        stage_builds(load_releases(), args.builds, args.public)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Original games: {error}\n")


if __name__ == "__main__":
    main()
