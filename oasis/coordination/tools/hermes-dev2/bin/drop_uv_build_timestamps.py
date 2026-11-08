#!/usr/bin/python3 -I
"""Make the Hermes bundle byte-for-byte reproducible by dropping uv's own
build timestamp (decision #384).

Two builds of the same HERMES_PIN produced different tarball sha256
(GitHub runs 38615546661 and 38618248632). The only difference was
`<dist>.dist-info/uv_cache.json` (uv writes `secs_since_epoch` into it at
build time) and that file's own line in the same dist-info's RECORD. This
runs in .github/workflows/hermes-bundle.yml's "Nothing a careful unpacker
would refuse" step, after the pypi-only check and before the tarball is
made: it deletes every installed dist-info's uv_cache.json and removes the
matching RECORD line so RECORD still lists only what is actually on disk.

    drop_uv_build_timestamps.py VENV_SITE_PACKAGES
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path


def _strip_record(record_path: Path, removed_rel: str) -> None:
    with record_path.open(newline="", encoding="utf-8") as fh:
        rows = [row for row in csv.reader(fh) if row and row[0] != removed_rel]
    with record_path.open("w", newline="", encoding="utf-8") as fh:
        csv.writer(fh, lineterminator="\n").writerows(rows)


def main(venv_site_packages: str) -> int:
    site_packages = Path(venv_site_packages)
    fixed = 0
    for dist_info in sorted(site_packages.iterdir()):
        if not (dist_info.is_dir() and dist_info.name.endswith(".dist-info")):
            continue
        cache_file = dist_info / "uv_cache.json"
        if not cache_file.exists():
            continue
        cache_file.unlink()
        record_path = dist_info / "RECORD"
        if record_path.exists():
            _strip_record(record_path, f"{dist_info.name}/uv_cache.json")
        fixed += 1
    print(f"{fixed} dist-info(s) had uv_cache.json removed for a reproducible bundle")
    return 0


def _cli(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    return main(argv[1])


if __name__ == "__main__":
    sys.exit(_cli(sys.argv))
