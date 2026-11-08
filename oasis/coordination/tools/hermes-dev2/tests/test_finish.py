"""The root finish step: reply copied into a NEW root-made outbox entry, links never followed, folder gone."""

import os
import tempfile
import unittest
from pathlib import Path

from _load import load

finish = load("bin/hermes-job-finish", "hermes_job_finish")
jobs = load("bin/hermes_jobs_root.py", "hermes_jobs_root")
JID = "j-0123456789abcdef"


class FinishTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "work" / JID / "out").mkdir(parents=True)
        (self.root / "outbox").mkdir()
        self.out = self.root / "work" / JID / "out"

    def tearDown(self):
        self.tmp.cleanup()

    def run_finish(self):
        finish.finish(JID, self.root, 100, os.getgid(), owner_uid=os.getuid())

    def test_copies_reply_and_deletes_work(self):
        (self.out / "stream.jsonl").write_bytes(b'{"type":"result"}\n')
        (self.out / "exit").write_text("0\n")
        (self.out / "stderr.txt").write_text("warn\n")
        self.run_finish()
        box = self.root / "outbox" / JID
        self.assertEqual((box / "stream.jsonl").read_bytes(), b'{"type":"result"}\n')
        self.assertEqual((box / "exit").read_text(), "0\n")
        self.assertEqual((box / "stderr.tail").read_text(), "warn\n")
        self.assertEqual(oct(box.stat().st_mode & 0o777), "0o750")
        self.assertEqual(oct((box / "exit").stat().st_mode & 0o777), "0o640")
        self.assertFalse((self.root / "work" / JID).exists())

    def test_output_cap_and_missing_exit(self):
        (self.out / "stream.jsonl").write_bytes(b"x" * 500)
        self.run_finish()
        box = self.root / "outbox" / JID
        self.assertEqual(len((box / "stream.jsonl").read_bytes()), 100)
        self.assertEqual((box / "exit").read_text(), "124\n")  # stopped, timed out or crashed

    def test_links_planted_by_the_worker_are_not_followed(self):
        secret = self.root / "secret"
        secret.write_text("TOP SECRET")
        os.symlink(secret, self.out / "stream.jsonl")
        os.symlink(secret, self.out / "stderr.txt")
        self.run_finish()
        box = self.root / "outbox" / JID
        self.assertEqual((box / "stream.jsonl").read_bytes(), b"")
        self.assertFalse((box / "stderr.tail").exists())
        self.assertEqual(secret.read_text(), "TOP SECRET")  # untouched

    def test_outbox_entry_planted_as_link_is_refused_and_work_still_removed(self):
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        os.symlink(elsewhere, self.root / "outbox" / JID)
        with self.assertRaises(FileExistsError):
            self.run_finish()
        self.assertEqual(list(elsewhere.iterdir()), [])  # nothing written or chmod'd through it
        self.assertFalse((self.root / "work" / JID).exists())

    def test_bad_id(self):
        with self.assertRaises(SystemExit):
            finish.finish("preflight", self.root, 100, os.getgid(), owner_uid=os.getuid())


class ReapTest(unittest.TestCase):
    """Jobs whose unit died before ExecStopPost (a dependency failed) are published as failed and removed."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "work").mkdir()
        (self.root / "outbox").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def make(self, job_id, age):
        d = self.root / "work" / job_id
        d.mkdir()
        (d / "prompt.txt").write_text("x")
        t = 1_000_000 - age
        os.utime(d, (t, t))

    def reap(self, states):
        return jobs.reap_orphans(self.root, 100, os.getgid(), owner_uid=os.getuid(), now=1_000_000,
                                 state=lambda i: states[i])

    def test_dead_on_dependency_is_reaped_with_a_reason(self):
        self.make(JID, age=300)
        self.assertEqual(self.reap({JID: ("inactive", "dependency")}), [JID])
        box = self.root / "outbox" / JID
        self.assertEqual((box / "exit").read_text(), "125\n")
        self.assertIn("dependency", (box / "reason").read_text())
        self.assertFalse((self.root / "work" / JID).exists())  # stops counting toward MAX_WORKERS

    def test_failed_unit_is_reaped(self):
        self.make(JID, age=300)
        self.assertEqual(self.reap({JID: ("failed", "exit-code")}), [JID])
        self.assertIn("exit-code", (self.root / "outbox" / JID / "reason").read_text())

    def test_running_starting_or_young_jobs_are_left_alone(self):
        ids = ["j-aaaaaaaa1", "j-bbbbbbbb2", "j-cccccccc3"]
        self.make(ids[0], age=300)
        self.make(ids[1], age=300)
        self.make(ids[2], age=30)  # may still be queued behind its forwarder
        states = {ids[0]: ("active", "success"), ids[1]: ("activating", "success"), ids[2]: ("inactive", "dependency")}
        self.assertEqual(self.reap(states), [])
        for i in ids:
            self.assertTrue((self.root / "work" / i).exists())

    def test_only_job_ids_are_touched(self):
        (self.root / "work" / "probe").mkdir()
        os.utime(self.root / "work" / "probe", (0, 0))
        self.assertEqual(self.reap({}), [])
        self.assertTrue((self.root / "work" / "probe").exists())


if __name__ == "__main__":
    unittest.main()
