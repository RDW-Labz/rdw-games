"""Root-only job bookkeeping for Hermes workers on dev2 (decision #384).

Used by hermes-job-finish (hermes-job-finish@<id>.service), hermes-job-start and the
watchdog, all as root. Files in a work folder belong to hermes-w, so every
read goes through O_NOFOLLOW from a directory fd, and nothing is ever
chmod'd or chown'd through a path hermes-w or hermes-sub controls.

    finish(id)          copy the reply into a NEW outbox/<id>/, delete work/<id>
    reap_orphans(...)   a job whose unit is inactive or failed but whose work
                        folder is still there (its finish unit never ran:
                        e.g. the forwarder or the proxy failed, so the job
                        failed on a dependency) is published as
                        "failed: <reason>" and its folder removed, so it
                        stops counting toward MAX_WORKERS
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import time
from pathlib import Path
from typing import Callable

from hermes_dev2_common import valid_job_id

ROOT = Path("/var/lib/hermes-jobs")
UNIT = "hermes-w-job@{}.service"
SYSTEMCTL = "/usr/bin/systemctl"
# A job folder younger than this is never reaped: the unit may still be
# queued behind its forwarder (`systemctl start --no-block`).
ORPHAN_MIN_AGE_S = 120
FAILED_EXIT = b"125\n"


def read_plain(dir_fd: int, name: str, limit: int, tail: bool = False) -> bytes:
    """A regular file under dir_fd, never through a link; b'' if missing or not plain."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    except OSError:
        return b""
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return b""
        if tail:
            size = os.fstat(fd).st_size
            os.lseek(fd, max(0, size - limit), os.SEEK_SET)
        chunks, left = [], limit
        while left > 0 and (chunk := os.read(fd, min(65536, left))):
            chunks.append(chunk)
            left -= len(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def collect(work: Path, cap: int) -> dict[str, bytes]:
    try:
        dfd = os.open(work / "out", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        return {"stream.jsonl": b"", "exit": b"124\n"}
    try:
        stream = read_plain(dfd, "stream.jsonl", cap)
        err = read_plain(dfd, "stderr.txt", 4000, tail=True)
        code = bytes(c for c in read_plain(dfd, "exit", 8) if 48 <= c <= 57)
    finally:
        os.close(dfd)
    files = {"stream.jsonl": stream, "exit": (code or b"124") + b"\n"}  # no exit file: stopped, timed out or crashed
    if err:
        files["stderr.tail"] = err
    return files


def publish(outbox: Path, job_id: str, files: dict[str, bytes], gid: int, owner_uid: int = 0) -> None:
    st = os.lstat(outbox)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != owner_uid:
        raise SystemExit("outbox is not a root-owned directory")
    target = outbox / job_id
    os.mkdir(target, 0o700)  # fails if anything is already there, link or not
    dfd = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name, data in files.items():
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
            try:
                os.write(fd, data)
                os.fchown(fd, owner_uid, gid)
                os.fchmod(fd, 0o640)
            finally:
                os.close(fd)
        os.fchown(dfd, owner_uid, gid)
        os.fchmod(dfd, 0o750)
    finally:
        os.close(dfd)


def remove_work(work: Path) -> None:
    if os.path.lexists(work):
        if os.path.islink(work):
            os.unlink(work)
        else:
            shutil.rmtree(work, ignore_errors=True)  # fd-based on Linux: never follows links


def finish(job_id: str, root: Path, cap: int, gid: int, owner_uid: int = 0, reason: str | None = None) -> None:
    """Publish the reply (or, with `reason`, a failure) and delete the work folder."""
    if not valid_job_id(job_id):
        raise SystemExit(2)
    work = root / "work" / job_id
    if reason is not None:
        files = {"stream.jsonl": b"", "exit": FAILED_EXIT, "reason": f"failed: {reason}\n".encode()[:300]}
    elif os.path.isdir(work) and not os.path.islink(work):
        files = collect(work, cap)
    else:
        files = {"stream.jsonl": b"", "exit": b"124\n"}
    try:
        publish(root / "outbox", job_id, files, gid, owner_uid)  # raises if anything is already there
    finally:
        remove_work(work)


def unit_result(job_id: str) -> tuple[str, str]:
    """(ActiveState, Result) of the job's unit, from systemctl show."""
    out = subprocess.run([SYSTEMCTL, "show", "-p", "ActiveState", "-p", "Result", UNIT.format(job_id)],
                         capture_output=True, text=True).stdout
    props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    return props.get("ActiveState", "unknown"), props.get("Result", "unknown")


def orphan_reason(active: str, result: str) -> str | None:
    """Why a job whose folder is still there is dead, or None while it may still run."""
    if active in ("active", "activating", "deactivating", "reloading"):
        return None
    if result == "dependency":
        return "the job's forwarder or the proxy did not start (dependency)"
    if result in ("success", "unknown", ""):
        return f"the job unit is {active or 'gone'} without a reply"
    return f"the job unit ended with {result}"


def reap_orphans(root: Path, cap: int, gid: int, owner_uid: int = 0, now: float | None = None,
                 state: Callable[[str], tuple[str, str]] = unit_result,
                 min_age: float = ORPHAN_MIN_AGE_S) -> list[str]:
    """Publish "failed: <reason>" for dead jobs that still hold a work folder; return their ids."""
    now = time.time() if now is None else now
    reaped = []
    work = root / "work"
    if not work.is_dir() or work.is_symlink():
        return reaped
    for entry in sorted(os.listdir(work)):
        if not valid_job_id(entry):
            continue
        try:
            age = now - os.lstat(work / entry).st_mtime
        except OSError:
            continue
        if age < min_age:
            continue
        reason = orphan_reason(*state(entry))
        if reason is None:
            continue
        try:
            finish(entry, root, cap, gid, owner_uid, reason=reason)
        except (OSError, SystemExit):
            pass  # an outbox entry already there: the work folder is still removed (finish's finally)
        reaped.append(entry)
    return reaped
