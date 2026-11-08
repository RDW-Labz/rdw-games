#!/usr/bin/python3 -I
"""The only command the Mac's SSH key may run on dev2 (decision #384).

Installed as /opt/hermes-sub/bin/dispatch and named in hermes-sub's
authorized_keys as `restrict,command="/opt/hermes-sub/bin/dispatch"`, so
whatever the Mac asks for arrives in SSH_ORIGINAL_COMMAND and nothing else
runs. Verbs:

    submit            job JSON on stdin: {"id", "model", "prompt"}
    status <id>       one line: running | done <exit> | unknown
    fetch <id>        the job's stream-json output, unchanged (non-destructive)
    cancel <id>       stops the job

Refusals (exit 3, one plain line on stderr): outside the off-hours window,
STOP file present, disk free under the floor, bad id, model other than
MODEL, prompt too large: checked here for a quick answer. MAX_WORKERS is
decided ONLY by root in hermes-job-start, under a lock: hermes-sub can't
list work/ (root 0711), so dispatch never tries; root's refusal line comes
back to the Mac unchanged. hermes-sub never writes a job file itself. The
job JSON goes to the root wrapper on stdin (sudoers: that wrapper with no
arguments, and hermes-job-stop).

Test hook: env_from_os has one marked block that lets the Mac tests drive
the REAL submit path against a fake tree (no sudo). setup-dev2.sh strips
that block from the copy it installs (hermes_dev2_common.strip_test_hook),
so the installed dispatch has no such hook at all.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from hermes_dev2_common import GIB, in_window, load_config, loads_strict, valid_job_id  # noqa: E402

ROOT = Path("/var/lib/hermes-jobs")
UNIT = "hermes-w-job@{}.service"
START = "/opt/hermes-dev2/sbin/hermes-job-start"
STOP = "/opt/hermes-dev2/sbin/hermes-job-stop"


class Refused(Exception):
    """A request we turn down on purpose (exit 3)."""


@dataclass
class Env:
    """Everything dispatch touches, injectable for tests."""
    config: dict[str, str]
    root: Path = ROOT
    now: Callable[[], datetime] = lambda: datetime.now(ZoneInfo("UTC"))
    disk_free: Callable[[Path], int] = lambda p: shutil.disk_usage(p).free
    unit_state: Callable[[str], str] = field(default=lambda job_id: _unit_state(job_id))
    sudo: Callable[..., tuple[int, str]] = field(default=lambda argv, stdin=b"": _sudo(argv, stdin))
    start_wrapper: str = START
    stop_wrapper: str = STOP


def _sudo(argv: list[str], stdin: bytes, direct: bool = False) -> tuple[int, str]:
    p = subprocess.run(argv if direct else ["/usr/bin/sudo", "-n", *argv], input=stdin, capture_output=True)
    return p.returncode, (p.stdout + p.stderr).decode(errors="replace").strip()


def _unit_state(job_id: str) -> str:
    return subprocess.run(["/usr/bin/systemctl", "is-active", UNIT.format(job_id)],
                          capture_output=True, text=True).stdout.strip()


def env_from_os(environ: dict[str, str] = os.environ) -> Env:
    """The production Env (the repo copy also has a test path, stripped on install)."""
    # >>> test-hook (setup-dev2.sh strips these lines from the installed copy)
    test_root = environ.get("HERMES_DEV2_TEST_ROOT")
    if test_root and "SSH_CONNECTION" not in environ:
        base = Path(test_root)
        return Env(config=load_config(base / "config.conf"), root=base / "var",
                   unit_state=lambda job_id: "inactive",
                   sudo=lambda argv, stdin=b"": _sudo(argv, stdin, direct=True),
                   start_wrapper=str(base / "sbin" / "hermes-job-start"),
                   stop_wrapper=str(base / "sbin" / "hermes-job-stop"))
    # <<< test-hook
    return Env(config=load_config())


def check_can_start(env: Env) -> None:
    """Raise Refused unless a new job may start now."""
    c = env.config
    local = env.now().astimezone(ZoneInfo(c["WINDOW_TZ"]))
    if not in_window(local.hour, int(c["WINDOW_START"]), int(c["WINDOW_END"])):
        raise Refused(f"outside the off-hours window ({c['WINDOW_START']}:00-{c['WINDOW_END']}:00 {c['WINDOW_TZ']}); now {local:%H:%M}")
    if (env.root / "STOP").exists():
        reason = (env.root / "STOP").read_text(errors="replace").strip()[:200]
        raise Refused(f"STOP file present: {reason or 'no reason given'}")
    if env.disk_free(env.root) < float(c["MIN_DISK_GB"]) * GIB:
        raise Refused(f"disk free under {c['MIN_DISK_GB']} GB")
    # MAX_WORKERS: root decides it in hermes-job-start (hermes-sub can't list work/).


def parse_job(raw: bytes, config: dict[str, str]) -> dict[str, str]:
    """Validate the submitted job JSON; return {id, model, prompt}."""
    if len(raw) > int(config["MAX_PROMPT_BYTES"]) + 4096:
        raise Refused("job too large")
    try:
        job = loads_strict(raw)
    except (ValueError, UnicodeDecodeError):
        raise Refused("job is not JSON (or repeats a key)") from None
    if not isinstance(job, dict) or set(job) != {"id", "model", "prompt"}:
        raise Refused("job must have exactly id, model, prompt")
    if not isinstance(job["id"], str) or not valid_job_id(job["id"]):
        raise Refused("bad job id")
    if job["model"] != config["MODEL"]:
        raise Refused("model not allowed")
    if not isinstance(job["prompt"], str) or not job["prompt"].strip():
        raise Refused("empty prompt")
    if len(job["prompt"].encode()) > int(config["MAX_PROMPT_BYTES"]):
        raise Refused("prompt too large")
    return job


def submit(env: Env, raw: bytes, out=sys.stdout) -> int:
    job = parse_job(raw, env.config)
    if (env.root / "work" / job["id"]).exists() or (env.root / "outbox" / job["id"]).exists():
        print("exists", file=out)  # a retried submit after a dropped link
        return 0
    check_can_start(env)
    rc, said = env.sudo([env.start_wrapper], raw)
    if rc != 0 or said.splitlines()[-1:] not in (["ok"], ["exists"]):
        raise Refused(said.removeprefix("refused: ")[:200] or "job did not start")
    print(said.splitlines()[-1], file=out)
    return 0


def status(env: Env, job_id: str, out=sys.stdout) -> int:
    outbox = env.root / "outbox" / job_id
    if (outbox / "exit").exists():
        reason = (outbox / "reason").read_text(errors="replace").strip()[:200] if (outbox / "reason").exists() else ""
        print(f"done {(outbox / 'exit').read_text().strip() or '1'}" + (f" {reason}" if reason else ""), file=out)
    elif (env.root / "work" / job_id).exists() or env.unit_state(job_id) in ("active", "activating", "deactivating"):
        print("running", file=out)  # the work folder exists from start until the reply is in outbox/
    else:
        print("unknown", file=out)
    return 0


def fetch(env: Env, job_id: str, out=sys.stdout.buffer) -> int:
    stream = env.root / "outbox" / job_id / "stream.jsonl"
    if not stream.exists():
        raise Refused("no output for that job")
    out.write(stream.read_bytes())
    out.flush()
    return 0


def cancel(env: Env, job_id: str, out=sys.stdout) -> int:
    rc, _ = env.sudo([env.stop_wrapper, job_id])
    print("cancelled" if rc == 0 else "not running", file=out)
    return 0


def run(command: str, env: Env, stdin: bytes = b"") -> int:
    """Route one SSH_ORIGINAL_COMMAND. Unknown verbs and bad ids are refused."""
    try:
        words = shlex.split(command or "")
    except ValueError:
        raise Refused("unparseable command") from None
    if words == ["submit"]:
        return submit(env, stdin)
    if len(words) == 2 and words[0] in ("status", "fetch", "cancel"):
        if not valid_job_id(words[1]):
            raise Refused("bad job id")
        return {"status": status, "fetch": fetch, "cancel": cancel}[words[0]](env, words[1])
    raise Refused("allowed: submit | status <id> | fetch <id> | cancel <id>")


def main() -> int:
    env = env_from_os()
    command = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    try:
        stdin = sys.stdin.buffer.read(int(env.config["MAX_PROMPT_BYTES"]) + 4097) if command.strip() == "submit" else b""
        return run(command, env, stdin)
    except Refused as why:
        print(f"refused: {why}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
