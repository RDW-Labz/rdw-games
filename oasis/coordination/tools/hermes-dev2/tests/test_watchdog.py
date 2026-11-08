"""The watchdog's stop decision (pure function) and /proc/meminfo parsing."""

import os
import tempfile
import unittest
from pathlib import Path

from _load import config, load

wd = load("bin/watchdog.py", "watchdog")
GIB = 1024**3
CFG = config()


class DecideTest(unittest.TestCase):
    def test_all_well(self):
        self.assertEqual(wd.decide(19 * GIB, 86 * GIB, 40.0, 50.0, CFG), [])

    def test_ram_floor_is_8gb(self):
        self.assertEqual(wd.decide(8 * GIB, 86 * GIB, None, None, CFG), [])
        self.assertEqual(len(wd.decide(8 * GIB - 1, 86 * GIB, None, None, CFG)), 1)
        self.assertIn("RAM", wd.decide(7 * GIB, 86 * GIB, None, None, CFG)[0])

    def test_disk_floor_is_20gb(self):
        self.assertEqual(wd.decide(19 * GIB, 20 * GIB, None, None, CFG), [])
        self.assertIn("disk", wd.decide(19 * GIB, 19 * GIB, None, None, CFG)[0])

    def test_speed_halved(self):
        self.assertEqual(wd.decide(19 * GIB, 86 * GIB, 25.0, 50.0, CFG), [])
        self.assertIn("speed", wd.decide(19 * GIB, 86 * GIB, 24.9, 50.0, CFG)[0])

    def test_no_baseline_or_no_probe_never_stops_on_speed(self):
        self.assertEqual(wd.decide(19 * GIB, 86 * GIB, 1.0, None, CFG), [])
        self.assertEqual(wd.decide(19 * GIB, 86 * GIB, None, 50.0, CFG), [])

    def test_several_reasons(self):
        self.assertEqual(len(wd.decide(1 * GIB, 1 * GIB, 1.0, 50.0, CFG)), 3)
        self.assertEqual(len(wd.decide(1 * GIB, 1 * GIB, 1.0, 50.0, CFG, probe_failures=2, work_used=1.0)), 5)

    def test_two_failed_probes_in_a_row_stop(self):
        self.assertEqual(wd.decide(19 * GIB, 86 * GIB, None, 50.0, CFG, probe_failures=1), [])
        self.assertIn("speed probe failed 2 times", wd.decide(19 * GIB, 86 * GIB, None, 50.0, CFG, probe_failures=2)[0])

    def test_work_tmpfs_over_90_percent_stops(self):
        self.assertEqual(wd.decide(19 * GIB, 86 * GIB, None, None, CFG, work_used=0.9), [])
        self.assertIn("work tmpfs", wd.decide(19 * GIB, 86 * GIB, None, None, CFG, work_used=0.91)[0])

    def test_probe_goes_to_the_proxy_socket_with_the_model_setting(self):
        seen = []
        def call(path, method, url, body):
            seen.append((path, method, url, body["model"]))
            return {"usage": {"completion_tokens": 40}}
        self.assertGreater(wd.probe_speed(CFG["PROXY_SOCKET"], CFG["MODEL"], call=call), 0)
        self.assertEqual(seen, [(CFG["PROXY_SOCKET"], "POST", "/v1/chat/completions", CFG["MODEL"])])
        with self.assertRaises(ValueError):
            wd.probe_speed(CFG["PROXY_SOCKET"], CFG["MODEL"], call=lambda *a: {"usage": {}})

    def test_meminfo(self):
        text = "MemTotal:       95000000 kB\nMemFree:  1000 kB\nMemAvailable:   19922944 kB\n"
        self.assertEqual(wd.mem_available(text), 19922944 * 1024)
        with self.assertRaises(ValueError):
            wd.mem_available("MemTotal: 1 kB\n")


class CheckWriteTest(unittest.TestCase):
    """check_write proves the write actually landed (and cleaned up), and fails loudly
    (nonzero, a printed reason) rather than silently when it can't."""

    def test_writable_work_dir_returns_0_and_leaves_no_marker(self):
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            self.assertEqual(wd.check_write(work), 0)
            self.assertEqual(list(work.iterdir()), [])  # the marker is removed, not left behind

    def test_unwritable_work_dir_fails_loudly(self):
        with tempfile.TemporaryDirectory() as d:
            work = Path(d) / "ro"
            work.mkdir(mode=0o500)  # read + execute only: can't create a file inside
            try:
                self.assertNotEqual(wd.check_write(work), 0)
            finally:
                work.chmod(0o700)  # so tempfile cleanup can remove it

    def test_missing_work_dir_fails_loudly(self):
        with tempfile.TemporaryDirectory() as d:
            missing = Path(d) / "does-not-exist"
            self.assertNotEqual(wd.check_write(missing), 0)

    def test_a_pre_existing_marker_does_not_fool_it_into_a_false_pass(self):
        """O_EXCL: if a same-named marker is somehow already there (a stale leftover,
        or two watchdogs racing), check_write must not claim success without writing."""
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            pid = os.getpid()
            stale = work / f".watchdog-check-{pid}"
            stale.write_text("not really ours")
            try:
                self.assertNotEqual(wd.check_write(work), 0)
            finally:
                stale.unlink(missing_ok=True)

    def test_check_write_is_wired_into_main(self):
        self.assertIn('"--check-write"', open(wd.__file__).read())


if __name__ == "__main__":
    unittest.main()
