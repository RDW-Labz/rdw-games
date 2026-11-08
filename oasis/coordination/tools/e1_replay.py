"""Controlled replay for swarm experiment E1 (coordination/swarm-metrics.md -> Experiments -> E1).

Re-runs past swarm runs that integrated red under two arms that differ in exactly one
factor: the manifest's top-level `selfCheck` flag (baseline: absent; candidate:
{"maxRetries": 1}). Same swarm binary for both arms (--swarm).

Usage:
  python3 coordination/tools/e1_replay.py --cases coordination/e1-cases.json \\
      --arm baseline|candidate --swarm /path/to/tools/swarm.mjs \\
      --work /private/tmp/oasis-e1 --results coordination/e1/results.jsonl \\
      --max-usd 40 [--only c1,c2] [--dry-run]

  python3 coordination/tools/e1_replay.py summary --results coordination/e1/results.jsonl
"""
import argparse
import copy
import datetime as dt
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

UV_BIN = "/Users/prime/.project-swarm/toolchains/bin/uv"


def default_runner(cmd, cwd=None, timeout=None, env=None):
    return subprocess.run(cmd, cwd=cwd, timeout=timeout, capture_output=True, text=True, env=env)


def swarm_env():
    """PATH for the `node swarm ... run` / `integrate` subprocesses.

    do_install shells out to uv via its absolute UV_BIN, but the manifest checks that a
    swarm run/integrate executes internally call bare `uv` (and `node`); those subprocesses
    otherwise inherit a PATH without uv's directory, so a check that runs `uv ...` fails to
    start ("could not start uv") and gets scored as a red check instead of an env problem.
    Prepend uv's dir, node's dir, and a bare-bones fallback ahead of the rest of the
    inherited PATH; never drop what was already there.
    """
    node_bin = shutil.which("node") or sys.executable
    node_dir = str(Path(node_bin).resolve().parent)
    prefix = [str(Path(UV_BIN).parent), node_dir, "/usr/bin", "/bin"]
    rest = os.environ.get("PATH", "")
    env = dict(os.environ)
    env["PATH"] = ":".join(prefix) + (":" + rest if rest else "")
    return env


def iso(epoch):
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat()


def parse_first_json_line(text):
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise ValueError("no JSON line found in output")


def tail_text(proc, n=20):
    lines = ((proc.stdout or "") + "\n" + (proc.stderr or "")).splitlines()
    return "\n".join(lines[-n:])


# ---------------------------------------------------------------------------
# results.jsonl helpers


def load_results(path):
    p = Path(path)
    if not p.exists():
        return []
    rows = []
    with open(p) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def append_result(path, row):
    with open(path, "a") as f:
        f.write(json.dumps(row) + "\n")


def is_done(rows, case_id, arm):
    return any(r.get("case") == case_id and r.get("arm") == arm for r in rows)


def budget_used(rows):
    return sum(r.get("cost_usd", 0) or 0 for r in rows)


# ---------------------------------------------------------------------------
# manifest / context handling


def gather_job_paths(manifest):
    """Yield (jobid, path) for every context/output path across manifest jobs."""
    for job in manifest.get("jobs", []) or []:
        jobid = job.get("id")
        for path in job.get("context") or []:
            yield jobid, path
        for path in job.get("outputs") or []:
            yield jobid, path


def ensure_context(dir_, root, run_dir, manifest):
    """Copy every missing manifest context/output path into the clone.

    Returns (copied_from_worktree, missing) where copied_from_worktree lists
    paths pulled from the live worktree (possible drift) rather than the
    frozen run base.
    """
    copied_from_worktree = []
    missing = []
    seen = set()
    # A job's outputs are what it must produce: never copy them from the live
    # worktree (that is the finished answer). Only the frozen run base may
    # restore an output, because it holds the file as it was before the run;
    # an output absent from both is a new file the job creates, not missing.
    outputs = {path for job in manifest.get("jobs", []) or [] for path in job.get("outputs") or []}
    for jobid, path in gather_job_paths(manifest):
        if path in seen:
            continue
        seen.add(path)
        dest = dir_ / path
        if dest.exists():
            continue
        base_src = run_dir / "base" / (jobid or "") / path
        if base_src.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(base_src, dest)
            continue
        if path in outputs:
            continue
        root_src = root / path
        if root_src.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root_src, dest)
            copied_from_worktree.append(path)
            continue
        missing.append(path)
    return copied_from_worktree, missing


def transform_manifest(manifest, arm, model):
    """Drop mutants keys, pin each job's model, and set selfCheck per arm."""
    m = copy.deepcopy(manifest)
    m.pop("mutants", None)
    m.pop("mutantsFile", None)
    for job in m.get("jobs", []) or []:
        job.pop("mutants", None)
        job.pop("mutantsFile", None)
        job["model"] = model
    m.pop("selfCheck", None)
    if arm == "candidate":
        m["selfCheck"] = {"maxRetries": 1}
    return m


# ---------------------------------------------------------------------------
# cost / retries / diff helpers


def job_cost(job):
    """Sum every numeric costUsd found anywhere under a job object."""
    total = 0.0

    def walk(obj):
        nonlocal total
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k == "costUsd" and isinstance(v, (int, float)):
                    total += v
                walk(v)
        elif isinstance(obj, list):
            for item in obj:
                walk(item)

    walk(job)
    return total


def find_error_checks(state):
    """Collect (name, hint) for every check in state.json that shows a spawn failure
    (status "error") rather than a real pass/fail. selfCheck records carry no exitCode,
    so a missing exitCode alone never means a spawn failure.

    Looks at the run's own top-level `checks` and at every job's `selfCheck` record
    (candidate-arm check-retry loop): the flag directly under selfCheck, and under each
    retry attempt. A spawn error must never be scored as an ordinary red check.
    """
    found = []

    def scan(checks):
        for c in checks or []:
            if not isinstance(c, dict):
                continue
            if c.get("status") == "error":
                name = c.get("name") or "?"
                hint = c.get("tail") or c.get("error") or (
                    f"status={c.get('status')!r} exitCode={c.get('exitCode')!r}"
                )
                found.append((name, hint))

    scan(state.get("checks"))
    for job in state.get("jobs") or []:
        sc = job.get("selfCheck") or {}
        scan(sc.get("checks"))
        for attempt in sc.get("attempts") or []:
            if isinstance(attempt, dict):
                scan(attempt.get("checks"))
    return found


def sum_state_cost(state):
    return sum(job_cost(j) for j in (state.get("jobs") or []))


def sum_state_retries(state):
    total = 0
    for j in state.get("jobs") or []:
        sc = j.get("selfCheck") or {}
        total += sc.get("retries", 0) or 0
    return total


def parse_numstat_removed(text):
    total = 0
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) >= 2 and parts[1].isdigit():
            total += int(parts[1])
    return total


def compute_test_files_changed(runner, dir_, base_commit, files):
    """Lines removed vs baseCommit for every integrated file whose path has "test"."""
    result = {}
    for f in files or []:
        path = f.get("path") if isinstance(f, dict) else f
        if not path or "test" not in path:
            continue
        proc = runner(
            ["git", "-C", str(dir_), "diff", "--numstat", base_commit, "--", path],
            cwd=None,
            timeout=60,
        )
        result[path] = parse_numstat_removed(proc.stdout)
    return result


# ---------------------------------------------------------------------------
# install


def do_install(runner, dir_):
    """Return None on success, else the last-20-lines tail of the failing command."""
    if (dir_ / "package-lock.json").exists():
        proc = runner(["npm", "ci", "--no-audit", "--no-fund"], cwd=str(dir_), timeout=1800)
        if proc.returncode != 0:
            return tail_text(proc)
    if (dir_ / "uv.lock").exists():
        proc = runner([UV_BIN, "sync", "--quiet"], cwd=str(dir_), timeout=1800)
        if proc.returncode != 0:
            return tail_text(proc)
        req = dir_ / "vendor" / "runtime-requirements.txt"
        if req.exists():
            proc = runner(
                [UV_BIN, "pip", "install", "--quiet", "--no-deps", "--require-hashes",
                 "-r", "vendor/runtime-requirements.txt"],
                cwd=str(dir_),
                timeout=1800,
            )
            if proc.returncode != 0:
                return tail_text(proc)
    return None


# ---------------------------------------------------------------------------
# case processing


def clone_and_checkout(runner, root, dir_, base_commit):
    proc = runner(
        ["git", "clone", "--quiet", "--no-hardlinks", str(root), str(dir_)],
        cwd=None,
        timeout=600,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"clone failed: {proc.stderr}")
    proc = runner(["git", "-C", str(dir_), "checkout", "--quiet", base_commit], cwd=None, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(f"checkout failed: {proc.stderr}")


def fail_row(case, arm, status, copied, started, tail):
    return {
        "case": case["id"],
        "set": case.get("set"),
        "arm": arm,
        "status": status,
        "tail": tail,
        "copied_from_worktree": copied,
        "started": started,
        "finished": iso(time.time()),
    }


def process_case(case, arm, work, swarm, runner, dry_run):
    started_epoch = time.time()
    started = iso(started_epoch)
    dir_ = Path(work) / f"{case['id']}-{arm}-{int(started_epoch)}"
    root = Path(case["root"])
    run_dir = root / ".swarm" / "runs" / case["run"]

    with open(run_dir / "state.json") as f:
        base_state = json.load(f)
    base_commit = base_state["baseCommit"]
    with open(run_dir / "manifest.json") as f:
        manifest = json.load(f)

    clone_and_checkout(runner, root, dir_, base_commit)

    copied, missing = ensure_context(dir_, root, run_dir, manifest)
    if missing:
        return {
            "case": case["id"],
            "set": case.get("set"),
            "arm": arm,
            "status": "invalid-missing-context",
            "missing": missing,
            "copied_from_worktree": copied,
            "started": started,
            "finished": iso(time.time()),
        }

    new_manifest = transform_manifest(manifest, arm, case["model"])
    manifest_dir = dir_ / ".swarm-manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / f"e1-{arm}.json"
    manifest_path.write_text(json.dumps(new_manifest, indent=2))

    if dry_run:
        return {
            "dry_run": True,
            "case": case["id"],
            "arm": arm,
            "dir": str(dir_),
            "manifest": str(manifest_path),
            "copied_from_worktree": copied,
        }

    install_tail = do_install(runner, dir_)
    if install_tail is not None:
        return fail_row(case, arm, "invalid-install", copied, started, install_tail)

    env = swarm_env()
    try:
        run_proc = runner(
            ["node", swarm, "--root", str(dir_), "run", str(manifest_path.relative_to(dir_))],
            cwd=str(dir_),
            timeout=3600,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return fail_row(case, arm, "run-failed", copied, started, "run timed out")
    if run_proc.returncode != 0:
        return fail_row(case, arm, "run-failed", copied, started, tail_text(run_proc))
    try:
        run_json = parse_first_json_line(run_proc.stdout)
        run_id = run_json["id"]
    except Exception as exc:
        return fail_row(case, arm, "run-failed", copied, started, f"could not parse run id: {exc}")

    try:
        int_proc = runner(
            ["node", swarm, "--root", str(dir_), "integrate", run_id],
            cwd=str(dir_),
            timeout=1800,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return fail_row(case, arm, "run-failed", copied, started, "integrate timed out")
    if int_proc.returncode != 0:
        return fail_row(case, arm, "run-failed", copied, started, tail_text(int_proc))
    try:
        integrate_json = parse_first_json_line(int_proc.stdout)
    except Exception as exc:
        return fail_row(case, arm, "run-failed", copied, started, f"could not parse integrate output: {exc}")

    state_path = dir_ / ".swarm" / "runs" / run_id / "state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}

    error_checks = find_error_checks(state)
    if error_checks:
        return {
            "case": case["id"],
            "set": case.get("set"),
            "arm": arm,
            "run_id": run_id,
            "status": "invalid-env",
            "checks": [name for name, _ in error_checks],
            "hints": [hint for _, hint in error_checks],
            "copied_from_worktree": copied,
            "started": started,
            "finished": iso(time.time()),
        }

    cost_usd = sum_state_cost(state)
    retries = sum_state_retries(state)

    checks = integrate_json.get("checks") or []
    failed_checks = [c.get("name") for c in checks if c.get("status") != "passed"]

    test_files_changed = compute_test_files_changed(
        runner, dir_, base_commit, integrate_json.get("files")
    )

    finished_epoch = time.time()
    return {
        "case": case["id"],
        "set": case.get("set"),
        "arm": arm,
        "run_id": run_id,
        "status": "ok",
        "first_integrate_green": bool(integrate_json.get("checksPassed")),
        "failed_checks": failed_checks,
        "cost_usd": round(cost_usd, 4),
        "wall_s": round(finished_epoch - started_epoch, 2),
        "retries": retries,
        "test_files_changed": test_files_changed,
        "copied_from_worktree": copied,
        "started": started,
        "finished": iso(finished_epoch),
    }


# ---------------------------------------------------------------------------
# replay loop / CLI


def replay(cases, arm, work, swarm, results_path, max_usd, only=None,
           dry_run=False, rerun=False, runner=default_runner, process_fn=process_case):
    for case in cases:
        if only and case["id"] not in only:
            continue
        rows = load_results(results_path)
        done = is_done(rows, case["id"], arm)
        if done and not rerun:
            print(json.dumps({"skipped": "already-done", "case": case["id"], "arm": arm}))
            continue
        used = budget_used(rows)
        if used >= max_usd:
            print(json.dumps({"stopped": "budget", "cost_usd": round(used, 2), "max_usd": max_usd}))
            return
        result = process_fn(case, arm, work, swarm, runner, dry_run)
        if done and rerun:
            result["rerun"] = True
        print(json.dumps(result))
        if not dry_run:
            append_result(results_path, result)


def cmd_replay(argv, runner=default_runner):
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", required=True)
    ap.add_argument("--arm", required=True, choices=["baseline", "candidate"])
    ap.add_argument("--swarm", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--results", required=True)
    ap.add_argument("--max-usd", type=float, required=True)
    ap.add_argument("--only")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--rerun", action="store_true")
    a = ap.parse_args(argv)

    with open(a.cases) as f:
        cases = json.load(f)
    only = set(a.only.split(",")) if a.only else None

    replay(cases, a.arm, a.work, a.swarm, a.results, a.max_usd, only=only,
           dry_run=a.dry_run, rerun=a.rerun, runner=runner)


def cmd_summary(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True)
    a = ap.parse_args(argv)

    rows = load_results(a.results)
    by_arm = {}
    for r in rows:
        by_arm.setdefault(r.get("arm"), []).append(r)

    for arm in sorted(by_arm):
        arm_rows = by_arm[arm]
        # A (case, arm) pair can have several rows (reruns); take the last row in
        # file order as the pair's outcome so a rerun never gets counted twice.
        last_by_case = {}
        for r in arm_rows:
            last_by_case[r.get("case")] = r
        dedup_rows = list(last_by_case.values())
        reruns = sum(1 for r in arm_rows if r.get("rerun"))

        cases = len(dedup_rows)
        ok = sum(1 for r in dedup_rows if r.get("status") == "ok")
        green = sum(1 for r in dedup_rows if r.get("first_integrate_green"))
        cost = sum(r.get("cost_usd", 0) or 0 for r in dedup_rows)
        walls = [r.get("wall_s") for r in dedup_rows if r.get("wall_s") is not None]
        print(json.dumps({
            "arm": arm,
            "cases": cases,
            "ok": ok,
            "green": green,
            "green_rate": round(green / cases, 2) if cases else None,
            "cost_usd": round(cost, 2),
            "cost_per_green": round(cost / green, 2) if green else None,
            "wall_s_median": statistics.median(walls) if walls else None,
            "reruns": reruns,
        }))

    by_case = {}
    for r in rows:
        by_case.setdefault(r.get("case"), {})[r.get("arm")] = r
    paired = []
    for case_id, arms in by_case.items():
        if "baseline" in arms and "candidate" in arms:
            paired.append({
                "case": case_id,
                "set": arms["baseline"].get("set"),
                "baseline_green": bool(arms["baseline"].get("first_integrate_green")),
                "candidate_green": bool(arms["candidate"].get("first_integrate_green")),
            })
    print(json.dumps({"paired": paired}))


def main(argv=None, runner=None):
    argv = sys.argv[1:] if argv is None else argv
    runner = runner or default_runner
    if argv and argv[0] == "summary":
        return cmd_summary(argv[1:])
    return cmd_replay(argv, runner)


if __name__ == "__main__":
    main()
