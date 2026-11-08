"""The root start wrapper: re-validation, the lock, root-created folders, no link ever followed."""

import json
import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from _load import config, load

start = load("sbin/hermes-job-start", "hermes_job_start")
CFG = config()
GIB = 1024**3
JID = "j-0123456789abcdef"
NIGHT = lambda: datetime(2026, 10, 14, 23, 0, tzinfo=ZoneInfo("America/Chicago"))  # noqa: E731
DAY = lambda: datetime(2026, 10, 14, 12, 0, tzinfo=ZoneInfo("America/Chicago"))  # noqa: E731


class StartTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "work").mkdir(mode=0o711)
        (self.root / "outbox").mkdir()
        self.units = []
        self.me = (os.getuid(), os.getgid())

    def tearDown(self):
        self.tmp.cleanup()

    def raw(self, **over):
        j = {"id": JID, "model": CFG["MODEL"], "prompt": "fake task"}
        j.update(over)
        return json.dumps(j).encode()

    def go(self, raw=None, now=NIGHT, disk=80 * GIB, rc=0, tmpfs=True, reap=None):
        self.reaped = []
        return start.start(raw or self.raw(), CFG, root=self.root, now=now, disk_free=lambda p: disk,
                           worker=self.me, systemctl=lambda argv: self.units.append(argv) or rc,
                           owner_uid=os.getuid(), work_tmpfs=tmpfs, reap=reap or (lambda: self.reaped.append(1)))

    def test_ok_creates_folder_and_prompt_then_starts_unit(self):
        self.assertEqual(self.go(), "ok")
        job = self.root / "work" / JID
        self.assertEqual((job / "prompt.txt").read_text(), "fake task")
        self.assertEqual(sorted(p.name for p in job.iterdir()), ["prompt.txt"])
        self.assertEqual(oct(job.stat().st_mode & 0o777), "0o700")
        self.assertEqual(self.units, [["/usr/bin/systemctl", "start", "--no-block", f"hermes-w-job@{JID}.service"]])

    def test_root_revalidates_everything(self):
        for raw in [self.raw(model="some-other-model"), self.raw(id="preflight"), self.raw(id="j-UPPER00000"),
                    self.raw(prompt=""), b"[]", json.dumps({"id": JID, "model": CFG["MODEL"], "prompt": "x", "x": 1}).encode()]:
            with self.assertRaises(start.Refused, msg=raw[:30]):
                self.go(raw)
        self.assertEqual(self.units, [])

    def test_window_stop_disk_and_max_workers(self):
        with self.assertRaisesRegex(start.Refused, "window"):
            self.go(now=DAY)
        (self.root / "STOP").write_text("x")
        with self.assertRaisesRegex(start.Refused, "STOP"):
            self.go()
        (self.root / "STOP").unlink()
        os.symlink("/nonexistent", self.root / "STOP")  # a dangling link still counts as STOP
        with self.assertRaisesRegex(start.Refused, "STOP"):
            self.go()
        (self.root / "STOP").unlink()
        with self.assertRaisesRegex(start.Refused, "disk"):
            self.go(disk=19 * GIB)
        (self.root / "work" / "j-aaaaaaaa").mkdir()
        (self.root / "work" / "j-bbbbbbbb").mkdir()
        with self.assertRaisesRegex(start.Refused, "MAX_WORKERS"):
            self.go()
        self.assertEqual(self.units, [])

    def test_refuses_without_the_work_tmpfs(self):
        with self.assertRaisesRegex(start.Refused, "tmpfs"):
            self.go(tmpfs=False)
        self.assertEqual(self.units, [])

    def test_dead_jobs_are_reaped_before_counting(self):
        (self.root / "work" / "j-aaaaaaaa").mkdir()
        (self.root / "work" / "j-bbbbbbbb").mkdir()

        def reap():  # the reaper finds j-aaaaaaaa dead on a dependency and frees its slot
            (self.root / "work" / "j-aaaaaaaa").rmdir()
        self.assertEqual(self.go(reap=reap), "ok")

    def test_duplicate_keys_in_the_job_are_refused(self):
        raw = ('{"id":"%s","model":"other","model":"%s","prompt":"x"}' % (JID, CFG["MODEL"])).encode()
        with self.assertRaisesRegex(start.Refused, "repeats a key"):
            self.go(raw)

    def test_retry_is_exists_never_a_second_run(self):
        self.assertEqual(self.go(), "ok")
        self.assertEqual(self.go(), "exists")
        (self.root / "work" / JID / "prompt.txt").unlink()
        (self.root / "work" / JID).rmdir()
        (self.root / "outbox" / JID).mkdir()  # finished: still never run again
        self.assertEqual(self.go(), "exists")
        self.assertEqual(len(self.units), 1)

    def test_a_planted_link_is_never_followed(self):
        victim = self.root / "victim"
        victim.mkdir()
        os.symlink(victim, self.root / "work" / JID)
        self.assertEqual(self.go(), "exists")  # mkdir refuses; nothing written through the link
        self.assertEqual(list(victim.iterdir()), [])
        self.assertEqual(self.units, [])

    def test_create_job_itself_refuses_a_planted_link(self):
        victim = self.root / "victim"
        victim.mkdir()
        os.symlink(victim, self.root / "work" / JID)
        job = {"id": JID, "model": CFG["MODEL"], "prompt": "x"}
        with self.assertRaises(FileExistsError):
            start.create_job(self.root, job, *self.me, owner_uid=os.getuid())
        self.assertEqual(list(victim.iterdir()), [])

    def test_work_folder_must_be_owner_only_dir_not_link(self):
        (self.root / "work").chmod(0o777)
        with self.assertRaisesRegex(start.Refused, "root-owned"):
            self.go()
        (self.root / "work").chmod(0o711)
        (self.root / "work").rename(self.root / "realwork")
        os.symlink(self.root / "realwork", self.root / "work")
        with self.assertRaisesRegex(start.Refused, "root-owned"):
            self.go()

    def test_failed_unit_start_removes_the_folder(self):
        with self.assertRaisesRegex(start.Refused, "did not start"):
            self.go(rc=1)
        self.assertFalse((self.root / "work" / JID).exists())

    def test_main_refuses_arguments(self):
        self.assertEqual(start.main(["hermes-job-start", JID]), 2)


if __name__ == "__main__":
    unittest.main()
