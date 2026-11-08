"""coordination/tools/hermes-dev2/bin/drop_uv_build_timestamps.py: strips uv's
build-timestamp uv_cache.json (and its RECORD line) from every dist-info so
two builds of the same pin produce a byte-identical tarball."""

import tempfile
import unittest
from pathlib import Path

from _load import load

drop = load("bin/drop_uv_build_timestamps.py", "drop_uv_build_timestamps")


class DropUvBuildTimestampsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.site_packages = Path(self.tmp.name) / "site-packages"
        self.site_packages.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def make_dist(self, name_version: str, record_lines: list[str], with_cache: bool = True) -> Path:
        dist_info = self.site_packages / f"{name_version}.dist-info"
        dist_info.mkdir()
        if with_cache:
            (dist_info / "uv_cache.json").write_text('{"secs_since_epoch": 123456}')
        (dist_info / "RECORD").write_text("\n".join(record_lines) + "\n")
        return dist_info

    def test_removes_uv_cache_json_and_its_record_line(self):
        dist_info = self.make_dist(
            "addict-2.4.0",
            [
                "addict-2.4.0.dist-info/METADATA,sha256=abc,100",
                "addict-2.4.0.dist-info/uv_cache.json,sha256=def,42",
                "addict-2.4.0.dist-info/RECORD,,",
            ],
        )
        rc = drop.main(str(self.site_packages))
        self.assertEqual(rc, 0)
        self.assertFalse((dist_info / "uv_cache.json").exists())
        record = (dist_info / "RECORD").read_text()
        self.assertNotIn("uv_cache.json", record)
        self.assertIn("METADATA", record)
        self.assertIn("RECORD,,", record)

    def test_leaves_dist_info_without_uv_cache_json_untouched(self):
        dist_info = self.make_dist(
            "hermes-agent-0.0.0",
            ["hermes-agent-0.0.0.dist-info/METADATA,sha256=abc,100"],
            with_cache=False,
        )
        before = (dist_info / "RECORD").read_text()
        rc = drop.main(str(self.site_packages))
        self.assertEqual(rc, 0)
        self.assertEqual((dist_info / "RECORD").read_text(), before)

    def test_reports_how_many_it_fixed(self):
        self.make_dist("addict-2.4.0", ["addict-2.4.0.dist-info/uv_cache.json,sha256=def,42"])
        self.make_dist("h2-4.4.1", ["h2-4.4.1.dist-info/uv_cache.json,sha256=def,42"], with_cache=True)
        self.make_dist("ruamel-yaml-0.18.16", ["x"], with_cache=False)
        import io
        from contextlib import redirect_stdout
        out = io.StringIO()
        with redirect_stdout(out):
            drop.main(str(self.site_packages))
        self.assertIn("2 dist-info(s)", out.getvalue())


if __name__ == "__main__":
    unittest.main()
