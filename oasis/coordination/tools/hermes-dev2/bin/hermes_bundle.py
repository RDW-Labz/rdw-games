#!/usr/bin/python3 -I
"""Verify and install the prebuilt Hermes bundle on dev2 (decision #384, round 4).

The bundle is built OFF dev2 by .github/workflows/hermes-bundle.yml: the
pinned hermes-agent source, its .venv and the Python runtime, all laid out
for /opt/hermes-w/hermes-agent. No downloaded build code ever runs on dev2:
setup only checks the file's sha256 and architecture, then unpacks it here.

    hermes_bundle.py --verify BUNDLE SHA256 ARCH
    hermes_bundle.py --install BUNDLE SHA256 ARCH DEST     (root; DEST=/opt/hermes-w/hermes-agent)

Refuses (exit 3, plain message) on: a sha256 or architecture mismatch; an
absolute member name or a ".." part; anything outside the one top folder
"hermes-agent/"; hard links, device files, FIFOs or anything not a regular
file, folder or symlink; setuid, setgid or sticky bits; a symlink whose
target leaves the bundle (absolute targets must point inside RUNTIME_ROOT, the
path the bundle was built for); a member
under a path that is itself a symlink; too many members or bytes. Files are
written root-owned with plain modes (folders 0755, files 0755 if any execute
bit was set, else 0644), into a fresh folder next to DEST, then moved into
place with rename. Python stdlib only.
"""

from __future__ import annotations

import hashlib
import os
import platform
import posixpath
import shutil
import stat
import sys
import tarfile
import time

TOP = "hermes-agent"
# The bundle is built AT this path (the venv's python symlink and shebangs are
# absolute), so an absolute symlink target must point inside it.
RUNTIME_ROOT = "/opt/hermes-w/hermes-agent"
MAX_MEMBERS = 200_000
MAX_BYTES = 6 * 1024**3


class BundleRefused(Exception):
    """A bundle we won't install: the message is shown to Braden."""


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify(path: str, want_sha: str, want_arch: str, machine: str | None = None) -> None:
    """Raise BundleRefused unless the file's sha256 and this machine's architecture match."""
    if len(want_sha) != 64 or any(c not in "0123456789abcdef" for c in want_sha):
        raise BundleRefused("BUNDLE_SHA256 in config.conf is not set to a 64-character sha256 (paste the "
                            "value from the hermes-bundle CI run)")
    arch = machine if machine is not None else platform.machine()
    if arch != want_arch:
        raise BundleRefused(f"this machine is {arch}, the bundle is for {want_arch}")
    got = sha256_file(path)
    if got != want_sha:
        raise BundleRefused(f"bundle sha256 is {got}, config.conf wants {want_sha}")


def _parts(name: str) -> list[str]:
    return [p for p in name.split("/") if p not in ("", ".")]


def check_members(members: list[tarfile.TarInfo], runtime_root: str = RUNTIME_ROOT) -> None:
    """Raise BundleRefused on any member we won't write (see the module doc)."""
    if len(members) > MAX_MEMBERS:
        raise BundleRefused(f"bundle has {len(members)} members (limit {MAX_MEMBERS})")
    total = 0
    links: set[str] = set()
    for m in members:
        name = m.name
        if name.startswith("/") or "\\" in name:
            raise BundleRefused(f"refusing member {name!r}: absolute or backslash path")
        parts = _parts(name)
        if ".." in parts:
            raise BundleRefused(f"refusing member {name!r}: '..' in the path")
        if not parts or parts[0] != TOP:
            raise BundleRefused(f"refusing member {name!r}: outside the top folder {TOP}/")
        clean = "/".join(parts)
        for i in range(1, len(parts)):
            if "/".join(parts[:i]) in links:
                raise BundleRefused(f"refusing member {name!r}: it sits under a symlink")
        if m.islnk():
            raise BundleRefused(f"refusing member {name!r}: hard link")
        if not (m.isreg() or m.isdir() or m.issym()):
            raise BundleRefused(f"refusing member {name!r}: not a regular file, folder or symlink")
        if m.mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
            raise BundleRefused(f"refusing member {name!r}: setuid, setgid or sticky bit")
        if m.issym():
            target = m.linkname
            if target.startswith("/"):
                inside = posixpath.normpath(target)
                if inside != runtime_root and not inside.startswith(runtime_root.rstrip("/") + "/"):
                    raise BundleRefused(f"refusing symlink {name!r} -> {target!r}: points outside {runtime_root}")
            else:
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(clean), target))
                if resolved != TOP and not resolved.startswith(TOP + "/"):
                    raise BundleRefused(f"refusing symlink {name!r} -> {target!r}: points outside the bundle")
            links.add(clean)
        total += max(m.size, 0)
        if total > MAX_BYTES:
            raise BundleRefused(f"bundle unpacks to more than {MAX_BYTES} bytes")


def extract(bundle: str, dest: str) -> str:
    """Unpack into a fresh root-owned folder next to DEST; return its path (not yet moved)."""
    parent = os.path.dirname(dest.rstrip("/"))
    stage = os.path.join(parent, f".{TOP}.new-{os.getpid()}-{int(time.time())}")
    os.mkdir(stage, 0o700)
    try:
        _unpack(bundle, dest, stage)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    os.chmod(stage, 0o755)
    return os.path.join(stage, TOP)


def _unpack(bundle: str, dest: str, stage: str) -> None:
    with tarfile.open(bundle, "r:gz") as tf:
        members = tf.getmembers()
        check_members(members)
        for m in sorted(members, key=lambda x: x.name):
            path = os.path.join(stage, *_parts(m.name))
            if m.isdir():
                os.makedirs(path, 0o755, exist_ok=True)
                os.chmod(path, 0o755)
            elif m.issym():
                os.makedirs(os.path.dirname(path), 0o755, exist_ok=True)
                os.symlink(m.linkname, path)
            else:
                os.makedirs(os.path.dirname(path), 0o755, exist_ok=True)
                src = tf.extractfile(m)
                assert src is not None
                mode = 0o755 if m.mode & 0o111 else 0o644
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
                with os.fdopen(fd, "wb") as out:
                    shutil.copyfileobj(src, out)
                os.chmod(path, mode)


def install(bundle: str, want_sha: str, want_arch: str, dest: str) -> str:
    """Verify, unpack next to DEST, then swap it in with rename. Returns a status line."""
    verify(bundle, want_sha, want_arch)
    staged = extract(bundle, dest)
    stage_dir = os.path.dirname(staged)
    old = None
    if os.path.lexists(dest):
        old = os.path.join(os.path.dirname(dest), f".{TOP}.old-{int(time.time())}")
        os.rename(dest, old)
    os.rename(staged, dest)
    os.rmdir(stage_dir)
    if old:
        shutil.rmtree(old)
    return f"installed bundle {want_sha[:12]} at {dest}"


def main(argv: list[str]) -> int:
    try:
        if len(argv) == 5 and argv[1] == "--verify":
            verify(argv[2], argv[3], argv[4])
            print("bundle ok: sha256 and architecture match")
            return 0
        if len(argv) == 6 and argv[1] == "--install":
            if os.geteuid() != 0:
                print("run as root", file=sys.stderr)
                return 2
            print(install(argv[2], argv[3], argv[4], argv[5]))
            return 0
    except BundleRefused as exc:
        print(f"refusing: {exc}", file=sys.stderr)
        return 3
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
