#!/usr/bin/env python3
"""Build the clones that have their own web build step, then prove the output plays.

The nightly chain could mirror a static build (promote-web-games.py) but had no way to
*produce* one. This is that step: for every clone the port plan called `web-buildable`
with a real build script, copy it out to a scratch dir, install + build it there, and
validate the generated entry point with the exact rules detect-web-games.py uses.

Nothing is written into the clone. When a build passes:

  .build/out/<slug>/        the built site, ready to mirror (a detect root)
  scripts/playable-auto.txt the slug, appended so promote ships it next run

When it fails, the slug goes to scripts/playable-block.txt with the reason, so the
nightly job never re-spends 10 minutes on the same broken tree. Delete a line from that
file to retry it.

Nothing here is trusted because it built: an entry that pulls scripts/styles from a CDN,
or references files that do not exist on disk, is rejected (a URL must work offline).

Usage:
  scripts/auto-build.py                     # next 2 candidates from the plan
  scripts/auto-build.py --max 4
  scripts/auto-build.py --slug Tessel-A-tile-game --force
  scripts/auto-build.py --list
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "scripts"
SHIMS = SCRIPTS / "build-shims"
BUILD_ROOT = REPO / ".build"
OUT_ROOT = BUILD_ROOT / "out"
SCRATCH_ROOT = BUILD_ROOT / "src"
DETECT = SCRIPTS / "detect-web-games.py"
PLAN = REPO / ".queue" / "port-plan.json"
ALLOW_AUTO = SCRIPTS / "playable-auto.txt"
BLOCK = SCRIPTS / "playable-block.txt"
MANIFEST = REPO / ".queue" / "auto-build.json"

TAG = re.compile(r"<(script|link|img|source|video|audio|iframe)\b([^>]*)>", re.I)
ATTR = re.compile(r"""(\w[\w:-]*)\s*=\s*["']([^"']*)["']""")
# rel values that actually cause a fetch. canonical/alternate/og are metadata, not loads.
FETCH_REL = ("stylesheet", "icon", "manifest", "preload", "prefetch", "modulepreload", "apple-touch-icon")
NODE_DIRS = ("/home/cluer/.hermes/tools", "/home/cluer/.local/bin", "/usr/local/bin", "/usr/bin")


def cdn_refs(html: str) -> list[str]:
    """Remote URLs the page would actually fetch. A canonical link or og:image pointing at
    the upstream site is harmless metadata; a stylesheet, script, image or font is not."""
    out = []
    for m in TAG.finditer(html):
        tag, body = m.group(1).lower(), m.group(2)
        attrs = {k.lower(): v for k, v in ATTR.findall(body)}
        rel = attrs.get("rel", "").lower()
        if tag == "link" and not any(r in rel for r in FETCH_REL):
            continue
        for key in ("src", "href", "poster", "data"):
            url = attrs.get(key, "")
            if url.startswith(("http://", "https://", "//")):
                out.append(f"<{tag} {key}={url[:80]}>")
                break
    if not out:
        for m in re.finditer(r"""url\(\s*["']?(https?://[^)"']+)""", html, re.I):
            out.append(f"css url({m.group(1)[:80]})")
    return out


def load_assess():
    """Reuse the detector's validator instead of keeping a second, drifting copy of it."""
    spec = importlib.util.spec_from_file_location("detect_web_games", DETECT)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {DETECT}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod.assess


def node_bin() -> Path | None:
    """A systemd user unit has no login PATH; find a node even when PATH is bare."""
    for name in ("node",):
        found = shutil.which(name)
        if found:
            return Path(found)
    for base in sorted(Path("/home/cluer/.local/share").glob("*/releases/*/profile/tools/node-*/bin")):
        if (base / "node").is_file():
            return base / "node"
    for base in sorted(Path("/home/cluer/.hermes/tools").glob("node-*/bin")):
        if (base / "node").is_file():
            return base / "node"
    return None


def tool_env(node: Path) -> dict:
    env = dict(os.environ)
    path = [str(node.parent), *os.environ.get("PATH", "").split(":")]
    for d in NODE_DIRS:
        if d not in path:
            path.append(d)
    env["PATH"] = ":".join(p for p in path if p)
    env.update({
        "CI": "1", "HUSKY": "0", "LEFTHOOK": "0",
        "npm_config_audit": "false", "npm_config_fund": "false",
        "npm_config_update_notifier": "false", "npm_config_loglevel": "warn",
        "NEXT_TELEMETRY_DISABLED": "1", "DO_NOT_TRACK": "1",
    })
    # NODE_ENV is deliberately NOT set here: `NODE_ENV=production npm install` omits
    # devDependencies, and every one of these build tools (parcel, vite, lingui) is a devDep.
    return env


def pkg_manager(clone: Path, node: Path) -> tuple[list[str] | None, str]:
    """(command prefix, why). pnpm is reached through npx so a clone's choice of package
    manager needs no machine-wide install; bun is not reachable that way, so it is skipped."""
    try:
        data = json.loads((clone / "package.json").read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        data = {}
    declared = str(data.get("packageManager") or "")
    name, _, version = declared.partition("@")
    ver = version.split("+")[0] or "10"
    if name == "bun" or (clone / "bun.lock").is_file() or (clone / "bun.lockb").is_file():
        # bun is not installed; vite/tsc builds usually run fine under npm. Try it, and say
        # so in the report, rather than refusing a whole game over its package manager.
        return [str(node.parent / "npm")], "npm (repo declares bun; bun unavailable)"
    if name == "pnpm" or (clone / "pnpm-lock.yaml").is_file():
        npx = node.parent / "npx"
        return [str(npx), "--yes", f"pnpm@{ver}"], f"pnpm@{ver} via npx"
    if name == "yarn" or (clone / "yarn.lock").is_file():
        npx = node.parent / "npx"
        return [str(npx), "--yes", "yarn@1"], "yarn 1.x via npx"
    return [str(node.parent / "npm")], "npm"


def run(cmd: list[str], cwd: Path, env: dict, log: Path, timeout: int) -> tuple[int, str]:
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a") as fh:
        fh.write(f"\n$ {' '.join(cmd)}   (cwd={cwd})\n")
        fh.flush()
        try:
            p = subprocess.run(cmd, cwd=cwd, env=env, stdout=fh, stderr=subprocess.STDOUT,
                               timeout=timeout, start_new_session=True)
            return p.returncode, ""
        except subprocess.TimeoutExpired:
            return 124, f"timed out after {timeout}s"
        except OSError as e:
            return 127, str(e)


def fresh_output(clone: Path, started: float) -> Path | None:
    """The entry point the build actually produced. mtimes survive the rsync, so a stale
    committed dist/ cannot masquerade as this run's output."""
    best = None
    for entry in clone.rglob("index.html"):
        parts = entry.relative_to(clone).parts
        if any(p in ("node_modules", ".git", "docs", "test", "tests", "examples") for p in parts[:-1]):
            continue
        try:
            if entry.stat().st_mtime < started - 2:
                continue
        except OSError:
            continue
        rank = (len(parts), 0 if (entry.parent / "assets").is_dir() else 1)
        if best is None or rank < best[0]:
            best = (rank, entry)
    return best[1] if best else None


ABS_REF = re.compile(r"""(["'(])(/(?![/\\])[A-Za-z0-9_@%+=.,~!$&-][A-Za-z0-9_@%+=.,~!$&/-]*?)\1""")
TEXT_SUFFIX = {".html", ".htm", ".js", ".mjs", ".cjs", ".css"}


def relativize_tree(root: Path) -> dict:
    """Rewrite root-absolute references ("/game.js") to paths relative to the referencing
    file. A bundler that emits /asset.js only works when served from the domain root, and
    these games live at /play/<slug>/, so without this the entry loads and nothing runs.

    Only a path that names a real file in the output is touched, so "/api/scores" or a
    route string survives unharmed. Returns counts for the build report."""
    files = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
    touched, refs = 0, 0
    for f in sorted(root.rglob("*")):
        if not f.is_file() or f.suffix.lower() not in TEXT_SUFFIX:
            continue
        try:
            txt = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        n = 0

        def sub(m: re.Match) -> str:
            nonlocal n
            quote, path = m.group(1), m.group(2)
            target = path.lstrip("/")
            if target not in files:
                return m.group(0)
            rel = os.path.relpath(root / target, f.parent).replace(os.sep, "/")
            n += 1
            return f"{quote}{rel}{quote}"

        new = ABS_REF.sub(sub, txt)
        if n:
            f.write_text(new, encoding="utf-8")
            touched += 1
            refs += n
    return {"files": touched, "refs": refs}


def vendor_remote(root: Path, html_path: Path, budget: int = 512 * 1024, max_files: int = 2) -> list[dict]:
    """Download the few remote stylesheets/scripts a page hard-links (e.g. an icon font from a
    CDN) into the build and rewrite the reference, so the catalog stays self-contained.

    Deliberately narrow: https only, <link rel=stylesheet> and <script src> only, at most
    `max_files` and `budget` bytes each. Anything bigger or odd is left alone and the caller's
    remote-ref check then rejects the build, which is the honest outcome."""
    import hashlib
    import urllib.request

    got: list[dict] = []
    html = html_path.read_text(encoding="utf-8", errors="replace")
    for m in TAG.finditer(html):
        if len(got) >= max_files:
            break
        tag, body = m.group(1).lower(), m.group(2)
        attrs = {k.lower(): v for k, v in ATTR.findall(body)}
        rel = attrs.get("rel", "").lower()
        if tag == "script":
            url = attrs.get("src", "")
        elif tag == "link" and "stylesheet" in rel:
            url = attrs.get("href", "")
        else:
            continue
        if not url.startswith("https://"):
            continue
        ext = ".js" if tag == "script" else ".css"
        name = hashlib.sha1(url.encode()).hexdigest()[:10] + ext
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cloned-free-games/1.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = r.read(budget + 1)
        except Exception as e:  # noqa: BLE001 - any failure means "leave it remote"
            got.append({"url": url, "error": str(e)[:80]})
            continue
        if len(data) > budget:
            got.append({"url": url, "error": f"over {budget} bytes"})
            continue
        vdir = root / "_vendor"
        vdir.mkdir(exist_ok=True)
        (vdir / name).write_bytes(data)
        rel_path = os.path.relpath(vdir / name, html_path.parent).replace(os.sep, "/")
        html = html.replace(url, rel_path)
        got.append({"url": url, "saved": f"_vendor/{name}", "bytes": len(data)})
    if any("saved" in g for g in got):
        html_path.write_text(html, encoding="utf-8")
        relativize_tree(root)
    return got


def allow_slugs(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    return {ln.split("#", 1)[0].strip() for ln in path.read_text().splitlines() if ln.split("#", 1)[0].strip()}


def append_unique(path: Path, slug: str, note: str) -> None:
    existing = allow_slugs(path)
    if slug in existing:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.is_file():
        path.write_text("# Auto-built slugs: produced by scripts/auto-build.py and validated\n"
                        "# (every referenced asset on disk, no CDN scripts). One per line.\n")
    with path.open("a") as fh:
        fh.write(f"{slug}  # {note}\n")


def block_slug(slug: str, reason: str) -> None:
    if slug in allow_slugs(BLOCK):
        return
    BLOCK.parent.mkdir(parents=True, exist_ok=True)
    if not BLOCK.is_file():
        BLOCK.write_text("# Slugs auto-build gave up on. One per line: slug  # reason\n"
                         "# Delete a line to let the nightly job try that game again.\n")
    with BLOCK.open("a") as fh:
        fh.write(f"{slug}  # {reason}\n")


def candidates(force: set[str]) -> list[dict]:
    if not PLAN.is_file():
        return []
    plan = json.loads(PLAN.read_text())
    blocked = allow_slugs(BLOCK)
    shipped = allow_slugs(ALLOW_AUTO) | allow_slugs(SCRIPTS / "playable-allow.txt")
    out = []
    for item in plan.get("items", []):
        slug = item["slug"]
        if slug in force:
            out.append(item)          # --slug overrides both the lane and the ledger
            continue
        if item.get("lane") != "web-buildable" or not item.get("build_script"):
            continue
        if slug in shipped or slug in blocked:
            continue
        out.append(item)
    return out


def build_one(item: dict, assess, node: Path, args) -> dict:
    slug, script = item["slug"], item["build_script"]
    clone = REPO / "games" / slug
    started = time.time()
    log = Path(os.environ.get("STATE", Path.home() / ".local/state")) / "arcade-build" / f"{slug}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(f"=== {slug} build {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} ===\n")

    if not clone.is_dir():
        return {"slug": slug, "ok": False, "reason": f"clone missing ({clone})"}

    pm, why = pkg_manager(clone, node)
    if pm is None:
        return {"slug": slug, "ok": False, "reason": why}

    scratch = SCRATCH_ROOT / slug
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.parent.mkdir(parents=True, exist_ok=True)
    rc, err = run(["rsync", "-a", "--exclude", ".git", "--exclude", "node_modules",
                   f"{clone}/", f"{scratch}/"], scratch.parent, tool_env(node), log, 900)
    if rc != 0:
        return {"slug": slug, "ok": False, "reason": f"copy failed: {err or rc}"}

    env = tool_env(node)
    tail_arg = pm[-1]
    if tail_arg == "npm":
        install = [*pm, "ci" if (scratch / "package-lock.json").is_file() else "install",
                   "--no-audit", "--no-fund"]
    elif tail_arg.startswith("pnpm@"):
        install = [*pm, "install", "--prefer-offline"]
    else:
        install = [*pm, "install"]
    if not args.allow_scripts:
        install.append("--ignore-scripts")
    if "bun unavailable" in why:
        install.append("--legacy-peer-deps")   # npm is stricter than bun about peerDeps
    rc, err = run(install, scratch, env, log, args.timeout)
    if rc != 0:
        return {"slug": slug, "ok": False, "reason": f"install rc={rc}{': ' + err if err else ''}"}

    shim = SHIMS / f"{slug}.sh"
    if shim.is_file():
        rc, err = run(["bash", str(shim)], scratch, env, log, 300)
        if rc != 0:
            return {"slug": slug, "ok": False, "reason": f"shim {shim.name} rc={rc}{': ' + err if err else ''}"}

    rc, err = run([*pm, "run", script], scratch, {**env, "NODE_ENV": "production"}, log, args.timeout)
    if rc != 0:
        return {"slug": slug, "ok": False, "reason": f"build rc={rc}{': ' + err if err else ''}"}

    entry = fresh_output(scratch, started)
    if entry is None:
        return {"slug": slug, "ok": False, "reason": "build produced no index.html"}

    ok, why_bad, facts = assess(entry)
    if not ok:
        return {"slug": slug, "ok": False, "reason": f"output rejected: {why_bad}"}

    if facts["bytes"] > args.max_mb * 1024 * 1024:
        return {"slug": slug, "ok": False,
                "reason": f"{facts['bytes'] // 1024 // 1024} MB output over the {args.max_mb} MB budget"}

    dest = OUT_ROOT / slug
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(entry.parent, dest, symlinks=False)
    rel = entry.name
    rewritten = relativize_tree(dest)
    entry2 = dest / rel
    vendored = []
    if cdn_refs(entry2.read_text(errors="replace")):
        vendored = vendor_remote(dest, entry2)
    ok2, why2, facts2 = assess(entry2)
    if not ok2:
        shutil.rmtree(dest, ignore_errors=True)
        return {"slug": slug, "ok": False, "reason": f"broken by path rewrite: {why2}"}
    external = cdn_refs(entry2.read_text(errors="replace"))
    if external:
        shutil.rmtree(dest, ignore_errors=True)
        return {"slug": slug, "ok": False,
                "reason": f"still fetches {len(external)} remote asset(s): {external[0]}"}
    shutil.rmtree(scratch, ignore_errors=True)
    append_unique(ALLOW_AUTO, slug, f"auto-built {time.strftime('%Y-%m-%d')}")
    return {"slug": slug, "ok": True, "entry": entry2.name, "built_entry": rel,
            "base": f".build/out/{slug}", "bytes": facts2["bytes"],
            "rewritten": rewritten,
            "seconds": round(time.time() - started)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=2, help="how many candidates to attempt tonight")
    ap.add_argument("--timeout", type=int, default=900, help="per-step budget (install, build)")
    ap.add_argument("--max-mb", type=int, default=160, help="refuse an output bigger than this")
    ap.add_argument("--slug", action="append", default=[], help="force specific slug(s)")
    ap.add_argument("--force", action="store_true", help="retry even if shipped or blocked")
    ap.add_argument("--allow-scripts", action="store_true", help="let install scripts run (trusted clones only)")
    ap.add_argument("--keep-scratch", action="store_true", help="keep .build/src/<slug> for debugging")
    ap.add_argument("--list", action="store_true", help="print candidates and exit")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    node = node_bin()
    if node is None:
        print("! no node found — auto-build skipped", file=sys.stderr)
        return 0

    force = set(args.slug)
    todo = candidates(force)
    if args.list:
        for item in todo:
            print(f"  {item['slug']:28s} npm run {item['build_script']}  ({item.get('why', '')[:60]})")
        print(f"CANDIDATES {len(todo)}")
        return 0
    if not todo:
        print("AUTO-BUILD 0 candidates (nothing web-buildable left unshipped)")
        return 0

    # Bounded work: --max per run keeps a bad tree from eating the night.
    if force:
        todo = [t for t in todo if t["slug"] in force]
    else:
        todo = todo[: args.max]

    assess = load_assess()
    results, passed = [], []
    for item in todo:
        print(f"  building {item['slug']} (npm run {item['build_script']}) ...", flush=True)
        if args.dry_run:
            continue
        r = build_one(item, assess, node, args)
        if not args.keep_scratch:
            shutil.rmtree(SCRATCH_ROOT / item["slug"], ignore_errors=True)
        print(f"  {'OK  ' if r['ok'] else 'FAIL'} {r['slug']}: {r.get('reason') or r.get('base')}", flush=True)
        results.append(r)
        if r["ok"]:
            passed.append(r)
        else:
            if not args.force:
                block_slug(r["slug"], r["reason"][:120])

    payload = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "attempted": len(results),
        "passed": passed,
        "failed": [r for r in results if not r["ok"]],
    }
    if not args.dry_run:
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        tmp = MANIFEST.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=1))
        tmp.replace(MANIFEST)

    if passed:
        print(f"AUTO-BUILD {len(passed)} built -> .build/out/ (allow list: {ALLOW_AUTO.name})")
    else:
        print(f"AUTO-BUILD 0 of {len(results)} built")
    return 0


if __name__ == "__main__":
    sys.exit(main())
