#!/usr/bin/env python3
"""Mirror verified static web builds into the site so they play in the browser.

Input  : .queue/web-playable.json   (written by detect-web-games.py)
Allow  : scripts/playable-allow.txt  (one slug per line — only verified builds ship)
Output : play/<slug>/               (static mirror, .git excluded)
         .queue/playable.json       (manifest the catalog renderer reads)

Only files are copied — no symlinks, no .git, no node_modules — so the mirror is a
drop-in static directory that `publish-site.sh` injects next to the catalog.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_DEST = REPO / ".site-play"   # staged into the deployment by publish-site.sh, never committed
SKIP_NAMES = {".git", "node_modules", "__pycache__", ".github", ".vscode"}
SKIP_SUFFIX = {".git", ".sh", ".ps1", ".bat", ".blend", ".xcf", ".psd"}


def allow_list(paths: list[Path]) -> set[str] | None:
    """Union of every allow file. None means "no allow file exists at all" (ship nothing);
    an existing-but-empty set still gates every slug."""
    found = False
    out: set[str] = set()
    for path in paths:
        if not path.is_file():
            continue
        found = True
        for line in path.read_text().splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                out.add(line)
    return out if found else None


MISSING_REF_RE = re.compile(
    r"""(?:["'(=])((?:\./)?node_modules/[^"')?#\s]+)""", re.IGNORECASE)
VENDOR_CAP_FILES = 12
VENDOR_CAP_BYTES = 4 * 1024 * 1024


def vendored_refs(src: Path, dest: Path) -> list[tuple[Path, Path]]:
    """Files an upstream page references under node_modules/ — those are excluded from the
    mirror, and an unresolved `src=` means `$ is not defined` and a dead game (flexboxfroggy,
    gridgarden ship jquery this way). Resolve the ones that actually exist in the clone."""
    want: list[str] = []
    for root, dirs, files in os.walk(dest):
        dirs[:] = [d for d in dirs if d not in SKIP_NAMES]
        for f in files:
            if Path(f).suffix.lower() not in {".html", ".htm", ".js", ".css"}:
                continue
            page = Path(root) / f
            try:
                text = page.read_text(errors="ignore")
            except OSError:
                continue
            for m in MISSING_REF_RE.finditer(text):
                ref = m.group(1).lstrip("./")
                if ref not in want:
                    want.append(ref)
    pairs: list[tuple[Path, Path]] = []
    total = 0
    for ref in want:
        s = src / ref
        if not s.is_file() or s.is_symlink():
            continue
        size = s.stat().st_size
        if size > VENDOR_CAP_BYTES or len(pairs) >= VENDOR_CAP_FILES or total + size > VENDOR_CAP_BYTES * 3:
            print(f"  ! vendor budget hit, skipping {ref} ({size} B)", file=sys.stderr)
            continue
        pairs.append((s, dest / ref))
        total += size
    return pairs


def mirror(src: Path, dest: Path) -> int:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    total = 0
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP_NAMES]
        rel = Path(root).relative_to(src)
        for f in files:
            s = Path(root) / f
            if s.suffix.lower() in SKIP_SUFFIX:
                continue
            if s.is_symlink():
                continue
            d = dest / rel / f
            d.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copy2(s, d)
                total += d.stat().st_size
            except OSError as e:
                print(f"  ! {s}: {e}", file=sys.stderr)
    return total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--detect", default=str(REPO / ".queue" / "web-playable.json"))
    ap.add_argument("--allow", action="append", default=None,
                    help="allow file (repeatable); defaults to the curated hand-played file "
                         "plus the auto-build file")
    ap.add_argument("--dest", default=str(DEFAULT_DEST))
    ap.add_argument("--out", default=str(REPO / ".queue" / "playable.json"))
    ap.add_argument("--all", action="store_true", help="promote every detected build (ignore the allow list)")
    ap.add_argument("--prune", action="store_true", help="delete mirrored dirs that are no longer allowed")
    ap.add_argument("--max-mb", type=int, default=160,
                    help="skip a build whose source dir exceeds this — published bytes stay bounded")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    det = json.loads(Path(args.detect).read_text())
    allow_paths = [Path(p) for p in (args.allow or [str(REPO / "scripts" / "playable-allow.txt"),
                                                    str(REPO / "scripts" / "playable-auto.txt")])]
    allow = None if args.all else allow_list(allow_paths)
    dest = Path(args.dest)
    out_items = []
    kept = set()
    total_bytes = 0
    cap = args.max_mb * 1024 * 1024

    for item in det.get("items", []):
        slug = item["slug"]
        if allow is not None and slug not in allow:
            continue
        base = Path(item["base"])
        if not base.is_dir():
            print(f"  ! {slug}: base gone ({base})", file=sys.stderr)
            continue
        entry = Path(item["entry"])
        if item.get("bytes", 0) > cap:
            print(f"  ! {slug}: {item['bytes'] // 1024 // 1024} MB over the {args.max_mb} MB budget — skipped",
                  file=sys.stderr)
            continue
        try:
            rel_entry = entry.relative_to(base).as_posix()
        except ValueError:
            rel_entry = "index.html"
        target = dest / slug
        if args.dry_run:
            print(f"  would mirror {slug} ({item['bytes'] // 1024} KB) -> {target}")
            total_bytes += item["bytes"]
        else:
            size = mirror(base, target)
            for s, d in vendored_refs(base, target):
                d.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(s, d)
                size += d.stat().st_size
                print(f"  vendored {slug}: {d.relative_to(target).as_posix()} ({d.stat().st_size // 1024} KB)")
            print(f"  mirrored {slug} ({size // 1024} KB) -> {target}")
            total_bytes += size
        kept.add(slug)
        out_items.append({
            "slug": slug,
            "name": item["name"],
            "entry": f"/play/{slug}/{rel_entry}",
            "bytes": item["bytes"],
            "canvas": item.get("canvas", False),
        })

    if args.prune and dest.is_dir():
        for d in dest.iterdir():
            if d.is_dir() and d.name not in kept:
                print(f"  pruned {d.name}")
                if not args.dry_run:
                    shutil.rmtree(d)

    out_items.sort(key=lambda i: i["name"].lower())
    payload = {"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "count": len(out_items),
               "bytes": total_bytes, "items": out_items}
    if not args.dry_run:
        p = Path(args.out)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=1))
        tmp.replace(p)
    print(f"PLAYABLE {len(out_items)} mirrored, {total_bytes / 1048576:.1f} MB -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
