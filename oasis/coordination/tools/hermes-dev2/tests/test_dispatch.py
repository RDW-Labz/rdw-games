"""The forced SSH command: verbs, ids, window, MAX_WORKERS, STOP and disk refusals."""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from _load import HERE, config, load

dispatch = load("bin/dispatch.py", "dispatch")
CHI = ZoneInfo("America/Chicago")
GIB = 1024**3
CFG = config()
JID = "j-0123456789abcdef"


def at(hour, minute=0):
    return lambda: datetime(2026, 10, 14, hour, minute, tzinfo=CHI)


class DispatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for d in ("work", "outbox"):
            (self.root / d).mkdir()
        self.calls = []
        self.answer = (0, "ok")
        self.env = dispatch.Env(config=CFG, root=self.root, now=at(23), disk_free=lambda p: 80 * GIB,
                                unit_state=lambda i: "inactive",
                                sudo=lambda argv, stdin=b"": self.calls.append((argv, stdin)) or self.answer)

    def tearDown(self):
        self.tmp.cleanup()

    def job(self, **over):
        j = {"id": JID, "model": CFG["MODEL"], "prompt": "do the fake task"}
        j.update(over)
        return json.dumps(j).encode()

    def submit(self, raw, env=None):
        out = io.StringIO()
        dispatch.submit(env or self.env, raw, out=out)
        return out.getvalue().strip()

    def test_submit_hands_the_job_to_root_on_stdin_and_writes_nothing(self):
        raw = self.job()
        self.assertEqual(self.submit(raw), "ok")
        self.assertEqual(self.calls, [(["/opt/hermes-dev2/sbin/hermes-job-start"], raw)])
        self.assertEqual(set(self.root.rglob("*")), {self.root / "work", self.root / "outbox"})

    def test_retried_submit_is_exists_not_duplicate(self):
        (self.root / "work" / JID).mkdir()
        self.assertEqual(self.submit(self.job()), "exists")
        (self.root / "work" / JID).rmdir()
        (self.root / "outbox" / JID).mkdir()
        self.assertEqual(self.submit(self.job()), "exists")
        self.assertEqual(self.calls, [])

    def test_root_refusal_reaches_the_mac(self):
        self.answer = (3, "refused: 2 jobs already running (MAX_WORKERS)")
        with self.assertRaisesRegex(dispatch.Refused, "MAX_WORKERS"):
            self.submit(self.job())

    def test_window_refusals_and_edges(self):
        for hour, ok in [(21, False), (22, True), (2, True), (5, True), (6, False), (12, False)]:
            self.env.now = at(hour, 30)
            if ok:
                dispatch.check_can_start(self.env)
            else:
                with self.assertRaises(dispatch.Refused, msg=hour):
                    dispatch.check_can_start(self.env)

    def test_window_uses_chicago_not_utc(self):
        self.env.now = lambda: datetime(2026, 10, 14, 4, 0, tzinfo=ZoneInfo("UTC"))  # 23:00 Chicago (CDT)
        dispatch.check_can_start(self.env)
        self.env.now = lambda: datetime(2026, 10, 14, 23, 0, tzinfo=ZoneInfo("UTC"))  # 18:00 Chicago
        with self.assertRaises(dispatch.Refused):
            dispatch.check_can_start(self.env)

    def test_max_workers_is_roots_decision_never_a_listing(self):
        self.assertFalse(hasattr(self.env, "active_jobs"))  # dispatch has no way to count jobs itself
        self.answer = (3, "refused: 2 jobs already running (MAX_WORKERS)")
        with self.assertRaisesRegex(dispatch.Refused, "^2 jobs already running \\(MAX_WORKERS\\)$"):
            self.submit(self.job())
        self.assertEqual(len(self.calls), 1)  # root was asked; root said no

    def test_stop_file_and_disk(self):
        (self.root / "STOP").write_text("free RAM 6 GB")
        with self.assertRaisesRegex(dispatch.Refused, "STOP"):
            dispatch.check_can_start(self.env)
        (self.root / "STOP").unlink()
        self.env.disk_free = lambda p: 19 * GIB
        with self.assertRaisesRegex(dispatch.Refused, "disk"):
            dispatch.check_can_start(self.env)

    def test_bad_jobs_refused(self):
        for raw in [b"not json", json.dumps([1]).encode(), self.job(id="BAD_ID"), self.job(id="j-short"),
                    self.job(id="../../etc"), self.job(id="preflight"), self.job(id="0123456789abcdef"),
                    self.job(model="some-other-model"), self.job(prompt="  "),
                    json.dumps({"id": JID, "model": CFG["MODEL"], "prompt": "x", "env": {}}).encode()]:
            with self.assertRaises(dispatch.Refused, msg=raw[:40]):
                self.submit(raw)
        self.assertEqual(self.calls, [])

    def test_verbs_allowlist_and_ids(self):
        for cmd in ["", "bash", "submit now", "status", "status ../x", f"fetch {JID} extra",
                    "rm -rf /", f"status '{JID}; id'", "status J-UPPERCASE00", "status preflight"]:
            with self.assertRaises(dispatch.Refused, msg=cmd):
                dispatch.run(cmd, self.env)

    def test_status_states(self):
        def state():
            out = io.StringIO()
            dispatch.status(self.env, JID, out=out)
            return out.getvalue().strip()
        self.assertEqual(state(), "unknown")
        (self.root / "work" / JID).mkdir()  # right after start, before the unit is active
        self.assertEqual(state(), "running")
        (self.root / "outbox" / JID).mkdir()
        (self.root / "outbox" / JID / "exit").write_text("0\n")
        self.assertEqual(state(), "done 0")
        (self.root / "outbox" / JID / "exit").write_text("125\n")
        (self.root / "outbox" / JID / "reason").write_text("failed: the job's forwarder or the proxy did not start (dependency)\n")
        self.assertEqual(state(), "done 125 failed: the job's forwarder or the proxy did not start (dependency)")

    def test_fetch_is_unchanged_bytes(self):
        (self.root / "outbox" / JID).mkdir()
        raw = b'{"type":"result","exit_code":0,"text":"{}"}\n'
        (self.root / "outbox" / JID / "stream.jsonl").write_bytes(raw)
        out = io.BytesIO()
        dispatch.fetch(self.env, JID, out=out)
        self.assertEqual(out.getvalue(), raw)


FAKE_START = """#!/usr/bin/env python3
import os, sys
here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data = sys.stdin.buffer.read()
open(os.path.join(here, "start-got"), "wb").write(data)
if os.path.exists(os.path.join(here, "busy")):
    print("refused: 2 jobs already running (MAX_WORKERS)", file=sys.stderr)
    sys.exit(3)
print("ok")
"""


@unittest.skipIf(os.geteuid() == 0, "root can list any folder; this test needs hermes-sub's view")
class RealSubmitPathTest(unittest.TestCase):
    """dispatch.py run for real (a subprocess, main(), its own env), against a tree where work/ can't be listed.

    Only the root wrapper is a fake, reached through HERMES_DEV2_TEST_ROOT, which dispatch honours only
    without SSH_CONNECTION. No Env field, listing or permission check is stubbed.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        cfg = (HERE / "config.conf").read_text()
        cfg = cfg.replace("WINDOW_START=22", "WINDOW_START=0").replace("WINDOW_END=6", "WINDOW_END=0")
        cfg = cfg.replace("MIN_DISK_GB=20", "MIN_DISK_GB=0")
        (t / "config.conf").write_text(cfg)
        (t / "var" / "work").mkdir(parents=True)
        (t / "var" / "outbox").mkdir()
        (t / "sbin").mkdir()
        (t / "sbin" / "hermes-job-start").write_text(FAKE_START)
        (t / "sbin" / "hermes-job-start").chmod(0o755)
        (t / "var" / "work").chmod(0o100)  # like root 0711 seen by hermes-sub: lookup yes, listing no
        self.t = t

    def tearDown(self):
        (self.t / "var" / "work").chmod(0o700)
        self.tmp.cleanup()

    def run_dispatch(self, command, stdin=b"", **extra):
        env = {"PATH": "/usr/bin:/bin", "HERMES_DEV2_TEST_ROOT": str(self.t), "SSH_ORIGINAL_COMMAND": command, **extra}
        return subprocess.run([sys.executable, "-I", str(HERE / "bin" / "dispatch.py")], input=stdin,
                              capture_output=True, env=env, timeout=30)

    def job(self):
        return json.dumps({"id": JID, "model": CFG["MODEL"], "prompt": "do the fake task"}).encode()

    def test_work_really_cant_be_listed(self):
        with self.assertRaises(PermissionError):
            os.listdir(self.t / "var" / "work")

    def test_submit_succeeds_without_listing_work(self):
        p = self.run_dispatch("submit", self.job())
        self.assertEqual((p.returncode, p.stdout.strip(), p.stderr.strip()), (0, b"ok", b""))
        self.assertEqual((self.t / "start-got").read_bytes(), self.job())  # root got the job on stdin, unchanged

    def test_roots_max_workers_refusal_reaches_the_mac(self):
        (self.t / "busy").write_text("")
        p = self.run_dispatch("submit", self.job())
        self.assertEqual(p.returncode, 3)
        self.assertEqual(p.stderr.strip(), b"refused: 2 jobs already running (MAX_WORKERS)")

    def test_status_of_a_running_job_works_without_listing(self):
        (self.t / "var" / "work").chmod(0o700)
        (self.t / "var" / "work" / JID).mkdir()
        (self.t / "var" / "work").chmod(0o100)
        p = self.run_dispatch(f"status {JID}")
        self.assertEqual((p.returncode, p.stdout.strip()), (0, b"running"))

    def test_test_hook_is_ignored_over_ssh(self):
        p = self.run_dispatch("submit", self.job(), SSH_CONNECTION="10.0.0.5 50000 10.10.10.220 22")
        self.assertNotEqual(p.returncode, 0)  # production config path, not the test tree
        self.assertFalse((self.t / "start-got").exists())


if __name__ == "__main__":
    unittest.main()
