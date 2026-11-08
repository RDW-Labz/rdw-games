"""The prebuilt Hermes bundle: sha256 and architecture checks, and an unpacker that refuses
anything a careful one would (round 4: no downloaded build code ever runs on dev2)."""

import hashlib
import io
import os
import stat
import tarfile
import tempfile
import unittest
from pathlib import Path

from _load import load

bundle = load("bin/hermes_bundle.py", "hermes_bundle")


def make_tar(path: Path, members: list[tuple]) -> str:
    """members: (name, kind, extra) with kind file|dir|sym|link|chr|fifo; extra = data, target or mode."""
    with tarfile.open(path, "w:gz") as tf:
        for name, kind, extra in members:
            ti = tarfile.TarInfo(name)
            if kind == "file":
                data = extra if isinstance(extra, bytes) else b"x"
                ti.size, ti.mode = len(data), 0o644
                tf.addfile(ti, io.BytesIO(data))
                continue
            if kind == "exe":
                ti.size, ti.mode = 2, 0o755
                tf.addfile(ti, io.BytesIO(b"#!"))
                continue
            if kind == "setuid":
                ti.size, ti.mode = 1, 0o4755
                tf.addfile(ti, io.BytesIO(b"x"))
                continue
            ti.type = {"dir": tarfile.DIRTYPE, "sym": tarfile.SYMTYPE, "link": tarfile.LNKTYPE,
                       "chr": tarfile.CHRTYPE, "fifo": tarfile.FIFOTYPE}[kind]
            ti.mode = 0o755 if kind == "dir" else 0o644
            if kind in ("sym", "link"):
                ti.linkname = extra
            tf.addfile(ti)
    return hashlib.sha256(path.read_bytes()).hexdigest()


GOOD = [("hermes-agent", "dir", None), ("hermes-agent/.venv", "dir", None), ("hermes-agent/.venv/bin", "dir", None),
        ("hermes-agent/.python", "dir", None), ("hermes-agent/.python/bin", "dir", None),
        ("hermes-agent/.python/bin/python3.14", "exe", None),
        ("hermes-agent/.python/bin/python3", "sym", "python3.14"),
        ("hermes-agent/.venv/bin/python", "sym", "/opt/hermes-w/hermes-agent/.python/bin/python3.14"),
        ("hermes-agent/.venv/bin/hermes", "exe", None), ("hermes-agent/README.md", "file", b"hello")]


class BundleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.dest = str(self.base / "opt" / "hermes-agent")
        (self.base / "opt").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def refused(self, members, msg):
        path = self.base / "b.tar.gz"
        sha = make_tar(path, members)
        with self.assertRaises(bundle.BundleRefused) as cm:
            self._install(path, sha)
        self.assertIn(msg, str(cm.exception))
        self.assertFalse(os.path.lexists(self.dest))  # nothing landed
        self.assertEqual([p for p in os.listdir(self.base / "opt") if p.startswith(".hermes-agent.new")], [])

    def _install(self, path, sha):
        bundle.verify(str(path), sha, "x86_64", machine="x86_64")
        staged = bundle.extract(str(path), self.dest)
        os.rename(staged, self.dest)

    def test_good_bundle_unpacks_with_plain_modes(self):
        path = self.base / "b.tar.gz"
        sha = make_tar(path, GOOD)
        self._install(path, sha)
        d = Path(self.dest)
        self.assertEqual((d / "README.md").read_bytes(), b"hello")
        self.assertEqual(stat.S_IMODE((d / "README.md").stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE((d / ".venv" / "bin" / "hermes").stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(d.stat().st_mode), 0o755)
        self.assertEqual(os.readlink(d / ".python" / "bin" / "python3"), "python3.14")

    def test_absolute_path_refused(self):
        self.refused(GOOD + [("/etc/cron.d/x", "file", b"x")], "absolute")

    def test_dot_dot_refused(self):
        self.refused(GOOD + [("hermes-agent/../../etc/x", "file", b"x")], "'..'")

    def test_outside_the_top_folder_refused(self):
        self.refused(GOOD + [("other/x", "file", b"x")], "outside the top folder")

    def test_symlink_out_refused(self):
        self.refused(GOOD + [("hermes-agent/evil", "sym", "../../../etc/shadow")], "points outside the bundle")
        self.refused(GOOD + [("hermes-agent/evil", "sym", "/etc/shadow")], "points outside")

    def test_member_under_a_symlink_refused(self):
        self.refused(GOOD + [("hermes-agent/lnk", "sym", "."), ("hermes-agent/lnk/x", "file", b"x")], "under a symlink")

    def test_hardlink_refused(self):
        self.refused(GOOD + [("hermes-agent/hl", "link", "hermes-agent/README.md")], "hard link")

    def test_device_and_fifo_refused(self):
        self.refused(GOOD + [("hermes-agent/dev", "chr", None)], "not a regular file")
        self.refused(GOOD + [("hermes-agent/pipe", "fifo", None)], "not a regular file")

    def test_setuid_refused(self):
        self.refused(GOOD + [("hermes-agent/su", "setuid", None)], "setuid")

    def test_sha_mismatch_refused(self):
        path = self.base / "b.tar.gz"
        make_tar(path, GOOD)
        with self.assertRaises(bundle.BundleRefused) as cm:
            bundle.verify(str(path), "0" * 64, "x86_64", machine="x86_64")
        self.assertIn("sha256", str(cm.exception))
        with self.assertRaises(bundle.BundleRefused):
            bundle.verify(str(path), "", "x86_64", machine="x86_64")  # not pasted yet

    def test_arch_mismatch_refused(self):
        path = self.base / "b.tar.gz"
        sha = make_tar(path, GOOD)
        with self.assertRaises(bundle.BundleRefused) as cm:
            bundle.verify(str(path), sha, "x86_64", machine="aarch64")
        self.assertIn("aarch64", str(cm.exception))

    def test_install_swaps_in_and_replaces_an_older_copy(self):
        path = self.base / "b.tar.gz"
        sha = make_tar(path, GOOD)
        os.makedirs(self.dest)
        Path(self.dest, "old.txt").write_text("old")
        orig = bundle.platform.machine
        bundle.platform.machine = lambda: "x86_64"
        try:
            bundle.install(str(path), sha, "x86_64", self.dest)
        finally:
            bundle.platform.machine = orig
        self.assertFalse(Path(self.dest, "old.txt").exists())
        self.assertTrue(Path(self.dest, "README.md").exists())
        self.assertEqual(sorted(os.listdir(self.base / "opt")), ["hermes-agent"])  # no stage or old copy left


if __name__ == "__main__":
    unittest.main()
