#!/usr/bin/python3 -I
"""Stop rules for Hermes workers on dev2 (decision #384). Runs every 30 s.

Stops every hermes-w-job@ unit and writes /var/lib/hermes-jobs/STOP (with
the reason) when any of these holds:

    free RAM (MemAvailable) under MIN_MEM_GB
    disk free under MIN_DISK_GB
    the size-capped work tmpfs over WORK_FULL_STOP (90%) full
    model speed under SPEED_FLOOR x the baseline (tokens/s)
    the speed probe failing PROBE_FAILURES_STOP (2) times in a row

The speed probe is one fixed small completion through the proxy's Unix
socket, for MODEL from config.conf. Root has its own upstream and
connection slot in the proxy, so busy jobs can't crowd the probe out; a
probe that still fails or is refused counts toward the stop rule instead
of leaving it blind. It runs only while jobs are active, at most every
PROBE_EVERY seconds, so an idle dev2 gets no extra GPU load. The baseline
is measured once with `watchdog.py --rebaseline` (setup does it).

Every run also reaps dead jobs: a work folder whose unit is inactive or
failed (a dependency failed, so its finish unit never ran) is published as
"failed: <reason>" and removed, so it stops counting toward MAX_WORKERS.

The watchdog never deletes the STOP file: Braden does, after reading why.
It also removes finished replies older than OUTBOX_TTL_MIN.
"""

from __future__ import annotations

import grp
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from hermes_dev2_common import GIB, load_config, unix_json  # noqa: E402
from hermes_jobs_root import reap_orphans  # noqa: E402

ROOT = Path("/var/lib/hermes-jobs")
BASELINE = ROOT / "baseline.json"
LAST_PROBE = ROOT / "last-probe.json"
PROBE_EVERY = 120
WORK_FULL_STOP = 0.9
PROBE_FAILURES_STOP = 2
PROBE_PROMPT = "Count from 1 to 40, separated by spaces, and nothing else."
PROBE_MAX_TOKENS = 64


def decide(mem_available: int, disk_free: int, speed: float | None, baseline: float | None,
           config: dict[str, str], probe_failures: int = 0, work_used: float = 0.0) -> list[str]:
    """The stop reasons, empty when all is well. Pure; bytes, tokens/s and a 0-1 fraction in."""
    reasons = []
    if work_used > WORK_FULL_STOP:
        reasons.append(f"work tmpfs {work_used:.0%} full > {WORK_FULL_STOP:.0%}")
    if probe_failures >= PROBE_FAILURES_STOP:
        reasons.append(f"speed probe failed {probe_failures} times in a row")
    if mem_available < float(config["MIN_MEM_GB"]) * GIB:
        reasons.append(f"free RAM {mem_available / GIB:.1f} GB < {config['MIN_MEM_GB']} GB")
    if disk_free < float(config["MIN_DISK_GB"]) * GIB:
        reasons.append(f"disk free {disk_free / GIB:.1f} GB < {config['MIN_DISK_GB']} GB")
    if speed is not None and baseline:
        if speed < float(config["SPEED_FLOOR"]) * baseline:
            reasons.append(f"model speed {speed:.1f} tok/s < {config['SPEED_FLOOR']} x baseline {baseline:.1f} tok/s")
    return reasons


def mem_available(meminfo: str) -> int:
    """MemAvailable from /proc/meminfo text, in bytes."""
    for line in meminfo.splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise ValueError("no MemAvailable in /proc/meminfo")


def probe_speed(socket_path: str, model: str, call=unix_json) -> float:
    """Tokens per second for one fixed small completion through the proxy socket."""
    body = {"model": model, "max_tokens": PROBE_MAX_TOKENS, "temperature": 0,
            "messages": [{"role": "user", "content": PROBE_PROMPT}]}
    started = time.monotonic()
    data = call(socket_path, "POST", "/v1/chat/completions", body)
    elapsed = max(time.monotonic() - started, 1e-3)
    tokens = int((data.get("usage") or {}).get("completion_tokens") or 0)
    if tokens <= 0:
        raise ValueError("probe reply has no completion_tokens")
    return tokens / elapsed


def work_used_fraction(path: Path) -> float:
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return 0.0
    return usage.used / usage.total if usage.total else 0.0


def active_jobs() -> list[str]:
    out = subprocess.run(["/usr/bin/systemctl", "list-units", "--type=service", "--state=active,activating",
                          "--no-legend", "--plain", "hermes-w-job@*"], capture_output=True, text=True).stdout
    return [line.split()[0] for line in out.splitlines() if line.strip()]


def stop_all(reasons: list[str]) -> None:
    stop = ROOT / "STOP"
    if not stop.exists():  # keep the first reason; Braden reads it before removing the file
        stop.write_text(time.strftime("%Y-%m-%dT%H:%M:%S%z ") + "; ".join(reasons) + "\n")
    subprocess.run(["/usr/bin/systemctl", "stop", "hermes-w-job@*.service"], check=False)
    print("STOP: " + "; ".join(reasons), flush=True)


def prune_outbox(ttl_min: int, now: float) -> None:
    for job in (ROOT / "outbox").glob("*"):
        if job.is_dir() and now - job.stat().st_mtime > ttl_min * 60:
            shutil.rmtree(job, ignore_errors=True)


def check_write(work: Path) -> int:
    """The pre-flight's proof that this unit's sandbox can write the work tmpfs (it reaps there)."""
    marker = work / f".watchdog-check-{os.getpid()}"
    try:
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        os.unlink(marker)
    except OSError as exc:
        print(f"watchdog can't write {work}: {exc.__class__.__name__}", flush=True)
        return 3
    print(f"watchdog can write {work}", flush=True)
    return 0


def main(argv: list[str]) -> int:
    config = load_config()
    model = config["MODEL"]
    if argv[1:] == ["--rebaseline"]:
        speeds = [probe_speed(config["PROXY_SOCKET"], model) for _ in range(3)]
        BASELINE.write_text(json.dumps({"tokens_per_s": sorted(speeds)[1], "at": time.time()}) + "\n")
        print(f"baseline {sorted(speeds)[1]:.1f} tok/s (median of 3)")
        return 0
    if argv[1:] == ["--check-write"]:
        return check_write(ROOT / "work")
    if argv[1:] not in ([], ["--run"]):
        print("usage: watchdog.py [--run | --rebaseline | --check-write]", file=sys.stderr)
        return 2
    prune_outbox(int(config["OUTBOX_TTL_MIN"]), time.time())
    for job_id in reap_orphans(ROOT, int(config["MAX_OUTPUT_BYTES"]), grp.getgrnam("hermes-sub").gr_gid):
        print(f"reaped dead job {job_id}", flush=True)
    speed = None
    baseline = json.loads(BASELINE.read_text())["tokens_per_s"] if BASELINE.exists() else None
    jobs = active_jobs()
    last = json.loads(LAST_PROBE.read_text()) if LAST_PROBE.exists() else {"at": 0}
    failures = int(last.get("failures", 0))
    if jobs and baseline and time.time() - last["at"] >= PROBE_EVERY:
        try:
            speed = probe_speed(config["PROXY_SOCKET"], model)
            failures = 0
        except Exception as exc:  # noqa: BLE001 - any probe failure is logged by class name only
            failures += 1
            print(f"speed probe failed ({failures} in a row): {exc.__class__.__name__}", flush=True)
        LAST_PROBE.write_text(json.dumps({"at": time.time(), "tokens_per_s": speed, "failures": failures}) + "\n")
    reasons = decide(mem_available(Path("/proc/meminfo").read_text()), shutil.disk_usage(ROOT).free,
                     speed, baseline, config, probe_failures=failures if jobs else 0,
                     work_used=work_used_fraction(ROOT / "work"))
    if reasons:
        stop_all(reasons)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
