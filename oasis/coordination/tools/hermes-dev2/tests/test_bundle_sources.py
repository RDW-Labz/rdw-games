"""The pypi-only bundle guard (coordination/tools/hermes-dev2/bin/bundle_sources_check.py):
every installed distribution in the bundle venv must trace back to
https://pypi.org/simple, except the hermes-agent project itself, installed
editable from DEST."""

import io
import json
import tempfile
import textwrap
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from _load import load

check = load("bin/bundle_sources_check.py", "bundle_sources_check")


def _metadata(name: str, version: str) -> str:
    return f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n\n"


def make_dist(site_packages: Path, name: str, version: str, direct_url: dict | None = None) -> None:
    dist_info = site_packages / f"{name.replace('.', '_')}-{version}.dist-info"
    dist_info.mkdir(parents=True)
    (dist_info / "METADATA").write_text(_metadata(name, version))
    if direct_url is not None:
        (dist_info / "direct_url.json").write_text(json.dumps(direct_url))


def lock_text(entries: list[str]) -> str:
    return "\n".join(entries)


def pypi_entry(name: str, version: str) -> str:
    return textwrap.dedent(f"""\
        [[package]]
        name = "{name}"
        version = "{version}"
        source = {{ registry = "https://pypi.org/simple" }}
        """)


def url_entry(name: str, version: str, url: str) -> str:
    return textwrap.dedent(f"""\
        [[package]]
        name = "{name}"
        version = "{version}"
        source = {{ url = "{url}" }}
        """)


def editable_root_entry(name: str = "hermes-agent", version: str = "0.0.0") -> str:
    return textwrap.dedent(f"""\
        [[package]]
        name = "{name}"
        version = "{version}"
        source = {{ editable = "." }}
        """)


class BundleSourcesCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.dest = self.base / "opt" / "hermes-agent"
        self.site_packages = self.dest / ".venv" / "lib" / "python3.14" / "site-packages"
        self.site_packages.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def write_lock(self, *entries: str) -> Path:
        lock = self.dest / "uv.lock"
        lock.write_text(lock_text(list(entries)))
        return lock

    def make_root(self, dest: Path | None = None, editable: bool = True) -> None:
        url = f"file://{dest if dest is not None else self.dest}"
        make_dist(self.site_packages, "hermes-agent", "0.0.0",
                   direct_url={"url": url, "dir_info": {"editable": editable}})

    def run_check(self) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = check.main(str(self.site_packages), str(self.dest / "uv.lock"), str(self.dest))
        return rc, out.getvalue(), err.getvalue()

    def test_passes_for_pypi_only_plus_editable_root(self):
        self.make_root()
        make_dist(self.site_packages, "addict", "2.4.0")
        make_dist(self.site_packages, "ruamel.yaml", "0.18.16")
        self.write_lock(
            editable_root_entry(),
            pypi_entry("addict", "2.4.0"),
            pypi_entry("ruamel-yaml", "0.18.16"),  # lock normalizes the dotted name
        )
        rc, out, err = self.run_check()
        self.assertEqual(rc, 0, err)
        self.assertIn("3 installed, all from pypi.org", out)
        self.assertIn("hermes-agent editable", out)

    def test_fails_on_a_git_direct_url(self):
        self.make_root()
        make_dist(self.site_packages, "psutil", "8.0.0",
                   direct_url={"url": "https://github.com/giampaolo/psutil.git",
                               "vcs_info": {"vcs": "git", "commit_id": "380bd2b"}})
        self.write_lock(
            editable_root_entry(),
            pypi_entry("psutil", "8.0.0"),  # even if the lock had a registry entry, direct_url.json alone fails it
        )
        rc, out, err = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("psutil 8.0.0", err)
        self.assertIn("direct_url.json", err)

    def test_fails_when_the_matching_lock_entry_is_url_sourced(self):
        self.make_root()
        make_dist(self.site_packages, "kittentts", "0.8.1")  # installed with no direct_url.json of its own
        self.write_lock(
            editable_root_entry(),
            url_entry("kittentts", "0.8.1", "https://github.com/KittenML/KittenTTS/releases/download/0.8.1/kittentts-0.8.1-py3-none-any.whl"),
        )
        rc, out, err = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("kittentts 0.8.1", err)
        self.assertIn("registry", err)

    def test_passes_when_a_url_sourced_lock_entry_is_not_installed(self):
        self.make_root()
        make_dist(self.site_packages, "addict", "2.4.0")
        self.write_lock(
            editable_root_entry(),
            pypi_entry("addict", "2.4.0"),
            url_entry("kittentts", "0.8.1", "https://github.com/KittenML/KittenTTS/releases/download/0.8.1/kittentts-0.8.1-py3-none-any.whl"),
        )
        rc, out, err = self.run_check()
        self.assertEqual(rc, 0, err)
        self.assertIn("2 installed, all from pypi.org", out)

    def test_fails_when_an_installed_dist_is_missing_from_the_lock(self):
        self.make_root()
        make_dist(self.site_packages, "addict", "2.4.0")
        self.write_lock(editable_root_entry())  # no addict entry at all
        rc, out, err = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("addict 2.4.0", err)
        self.assertIn("no matching entry", err)

    def test_editable_root_allowed_only_at_file_dest(self):
        other = self.base / "opt" / "somewhere-else"
        self.make_root(dest=other)
        self.write_lock(editable_root_entry())
        rc, out, err = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("hermes-agent 0.0.0", err)

    def test_root_project_not_editable_fails(self):
        self.make_root(editable=False)
        self.write_lock(editable_root_entry())
        rc, out, err = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("hermes-agent 0.0.0", err)

    def test_root_project_with_no_direct_url_fails(self):
        make_dist(self.site_packages, "hermes-agent", "0.0.0")  # no direct_url.json at all
        self.write_lock(editable_root_entry())
        rc, out, err = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("hermes-agent 0.0.0", err)


if __name__ == "__main__":
    unittest.main()
