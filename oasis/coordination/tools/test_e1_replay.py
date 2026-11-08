import json
import subprocess
from pathlib import Path

import pytest

import e1_replay


class FakeRunner:
    """Injectable subprocess stand-in: register (predicate, handler) pairs."""

    def __init__(self):
        self.calls = []
        self.envs = []
        self.handlers = []

    def on(self, predicate, handler):
        self.handlers.append((predicate, handler))

    def __call__(self, cmd, cwd=None, timeout=None, env=None):
        self.calls.append(cmd)
        self.envs.append(env)
        for predicate, handler in self.handlers:
            if predicate(cmd):
                return handler(cmd, cwd, timeout)
        return subprocess.CompletedProcess(cmd, 0, "", "")


def clone_handler(cmd, cwd, timeout):
    Path(cmd[-1]).mkdir(parents=True, exist_ok=True)
    return subprocess.CompletedProcess(cmd, 0, "", "")


def is_run_cmd(cmd):
    return len(cmd) >= 5 and cmd[0] == "node" and cmd[4] == "run"


def is_integrate_cmd(cmd):
    return len(cmd) >= 5 and cmd[0] == "node" and cmd[4] == "integrate"


# ---------------------------------------------------------------------------
# budget stop


def test_budget_stop(tmp_path, capsys):
    results = tmp_path / "results.jsonl"
    results.write_text(json.dumps({"case": "c0", "arm": "baseline", "cost_usd": 50}) + "\n")
    cases = [{"id": "c1", "root": "r", "run": "run1", "set": "design", "failed": "test", "model": "sonnet"}]

    def process_fn(case, arm, work, swarm, runner, dry_run):
        raise AssertionError("process_fn must not run once budget is exhausted")

    e1_replay.replay(
        cases, "baseline", str(tmp_path / "work"), "swarm.mjs", str(results),
        max_usd=40, process_fn=process_fn,
    )
    lines = capsys.readouterr().out.strip().splitlines()
    data = json.loads(lines[-1])
    assert data["stopped"] == "budget"
    # nothing new appended
    assert len(results.read_text().strip().splitlines()) == 1


# ---------------------------------------------------------------------------
# skip already-done pair


def test_skip_already_done_pair(tmp_path):
    results = tmp_path / "results.jsonl"
    results.write_text(json.dumps({"case": "c1", "arm": "baseline", "cost_usd": 1}) + "\n")
    cases = [
        {"id": "c1", "root": "r", "run": "run1", "set": "design", "failed": "test", "model": "sonnet"},
        {"id": "c2", "root": "r", "run": "run2", "set": "design", "failed": "test", "model": "sonnet"},
    ]
    seen = []

    def process_fn(case, arm, work, swarm, runner, dry_run):
        seen.append(case["id"])
        return {"case": case["id"], "arm": arm, "set": case["set"], "status": "ok", "cost_usd": 1}

    e1_replay.replay(
        cases, "baseline", str(tmp_path / "work"), "swarm.mjs", str(results),
        max_usd=40, process_fn=process_fn,
    )
    assert seen == ["c2"]


def test_skip_already_done_prints_json_line(tmp_path, capsys):
    # lesson #144: a re-run must never go silent on an already-done pair.
    results = tmp_path / "results.jsonl"
    results.write_text(json.dumps({"case": "c1", "arm": "baseline", "cost_usd": 1}) + "\n")
    cases = [{"id": "c1", "root": "r", "run": "run1", "set": "design", "failed": "test", "model": "sonnet"}]

    def process_fn(case, arm, work, swarm, runner, dry_run):
        raise AssertionError("process_fn must not run for an already-done pair without --rerun")

    e1_replay.replay(
        cases, "baseline", str(tmp_path / "work"), "swarm.mjs", str(results),
        max_usd=40, process_fn=process_fn,
    )
    lines = [json.loads(l) for l in capsys.readouterr().out.strip().splitlines()]
    assert {"skipped": "already-done", "case": "c1", "arm": "baseline"} in lines


def test_rerun_runs_done_case_and_marks_result(tmp_path):
    results = tmp_path / "results.jsonl"
    results.write_text(json.dumps({"case": "c1", "arm": "baseline", "cost_usd": 1}) + "\n")
    cases = [{"id": "c1", "root": "r", "run": "run1", "set": "design", "failed": "test", "model": "sonnet"}]
    seen = []

    def process_fn(case, arm, work, swarm, runner, dry_run):
        seen.append(case["id"])
        return {"case": case["id"], "arm": arm, "set": case["set"], "status": "ok", "cost_usd": 2}

    e1_replay.replay(
        cases, "baseline", str(tmp_path / "work"), "swarm.mjs", str(results),
        max_usd=40, rerun=True, process_fn=process_fn,
    )
    assert seen == ["c1"]
    rows = [json.loads(l) for l in results.read_text().strip().splitlines()]
    assert len(rows) == 2
    assert rows[-1]["case"] == "c1"
    assert rows[-1]["rerun"] is True


# ---------------------------------------------------------------------------
# missing-context -> invalid


def test_missing_context_invalid(tmp_path):
    root = tmp_path / "root"
    run_dir = root / ".swarm" / "runs" / "run1"
    run_dir.mkdir(parents=True)
    (run_dir / "state.json").write_text(json.dumps({"baseCommit": "abc123"}))
    manifest = {
        "jobs": [
            {"id": "job1", "model": "sonnet", "context": ["src/missing.py"], "outputs": []},
        ],
    }
    (run_dir / "manifest.json").write_text(json.dumps(manifest))

    fr = FakeRunner()
    fr.on(lambda c: "clone" in c, clone_handler)

    case = {"id": "c1", "root": str(root), "run": "run1", "set": "design", "failed": "test", "model": "sonnet"}
    result = e1_replay.process_case(case, "baseline", str(tmp_path / "work"), "swarm.mjs", fr, dry_run=False)

    assert result["status"] == "invalid-missing-context"
    assert result["missing"] == ["src/missing.py"]
    assert result["copied_from_worktree"] == []


def test_missing_context_falls_back_to_worktree(tmp_path):
    root = tmp_path / "root2"
    run_dir = root / ".swarm" / "runs" / "run1"
    run_dir.mkdir(parents=True)
    (run_dir / "state.json").write_text(json.dumps({"baseCommit": "abc123"}))
    manifest = {"jobs": [{"id": "job1", "model": "sonnet", "context": ["src/live.py"], "outputs": []}]}
    (run_dir / "manifest.json").write_text(json.dumps(manifest))
    (root / "src").mkdir(parents=True)
    (root / "src" / "live.py").write_text("print('live')")

    fr = FakeRunner()
    fr.on(lambda c: "clone" in c, clone_handler)

    case = {"id": "c1", "root": str(root), "run": "run1", "set": "design", "failed": "test", "model": "sonnet"}
    result = e1_replay.process_case(case, "baseline", str(tmp_path / "work"), "swarm.mjs", fr, dry_run=True)

    assert result["copied_from_worktree"] == ["src/live.py"]
    dest = tmp_path / "work" / [p for p in (tmp_path / "work").iterdir()][0].name / "src" / "live.py"
    assert dest.exists()


# ---------------------------------------------------------------------------
# manifest transform for both arms


def test_manifest_transform_both_arms():
    manifest = {
        "mutants": {"x": 1},
        "jobs": [
            {"id": "j1", "model": "haiku", "mutants": {"y": 2}, "mutantsFile": "m.json", "context": ["a"]},
        ],
        "selfCheck": {"maxRetries": 3},
    }

    baseline = e1_replay.transform_manifest(manifest, "baseline", "sonnet")
    candidate = e1_replay.transform_manifest(manifest, "candidate", "sonnet")

    assert "mutants" not in baseline
    assert "mutants" not in baseline["jobs"][0]
    assert "mutantsFile" not in baseline["jobs"][0]
    assert baseline["jobs"][0]["model"] == "sonnet"
    assert "selfCheck" not in baseline

    assert "selfCheck" not in candidate["jobs"][0]
    assert candidate["selfCheck"] == {"maxRetries": 1}
    assert "mutants" not in candidate
    assert "mutants" not in candidate["jobs"][0]

    # original manifest is untouched
    assert "mutants" in manifest
    assert manifest["jobs"][0]["model"] == "haiku"
    assert manifest["selfCheck"] == {"maxRetries": 3}


# ---------------------------------------------------------------------------
# cost summing incl. nested costUsd


def test_job_cost_sums_nested_costUsd():
    job = {
        "id": "j1",
        "costUsd": 1.5,
        "selfCheck": {"retries": 1, "attempts": [{"costUsd": 0.25}, {"costUsd": 0.1}]},
    }
    assert e1_replay.job_cost(job) == pytest.approx(1.85)


def test_sum_state_cost_and_retries_across_jobs():
    state = {
        "jobs": [
            {"id": "j1", "costUsd": 1.5, "selfCheck": {"retries": 2, "attempts": [{"costUsd": 0.25}]}},
            {"id": "j2", "costUsd": 2.0},
        ]
    }
    assert e1_replay.sum_state_cost(state) == pytest.approx(3.75)
    assert e1_replay.sum_state_retries(state) == 2


# ---------------------------------------------------------------------------
# test_files_changed parsing


def test_compute_test_files_changed_parsing(tmp_path):
    fr = FakeRunner()

    def diff_handler(cmd, cwd, timeout):
        path = cmd[-1]
        if path == "src/foo.test.ts":
            return subprocess.CompletedProcess(cmd, 0, "3\t7\tsrc/foo.test.ts\n", "")
        if path == "src/baz.test.ts":
            return subprocess.CompletedProcess(cmd, 0, "0\t0\tsrc/baz.test.ts\n", "")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    fr.on(lambda c: c[0] == "git" and "diff" in c, diff_handler)

    files = ["src/foo.test.ts", "src/bar.ts", {"path": "src/baz.test.ts"}]
    result = e1_replay.compute_test_files_changed(fr, tmp_path, "abc123", files)

    assert result == {"src/foo.test.ts": 7, "src/baz.test.ts": 0}
    assert "src/bar.ts" not in result


# ---------------------------------------------------------------------------
# summary math incl. cost_per_green with zero greens (null)


def test_summary_cost_per_green_null_when_no_greens(tmp_path, capsys):
    results = tmp_path / "results.jsonl"
    rows = [
        {"case": "c1", "set": "design", "arm": "baseline", "status": "ok",
         "first_integrate_green": False, "cost_usd": 1.0, "wall_s": 10},
        {"case": "c2", "set": "design", "arm": "baseline", "status": "ok",
         "first_integrate_green": False, "cost_usd": 2.0, "wall_s": 20},
    ]
    results.write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    e1_replay.cmd_summary(["--results", str(results)])
    lines = [json.loads(l) for l in capsys.readouterr().out.strip().splitlines()]
    baseline_summary = next(l for l in lines if l.get("arm") == "baseline")

    assert baseline_summary["green"] == 0
    assert baseline_summary["cost_per_green"] is None
    assert baseline_summary["green_rate"] == 0.0
    assert baseline_summary["cost_usd"] == pytest.approx(3.0)


def test_summary_paired_and_green_math(tmp_path, capsys):
    results = tmp_path / "results.jsonl"
    rows = [
        {"case": "c1", "set": "design", "arm": "baseline", "status": "ok",
         "first_integrate_green": True, "cost_usd": 4.0, "wall_s": 10},
        {"case": "c1", "set": "design", "arm": "candidate", "status": "ok",
         "first_integrate_green": False, "cost_usd": 2.0, "wall_s": 5},
        {"case": "c2", "set": "design", "arm": "baseline", "status": "ok",
         "first_integrate_green": False, "cost_usd": 1.0, "wall_s": 8},
    ]
    results.write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    e1_replay.cmd_summary(["--results", str(results)])
    lines = [json.loads(l) for l in capsys.readouterr().out.strip().splitlines()]

    baseline_summary = next(l for l in lines if l.get("arm") == "baseline")
    assert baseline_summary["green"] == 1
    assert baseline_summary["cost_per_green"] == pytest.approx(5.0)

    paired_line = next(l for l in lines if "paired" in l)
    assert paired_line["paired"] == [
        {"case": "c1", "set": "design", "baseline_green": True, "candidate_green": False}
    ]


def test_summary_dedupes_reruns_by_last_row(tmp_path, capsys):
    # Same (case, arm) appears twice (a rerun): both rows are green, so the old
    # code double-counts green/cost. The last row must be the only one counted,
    # and the arm's rerun count must show up.
    results = tmp_path / "results.jsonl"
    rows = [
        {"case": "c1", "set": "design", "arm": "baseline", "status": "ok",
         "first_integrate_green": True, "cost_usd": 1.0, "wall_s": 10},
        {"case": "c1", "set": "design", "arm": "baseline", "status": "ok",
         "first_integrate_green": True, "cost_usd": 2.0, "wall_s": 20, "rerun": True},
    ]
    results.write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    e1_replay.cmd_summary(["--results", str(results)])
    lines = [json.loads(l) for l in capsys.readouterr().out.strip().splitlines()]
    baseline_summary = next(l for l in lines if l.get("arm") == "baseline")

    assert baseline_summary["cases"] == 1
    assert baseline_summary["green"] == 1
    assert baseline_summary["cost_usd"] == pytest.approx(2.0)
    assert baseline_summary["cost_per_green"] == pytest.approx(2.0)
    assert baseline_summary["reruns"] == 1


def test_outputs_are_never_copied_from_the_live_worktree(tmp_path):
    """A job's output missing at base is a new file: copying the finished one would leak the answer."""
    root = tmp_path / "root"; clone = tmp_path / "clone"; run_dir = tmp_path / "run"
    for d in (root, clone, run_dir):
        d.mkdir()
    (root / "tests").mkdir()
    (root / "tests" / "new.test.mjs").write_text("finished answer")
    (root / "ctx.md").write_text("context")
    manifest = {"jobs": [{"id": "j", "context": ["ctx.md", "tests/new.test.mjs"], "outputs": ["tests/new.test.mjs"]}]}
    copied, missing = e1_replay.ensure_context(clone, root, run_dir, manifest)
    assert not (clone / "tests" / "new.test.mjs").exists()
    assert copied == ["ctx.md"]
    assert missing == []


def test_run_gets_a_manifest_path_relative_to_root(tmp_path):
    # swarm refuses an absolute manifest path ("Invalid relative path"); s33 lost 4 arms to this.
    root = tmp_path / "root3"
    run_dir = root / ".swarm" / "runs" / "run1"
    run_dir.mkdir(parents=True)
    (run_dir / "state.json").write_text(json.dumps({"baseCommit": "abc123"}))
    manifest = {"jobs": [{"id": "job1", "model": "sonnet", "context": [], "outputs": []}]}
    (run_dir / "manifest.json").write_text(json.dumps(manifest))

    fr = FakeRunner()
    fr.on(lambda c: "clone" in c, clone_handler)
    fr.on(is_run_cmd, lambda c, cwd, t: subprocess.CompletedProcess(c, 1, "", "stop here"))

    case = {"id": "c1", "root": str(root), "run": "run1", "set": "design", "failed": "test", "model": "sonnet"}
    e1_replay.process_case(case, "baseline", str(tmp_path / "work"), "swarm.mjs", fr, dry_run=False)

    run_calls = [c for c in fr.calls if is_run_cmd(c)]
    assert run_calls, "swarm run was never called"
    manifest_arg = run_calls[0][5]
    assert not Path(manifest_arg).is_absolute()
    assert manifest_arg == ".swarm-manifests/e1-baseline.json"


# ---------------------------------------------------------------------------
# bug 1: swarm run/integrate subprocesses need uv's dir (and node's) on PATH


def test_swarm_env_prepends_uv_and_node_dirs(monkeypatch):
    monkeypatch.setenv("PATH", "/orig/one:/orig/two")
    monkeypatch.setattr(e1_replay.shutil, "which", lambda name: "/fake/node/bin/node")

    env = e1_replay.swarm_env()
    parts = env["PATH"].split(":")

    uv_dir = str(Path(e1_replay.UV_BIN).parent)
    assert parts[0] == uv_dir
    assert parts[1] == "/fake/node/bin"
    assert parts[2:4] == ["/usr/bin", "/bin"]
    # rest of the inherited PATH is kept, after the prepended entries
    assert parts[4:] == ["/orig/one", "/orig/two"]


def test_run_and_integrate_calls_get_swarm_env(tmp_path):
    root = tmp_path / "root4"
    run_dir = root / ".swarm" / "runs" / "run1"
    run_dir.mkdir(parents=True)
    (run_dir / "state.json").write_text(json.dumps({"baseCommit": "abc123"}))
    manifest = {"jobs": [{"id": "job1", "model": "sonnet", "context": [], "outputs": []}]}
    (run_dir / "manifest.json").write_text(json.dumps(manifest))

    fr = FakeRunner()
    fr.on(lambda c: "clone" in c, clone_handler)

    def run_handler(cmd, cwd, timeout):
        return subprocess.CompletedProcess(cmd, 0, json.dumps({"id": "runX"}) + "\n", "")

    def integrate_handler(cmd, cwd, timeout):
        state_dir = Path(cwd) / ".swarm" / "runs" / "runX"
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / "state.json").write_text(json.dumps({"jobs": [], "checks": []}))
        return subprocess.CompletedProcess(
            cmd, 0, json.dumps({"checksPassed": True, "checks": [], "files": []}) + "\n", ""
        )

    fr.on(is_run_cmd, run_handler)
    fr.on(is_integrate_cmd, integrate_handler)

    case = {"id": "c1", "root": str(root), "run": "run1", "set": "design", "failed": "test", "model": "sonnet"}
    result = e1_replay.process_case(case, "baseline", str(tmp_path / "work"), "swarm.mjs", fr, dry_run=False)

    assert result["status"] == "ok"

    expected_path = e1_replay.swarm_env()["PATH"]
    seen_run_or_integrate = False
    for cmd, env in zip(fr.calls, fr.envs):
        if is_run_cmd(cmd) or is_integrate_cmd(cmd):
            seen_run_or_integrate = True
            assert env is not None
            assert env["PATH"] == expected_path
    assert seen_run_or_integrate


# ---------------------------------------------------------------------------
# bug 2: a spawned-error check in state.json is invalid-env, never "ok"


def test_errored_check_in_state_json_is_invalid_env(tmp_path):
    root = tmp_path / "root5"
    run_dir = root / ".swarm" / "runs" / "run1"
    run_dir.mkdir(parents=True)
    (run_dir / "state.json").write_text(json.dumps({"baseCommit": "abc123"}))
    manifest = {"jobs": [{"id": "job1", "model": "sonnet", "context": [], "outputs": []}]}
    (run_dir / "manifest.json").write_text(json.dumps(manifest))

    fr = FakeRunner()
    fr.on(lambda c: "clone" in c, clone_handler)

    def run_handler(cmd, cwd, timeout):
        return subprocess.CompletedProcess(cmd, 0, json.dumps({"id": "runY"}) + "\n", "")

    def integrate_handler(cmd, cwd, timeout):
        state_dir = Path(cwd) / ".swarm" / "runs" / "runY"
        state_dir.mkdir(parents=True, exist_ok=True)
        checks = [{"name": "uv-sync", "status": "error", "exitCode": None, "tail": "could not start uv"}]
        (state_dir / "state.json").write_text(json.dumps({"jobs": [], "checks": checks}))
        return subprocess.CompletedProcess(
            cmd, 0, json.dumps({"checksPassed": False, "checks": checks, "files": []}) + "\n", ""
        )

    fr.on(is_run_cmd, run_handler)
    fr.on(is_integrate_cmd, integrate_handler)

    case = {"id": "c1", "root": str(root), "run": "run1", "set": "design", "failed": "test", "model": "sonnet"}
    result = e1_replay.process_case(case, "baseline", str(tmp_path / "work"), "swarm.mjs", fr, dry_run=False)

    assert result["status"] == "invalid-env"
    assert result["checks"] == ["uv-sync"]
    assert any("could not start uv" in h for h in result["hints"])
    assert "first_integrate_green" not in result


def test_errored_check_in_candidate_selfcheck_is_invalid_env(tmp_path):
    root = tmp_path / "root6"
    run_dir = root / ".swarm" / "runs" / "run1"
    run_dir.mkdir(parents=True)
    (run_dir / "state.json").write_text(json.dumps({"baseCommit": "abc123"}))
    manifest = {"jobs": [{"id": "job1", "model": "sonnet", "context": [], "outputs": []}]}
    (run_dir / "manifest.json").write_text(json.dumps(manifest))

    fr = FakeRunner()
    fr.on(lambda c: "clone" in c, clone_handler)

    def run_handler(cmd, cwd, timeout):
        return subprocess.CompletedProcess(cmd, 0, json.dumps({"id": "runZ"}) + "\n", "")

    def integrate_handler(cmd, cwd, timeout):
        state_dir = Path(cwd) / ".swarm" / "runs" / "runZ"
        state_dir.mkdir(parents=True, exist_ok=True)
        state = {
            "checks": [],
            "jobs": [
                {
                    "id": "job1",
                    "selfCheck": {
                        "retries": 1,
                        "attempts": [
                            {
                                "costUsd": 0.1,
                                "checks": [
                                    {"name": "uv-sync", "status": "error", "exitCode": None,
                                     "tail": "could not start uv"}
                                ],
                            }
                        ],
                    },
                }
            ],
        }
        (state_dir / "state.json").write_text(json.dumps(state))
        # integrate itself reports green: the errored check only shows up in the job's
        # own selfCheck retry record, not in the run's top-level checks.
        return subprocess.CompletedProcess(
            cmd, 0, json.dumps({"checksPassed": True, "checks": [], "files": []}) + "\n", ""
        )

    fr.on(is_run_cmd, run_handler)
    fr.on(is_integrate_cmd, integrate_handler)

    case = {"id": "c1", "root": str(root), "run": "run1", "set": "design", "failed": "test", "model": "sonnet"}
    result = e1_replay.process_case(case, "candidate", str(tmp_path / "work"), "swarm.mjs", fr, dry_run=False)

    assert result["status"] == "invalid-env"
    assert result["checks"] == ["uv-sync"]
    assert "first_integrate_green" not in result


def test_selfcheck_records_without_exit_codes_are_not_spawn_errors():
    # s33: candidate rows were thrown out because selfCheck records never store exitCode.
    state = {"checks": [], "jobs": [{"selfCheck": {"checks": [
        {"name": "test", "status": "failed"}, {"name": "lint", "status": "passed"}],
        "attempts": [{"checks": [{"name": "test", "status": "passed"}]}]}}]}
    assert e1_replay.find_error_checks(state) == []
    state["jobs"][0]["selfCheck"]["checks"].append({"name": "uv", "status": "error", "tail": "could not start uv"})
    assert [n for n, _ in e1_replay.find_error_checks(state)] == ["uv"]
