#!/usr/bin/env python3
"""Print the fact pack for the next cloned-but-unjudged game.

Default (monitor) output is deliberately short and stable — it is used as a cron
--monitor-script, where byte-identical output suppresses the agent run entirely. So no
timestamps, no durations, nothing that changes between ticks for the same commit.

  scripts/next-unjudged.py            # "UNJUDGED: <name>" + path + engine + size   (stable)
  scripts/next-unjudged.py --facts    # full pack: license, engine markers, content depth,
                                      # mobile-readiness signals, README head
  scripts/next-unjudged.py --all      # every unjudged clone, one per line

A clone counts as judged when its name appears in CATALOG.md (any case, spaces and
hyphens ignored). Names come from games/<dir>; GAMES.lock is not consulted because the
judging question is "what is on disk", not "what is pinned".
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES = os.path.join(ROOT, "games")
CATALOG = os.path.join(ROOT, "CATALOG.md")
FAILS = os.path.join(ROOT, ".queue", "judge-fails.tsv")
SKIP = os.path.join(ROOT, ".queue", "judge-skip.txt")


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def skipped() -> set[str]:
    try:
        return {ln.strip() for ln in open(SKIP) if ln.strip() and not ln.startswith("#")}
    except FileNotFoundError:
        return set()


def record_skip(name: str) -> str:
    """Log one failure for a game; return how many strikes it now has."""
    os.makedirs(os.path.dirname(FAILS), exist_ok=True)
    with open(FAILS, "a") as f:
        f.write(f"{name}\t{__import__('datetime').datetime.now().isoformat(timespec='seconds')}\n")
    strikes = sum(1 for ln in open(FAILS) if ln.split("\t")[0] == name)
    if strikes >= 3:
        with open(SKIP, "a") as f:
            f.write(name + "\n")
    return strikes


def judged_text() -> str:
    try:
        return norm(open(CATALOG, encoding="utf-8", errors="replace").read())
    except FileNotFoundError:
        return ""


def roots() -> list[str]:
    """Where clones live: the repo's games/ plus the shield, which holds the AAA tier.

    The shield root is overridable so the 1.8 TB T7 can move (or be absent) without the
    judging pass breaking — an unmounted shield simply contributes nothing.
    """
    out = [GAMES]
    extra = os.environ.get("GAMES_EXTRA", "/mnt/models/cloned-free-games/games")
    if extra and os.path.isdir(extra):
        out.append(extra)
    return [r for r in out if os.path.isdir(r)]


def game_dirs() -> list[tuple[str, str]]:
    """(name, absolute path) for every clone on every root, sorted by name."""
    found = []
    for root in roots():
        for d in sorted(os.listdir(root)):
            full = os.path.join(root, d)
            if os.path.isdir(full):
                found.append((d, full))
    return found


def engines(path: str) -> list[str]:
    hits = []

    def has(*names):
        return any(os.path.exists(os.path.join(path, n)) for n in names)

    def glob_hit(pattern: str) -> bool:
        rx = re.compile(pattern)
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "build", "Builds")]
            if any(rx.search(f) for f in files):
                return True
            if root.count(os.sep) - path.count(os.sep) > 3:
                dirs[:] = []
        return False

    if has("project.godot") or glob_hit(r".*\.godot$"):
        hits.append("godot")
    if has("Assets", "ProjectSettings") and glob_hit(r".*\.unity$"):
        hits.append("unity")
    if glob_hit(r".*\.uproject$"):
        hits.append("unreal")
    if glob_hit(r".*\.love$") or has("conf.lua", "main.lua"):
        hits.append("love2d")
    if has("Cargo.toml"):
        hits.append("rust")
    if has("pom.xml") or has("build.gradle", "build.gradle.kts"):
        hits.append("gradle/jvm")
    if has("AndroidManifest.xml") or os.path.isdir(os.path.join(path, "android")):
        hits.append("android")
    if has("CMakeLists.txt"):
        hits.append("cmake")
    if has("meson.build"):
        hits.append("meson")
    if has("Makefile"):
        hits.append("make")
    if has("package.json"):
        hits.append("node/web")
    if glob_hit(r".*\.sln$"):
        hits.append("msbuild")
    if glob_hit(r".*\.py$") and has("requirements.txt", "pyproject.toml", "setup.py"):
        hits.append("python")
    return hits or ["unknown"]


def count_ext(path: str, exts: tuple[str, ...], floor: int = 0) -> int:
    n = 0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
        n += sum(1 for f in files if f.lower().endswith(exts))
        if n > 200_000:
            break
    return n


def size_of(path: str) -> str:
    out = subprocess.run(["du", "-sh", path], capture_output=True, text=True)
    return out.stdout.split("\t")[0] or "?"


def head_commit(path: str) -> str:
    out = subprocess.run(["git", "-C", path, "log", "-1", "--format=%h %ad %s", "--date=short"],
                         capture_output=True, text=True)
    return out.stdout.strip() or "?"


def license_of(path: str) -> str:
    for name in os.listdir(path):
        if re.match(r"(?i)^(licen[cs]e|copying)(\.|$)", name):
            try:
                text = open(os.path.join(path, name), encoding="utf-8", errors="replace").read(2000)
            except OSError:
                continue
            if "GNU AFFERO" in text.upper():
                return f"{name}: AGPL"
            for full, short in (("GNU GENERAL PUBLIC", "GPL"), ("GNU LESSER", "LGPL"),
                                ("MOZILLA PUBLIC", "MPL"), ("APACHE", "Apache"),
                                ("MIT LICENSE", "MIT"), ("BSD", "BSD"), ("THE UNLICENSE", "Unlicense")):
                if full in text.upper():
                    return f"{name}: {short}"
            return name
    return "none found"


def facts(name: str, path: str) -> str:
    """Full fact pack for one clone; path comes from game_dirs() so both roots work."""
    eng = engines(path)
    readme = ""
    for cand in ("README.md", "README", "readme.md", "README.txt", "README.rst"):
        p = os.path.join(path, cand)
        if os.path.exists(p):
            readme = open(p, encoding="utf-8", errors="replace").read(4000)
            break
    content = {
        "maps/levels": count_ext(path, (".map", ".tmx", ".tsx", ".ldtk", ".bsp", ".wad", ".tmj")),
        "images": count_ext(path, (".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".bmp")),
        "audio": count_ext(path, (".ogg", ".wav", ".mp3", ".flac", ".opus")),
        "models": count_ext(path, (".obj", ".glb", ".gltf", ".fbx", ".blend", ".md3", ".iqm")),
        "code": count_ext(path, (".c", ".cc", ".cpp", ".h", ".hpp", ".java", ".kt", ".cs", ".rs",
                                 ".py", ".js", ".ts", ".gd", ".lua", ".go", ".swift")),
    }
    lines = [
        f"UNJUDGED: {name}",
        f"path: {path}",
        f"head: {head_commit(path)}",
        f"size: {size_of(path)}",
        f"license: {license_of(path)}",
        f"engine markers: {', '.join(eng)}",
        "content: " + "  ".join(f"{k}={v}" for k, v in content.items()),
        f"android signals: manifest={'yes' if any('android' in e for e in eng) else 'no'}  "
        f"apk_in_tree={count_ext(path, ('.apk',))}  ios_dir={'yes' if os.path.isdir(os.path.join(path, 'ios')) else 'no'}",
        "build files: " + ", ".join(n for n in ("CMakeLists.txt", "Makefile", "meson.build", "build.gradle",
                                                "build.gradle.kts", "pom.xml", "Cargo.toml", "package.json",
                                                "project.godot") if os.path.exists(os.path.join(path, n))),
        "--- README head ---",
        readme[:2500] if readme else "(no README)",
    ]
    return "\n".join(lines)


def main() -> int:
    judged = judged_text()
    dirs = game_dirs()
    skip = skipped()
    pending = [(n, p) for n, p in dirs if norm(n) not in judged and n not in skip]

    if "--skip" in sys.argv:
        target = sys.argv[sys.argv.index("--skip") + 1] if len(sys.argv) > sys.argv.index("--skip") + 1 else ""
        if not target or target not in [n for n, _ in dirs]:
            print(f"--skip needs one of: {', '.join(n for n, _ in dirs)}")
            return 2
        n = record_skip(target)
        print(f"recorded strike {n} for {target}" + (" — now skipped permanently" if n >= 3 else ""))
        return 0

    if "--all" in sys.argv:
        print("\n".join(n for n, _ in pending) or "(none)")
        return 0
    if not pending:
        # stable "nothing to do" string: the monitor suppresses the agent entirely
        print("UNJUDGED: none")
        return 0

    name, path = pending[0]
    if "--facts" in sys.argv:
        print(facts(name, path))
    else:
        print(f"UNJUDGED: {name}")
        print(f"path: {path}")
        print(f"engine markers: {', '.join(engines(path))}")
        print(f"size: {size_of(path)}")
        print(f"pending total: {len(pending)} of {len(dirs)} clones")
    return 0


if __name__ == "__main__":
    sys.exit(main())
