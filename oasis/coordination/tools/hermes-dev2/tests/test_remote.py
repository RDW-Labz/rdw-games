"""hermes-remote on the Mac: swarm's exact argv, reconnects on a dropped link, unchanged output."""

import io
import json
import subprocess
import unittest
from pathlib import Path

from _load import HERE, config, load

remote = load("mac/bin/hermes", "hermes_remote")
MODEL = config()["MODEL"]
SWARM_ARGS = ["chat", "--safe-mode", "--ignore-user-config", "--ignore-rules", "--toolsets", "none",
              "--query-file", "-", "--oneshot", "--format", "stream-json", "--max-turns", "1", "--model", MODEL]
STREAM = b'{"type":"system","subtype":"init","model":"fake-model"}\n{"type":"result","exit_code":0,"text":"{\\"files\\":[]}"}\n'


class FakeSSH:
    """Plays dev2: scripted replies per verb; 255 = the link dropped."""

    def __init__(self, drops=0, states=("running", "done 0")):
        self.calls, self.drops, self.states = [], drops, list(states)

    def __call__(self, argv, input=b"", capture_output=True, timeout=None):
        verb = argv[argv.index("hermes-sub@10.10.10.220") + 1:]
        self.calls.append((verb, input))
        if self.drops:
            self.drops -= 1
            return subprocess.CompletedProcess(argv, 255, b"", b"Connection reset")
        if verb[0] == "submit":
            return subprocess.CompletedProcess(argv, 0, b"ok\n", b"")
        if verb[0] == "status":
            return subprocess.CompletedProcess(argv, 0, (self.states.pop(0) if self.states else "done 0").encode() + b"\n", b"")
        if verb[0] == "fetch":
            return subprocess.CompletedProcess(argv, 0, STREAM, b"")
        return subprocess.CompletedProcess(argv, 0, b"cancelled\n", b"")


class RemoteTest(unittest.TestCase):
    def test_swarm_argv_accepted_and_model_fixed(self):
        self.assertEqual(remote.parse_args(SWARM_ARGS), MODEL)
        with self.assertRaises(SystemExit):
            remote.parse_args(SWARM_ARGS[:-1] + ["anthropic/claude-opus-4.6"])
        with self.assertRaises(SystemExit):
            remote.parse_args(SWARM_ARGS[:4] + ["web"] + SWARM_ARGS[5:])  # tools on
        with self.assertRaises(SystemExit):
            remote.parse_args(SWARM_ARGS + ["--yolo"])

    def test_swarm_adapter_args_match(self):
        adapter = Path.home() / ".project-swarm/current/tools/cli-adapters.mjs"
        if not adapter.exists():
            self.skipTest("project-swarm not installed")
        text = adapter.read_text()
        want = "if(job.agent==='hermes')return ['" + "','".join(remote.REQUIRED) + "',...model];"
        self.assertIn(want, text)

    def test_job_round_trip_prints_stream_unchanged(self):
        ssh, out = FakeSSH(), io.BytesIO()
        rc = remote.Remote(run=ssh, sleep=lambda s: None).job(MODEL, "prompt text", out)
        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue(), STREAM)
        sent = json.loads(ssh.calls[0][1])
        self.assertEqual(set(sent), {"id", "model", "prompt"})
        self.assertEqual(sent["prompt"], "prompt text")

    def test_dropped_link_is_retried_not_lost(self):
        ssh, out = FakeSSH(drops=3), io.BytesIO()
        rc = remote.Remote(run=ssh, sleep=lambda s: None, err=io.StringIO()).job(MODEL, "p", out)
        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue(), STREAM)
        self.assertEqual([c[0][0] for c in ssh.calls[:4]], ["submit"] * 4)

    def test_failed_job_reason_is_shown_and_exit_kept(self):
        err = io.StringIO()
        ssh = FakeSSH(states=["done 125 failed: the job's forwarder or the proxy did not start (dependency)"])
        rc = remote.Remote(run=ssh, sleep=lambda s: None, err=err).job(MODEL, "p", io.BytesIO())
        self.assertEqual(rc, 125)
        self.assertIn("dependency", err.getvalue())

    def test_timeout_cancels(self):
        clock = iter(range(0, 10_000, 600))
        ssh = FakeSSH(states=["running"] * 100)
        rc = remote.Remote(run=ssh, sleep=lambda s: None, clock=lambda: next(clock), err=io.StringIO()).job(MODEL, "p", io.BytesIO())
        self.assertEqual(rc, 124)
        self.assertEqual(ssh.calls[-1][0][0], "cancel")

    def test_ssh_options_send_nothing_extra(self):
        argv = remote.ssh_argv("status", "j-0123456789abcdef")
        self.assertIn("-F", argv)
        self.assertEqual(argv[argv.index("-F") + 1], "/dev/null")
        for opt in ("ForwardAgent=no", "ClearAllForwardings=yes", "IdentitiesOnly=yes", "BatchMode=yes", "StrictHostKeyChecking=yes"):
            self.assertIn(opt, argv)
        self.assertNotIn("SendEnv", " ".join(argv))

    def test_doctor_answers(self):
        self.assertEqual(remote.main(["--version"]), 0)
        for flag in ("--safe-mode", "--ignore-user-config", "--ignore-rules", "--toolsets", "--query-file", "--oneshot", "--format", "--max-turns"):
            self.assertIn(flag, remote.HELP)


if __name__ == "__main__":
    unittest.main()
