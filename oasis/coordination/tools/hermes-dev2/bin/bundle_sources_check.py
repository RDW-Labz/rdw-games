#!/usr/bin/python3 -I
"""Supply-chain gate for the Hermes bundle (decision #384, pypi-only guard).

Run by .github/workflows/hermes-bundle.yml right after `uv sync --locked
--no-build`, before anything in the freshly built venv is executed (the
smoke test) or packaged (the tarball). Fails the build unless every
installed distribution in the venv came from https://pypi.org/simple,
with one exception: the hermes-agent project itself, installed editable
from DEST (that is how `uv sync` installs the project being built).

Two independent checks, both stdlib only:

1. direct_url.json (PEP 610): if an installed distribution carries one, it
   was NOT a plain index resolve (pip/uv only write this file for a direct
   reference: a VCS checkout, a URL-sourced wheel/sdist, or a local
   editable/non-editable path). Refuse all of those except the editable
   root project pointing at file://DEST.
2. uv.lock: for every other installed distribution, find the matching
   [[package]] entry (by PEP 503 normalized name + exact version) and
   require its `source` to be `{registry = "https://pypi.org/simple"}`.
   An installed distribution with no matching lock entry is refused too.

The lock pins some non-default extras off a registry (psutil's android
fork is a `git` source, misaki is `git`, kittentts is a release-asset
`url`), but none of those are installed in the default Linux build, so
they never reach this check: only INSTALLED distributions are looked up
in the lock, never the other way around.

    bundle_sources_check.py VENV_SITE_PACKAGES UV_LOCK DEST
"""

from __future__ import annotations

import json
import re
import sys
import tomllib
from importlib.metadata import Distribution
from pathlib import Path

ROOT_PROJECT_NAME = "hermes-agent"
PYPI_REGISTRY = "https://pypi.org/simple"


def _normalize(name: str) -> str:
    """PEP 503: lowercase, runs of -_. collapsed to a single '-'."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _iter_installed(site_packages: Path):
    """Yield a Distribution for every *.dist-info directly under site_packages."""
    for entry in sorted(site_packages.iterdir()):
        if entry.is_dir() and entry.name.endswith(".dist-info"):
            yield Distribution.at(entry)


def _is_editable_root(dist: Distribution, dest: Path) -> bool:
    raw = dist.read_text("direct_url.json")
    if raw is None:
        return False
    try:
        info = json.loads(raw)
    except json.JSONDecodeError:
        return False
    if not info.get("dir_info", {}).get("editable"):
        return False
    url = info.get("url", "")
    if not url.startswith("file://"):
        return False
    got = Path(url[len("file://"):])
    try:
        return got.resolve() == dest.resolve()
    except OSError:
        return False


def _load_lock_packages(lock_path: Path) -> dict[tuple[str, str], dict]:
    with lock_path.open("rb") as fh:
        data = tomllib.load(fh)
    packages: dict[tuple[str, str], dict] = {}
    for pkg in data.get("package", []):
        name, version = pkg.get("name"), pkg.get("version")
        if name is None or version is None:
            continue
        packages[(_normalize(name), version)] = pkg
    return packages


def main(venv_site_packages: str, lock_path: str, dest: str) -> int:
    site_packages = Path(venv_site_packages)
    dest_path = Path(dest)
    lock = _load_lock_packages(Path(lock_path))
    root = _normalize(ROOT_PROJECT_NAME)

    failures: list[str] = []
    checked = 0

    for dist in _iter_installed(site_packages):
        name, version = dist.name, dist.version
        if not name or not version:
            failures.append(f"a dist-info under {site_packages} has no Name/Version in METADATA")
            continue
        checked += 1
        norm = _normalize(name)
        has_direct_url = dist.read_text("direct_url.json") is not None

        if norm == root:
            if not _is_editable_root(dist, dest_path):
                failures.append(
                    f"{name} {version}: expected the editable root project at file://{dest}, "
                    "but its direct_url.json says otherwise (or is missing)"
                )
            continue

        if has_direct_url:
            failures.append(f"{name} {version}: has direct_url.json (a git/url/local install, not a pypi.org registry install)")
            continue

        entry = lock.get((norm, version))
        if entry is None:
            failures.append(f"{name} {version}: installed but no matching entry in {lock_path}")
            continue

        source = entry.get("source", {})
        if source.get("registry") != PYPI_REGISTRY:
            failures.append(f"{name} {version}: lock source is {source!r}, not a {{registry = \"{PYPI_REGISTRY}\"}} entry")

    if failures:
        for line in failures:
            print(f"FAIL: {line}", file=sys.stderr)
        print(f"{len(failures)} of {checked} installed package(s) did not come from pypi.org", file=sys.stderr)
        return 1

    print(f"{checked} installed, all from pypi.org (+ {ROOT_PROJECT_NAME} editable)")
    return 0


def _cli(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    return main(argv[1], argv[2], argv[3])


if __name__ == "__main__":
    sys.exit(_cli(sys.argv))
