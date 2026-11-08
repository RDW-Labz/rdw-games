#!/usr/bin/env python3
"""Materialise port provenance.

Reads ports/manifest.json, verifies each artifact still exists on disk, hashes it,
writes ports/<id>/PROVENANCE.md and syncs artifact/commit/size/hash fields into
catalog/games.json. Re-runnable: run it after any rebuild to refresh the record.

    python3 tools/ports-provenance.py            # write
    python3 tools/ports-provenance.py --check    # exit 1 if the record is stale
"""
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "ports", "manifest.json")
CATALOG = os.path.join(ROOT, "catalog", "games.json")
CHECK = "--check" in sys.argv


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def git(clone, *args):
    try:
        out = subprocess.run(["git", "-C", clone, *args], capture_output=True, text=True)
        return out.stdout.strip()
    except OSError:
        return ""


def recorded(out_path):
    """Facts as previously written to a PROVENANCE.md, for donors no longer on disk."""
    import re
    out = {"commit_short": "", "commit_date": "", "commit_subject": "",
           "size_bytes": None, "sha256": None}
    if not os.path.isfile(out_path):
        return out
    text = open(out_path).read()
    m = re.search(r"\| pinned commit \| `([0-9a-f]+)` \(([^)]+)\) — (.*?) \|", text)
    if m:
        out["commit_short"], out["commit_date"], out["commit_subject"] = m.groups()
    m = re.search(r"\| size \| ([\d,]+) bytes", text)
    if m:
        out["size_bytes"] = int(m.group(1).replace(",", ""))
    m = re.search(r"\| sha256 \| `([0-9a-f]{64})` \|", text)
    if m:
        out["sha256"] = m.group(1)
    return out


def main():
    manifest = json.load(open(MANIFEST))
    catalog = json.load(open(CATALOG))
    by_id = {g["id"]: g for g in catalog["games"]}
    stale = []
    written = []

    for port in manifest["ports"]:
        pid = port["id"]
        art = port["artifact"]
        exists = os.path.isfile(art)
        out_path = os.path.join(ROOT, "ports", pid, "PROVENANCE.md")
        facts = {
            "commit": git(port["clone"], "rev-parse", "HEAD"),
            "commit_short": git(port["clone"], "rev-parse", "--short", "HEAD"),
            "commit_subject": git(port["clone"], "log", "-1", "--format=%s"),
            "commit_date": git(port["clone"], "log", "-1", "--format=%cs"),
            "size_bytes": os.path.getsize(art) if exists else None,
            "sha256": sha256(art) if exists else None,
        }
        clone_absent = not facts["commit_short"]
        if clone_absent:
            # The donor mirror is not on this machine: nothing to re-hash. Carry the
            # recorded values forward and say so, instead of blanking the record.
            prior = recorded(out_path)
            facts["commit_short"] = prior["commit_short"]
            facts["commit_date"] = prior["commit_date"]
            facts["commit_subject"] = prior["commit_subject"]
            facts["size_bytes"] = prior["size_bytes"]
            facts["sha256"] = prior["sha256"]
        facts["size_mb"] = round(facts["size_bytes"] / 1e6, 1) if facts["size_bytes"] else None

        kind = port["kind"]
        if kind == "apk":
            install = (
                f"`adb install -r {os.path.basename(art)}` — or copy the APK to the phone and open it. "
                f"Package `{port['package']}` version `{port['version']}`, ABI {', '.join(port['abis'])}."
            )
        else:
            install = (
                f"Desktop build: run `{art}`. {port['notes'].split('.')[0]}."
            )

        md = []
        md.append(f"# {pid} — provenance\n")
        md.append("Everything this repository claims about the title, in one file. Regenerate with "
                  "`python3 tools/ports-provenance.py`.\n")
        md.append("| field | value |")
        md.append("|---|---|")
        md.append(f"| upstream | {port['upstream']} |")
        md.append(f"| license | {port['license']} |")
        md.append(f"| pinned commit | `{facts['commit_short']}` ({facts['commit_date']}) — {facts['commit_subject']} |")
        md.append(f"| local clone | `{port['clone']}` |")
        md.append(f"| artifact | `{art}` |")
        md.append(f"| artifact type | {kind} |")
        if facts["size_bytes"]:
            md.append(f"| size | {facts['size_bytes']:,} bytes ({facts['size_mb']} MB) |")
            md.append(f"| sha256 | `{facts['sha256']}` |")
            if clone_absent:
                md.append("| re-verified | no — the donor clone is not on this machine; the pin, "
                          "size and hash above are the values recorded when it was |")
        else:
            md.append("| artifact | **missing on disk** — rebuild from the recipe below |")
        if port.get("package"):
            md.append(f"| package / version | `{port['package']}` {port['version']} |")
        if port.get("abis"):
            md.append(f"| ABIs in the artifact | {', '.join(port['abis'])} |")
        md.append("")
        md.append("## Build recipe (the commands actually run)\n")
        md.append("```sh")
        md.append(f"cd {port['clone']}")
        md.append(port["build"])
        md.append("```\n")
        md.append("## Install\n")
        md.append(install + "\n")
        md.append("## Notes\n")
        md.append(port["notes"] + "\n")
        md.append("## Licence\n")
        md.append(f"{port['license']}. The upstream licence text is authoritative and lives in the "
                  f"clone at `{port['clone']}`; this repository carries no copy of it and vendors none "
                  f"of the source.\n")

        text = "\n".join(md)
        out_path = os.path.join(ROOT, "ports", pid, "PROVENANCE.md")
        if CHECK:
            cur = open(out_path).read() if os.path.isfile(out_path) else ""
            if cur != text:
                stale.append(pid)
        else:
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            with open(out_path, "w") as f:
                f.write(text)
            written.append(pid)

        g = by_id.get(pid)
        if g is not None:
            g["artifact"] = art
            g["commit"] = facts["commit_short"]
            g["commit_subject"] = facts["commit_subject"]
            g["artifact_sha256"] = facts["sha256"]
            g["artifact_bytes"] = facts["size_bytes"]
            g["size_mb"] = facts["size_mb"] if facts["size_mb"] is not None else g.get("size_mb")
            if port.get("package"):
                g["package"] = port["package"]
                g["version"] = port["version"]
            g["build"] = port["build"]
            g["provenance"] = f"ports/{pid}/PROVENANCE.md"

    if CHECK:
        if stale:
            print("stale provenance: " + ", ".join(stale) + " — run python3 tools/ports-provenance.py")
            return 1
        print(f"provenance in sync ({len(manifest['ports'])} ports)")
        return 0

    catalog["source_commit"] = git("/home/cluer/cloned-free-games", "rev-parse", "--short", "HEAD") or catalog.get("source_commit")
    with open(CATALOG, "w") as f:
        json.dump(catalog, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {len(written)} PROVENANCE.md files and synced catalog/games.json")
    for pid in written:
        g = by_id.get(pid, {})
        print(f"  {pid:26} {str(g.get('artifact_bytes')):>12}  {str(g.get('artifact_sha256'))[:16]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
