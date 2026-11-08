"""Hermetic end-to-end coverage for setup-dev2.sh --dry-run."""

import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from _load import HERE


def only_in_strip(text, new_return):
    """Change only strip_test_hook's `return out` in a copy of hermes_dev2_common.py."""
    start = text.index("def strip_test_hook(")
    end = text.index("    return out\n", start)
    return text[:end] + new_return + text[end + len("    return out\n"):]


class DryRunTest(unittest.TestCase):
    def run_dry_run(self, defaults=None, keep_test_hook=False, strip_to_empty=False):
        self.assertFalse(Path("/var/lib/hermes-jobs/work").exists())
        source = HERE / "setup-dev2.sh"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copy = root / "hermes-dev2"
            shutil.copytree(HERE, copy, ignore=shutil.ignore_patterns("__pycache__", "tests"))
            script = copy / "setup-dev2.sh"
            if defaults is not None:
                sudoers = copy / "hermes-sub.sudoers"
                sudoers.write_text(re.sub(r"^Defaults:hermes-sub .*?$", defaults, sudoers.read_text(), flags=re.MULTILINE))
            stubs = root / "stubs"
            stubs.mkdir()
            stage_tmp = root / "stage-tmp"
            stage_tmp.mkdir()
            bundle = root / "hermes-bundle-fake.tar.gz"
            bundle.write_bytes(b"fake bundle")

            def stub(name, body):
                path = stubs / name
                path.write_text("#!/bin/sh\n" + body)
                path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

            stub("uname", 'printf "Linux\\n"\n')
            stub("systemctl", 'if [ "${1:-}" = "--version" ]; then printf "systemd 257\\n"; fi\n')
            stub("id", 'if [ "${1:-}" = "-u" ]; then printf "0\\n"; exit 0; fi; exit 1\n')
            stub("getent", 'if [ "${1:-}" = "passwd" ]; then printf "root:x:0:0:root:/root:/bin/sh\\n"; fi; exit 2\n')
            stub("readlink", 'printf "%s\\n" "$2"\n')
            stub("ss", 'exit 0\n')
            stub("sshd", 'exit 0\n')
            stub("systemd-escape", 'printf "var-lib-hermes\\x2djobs-work.mount\\n"\n')
            stub("visudo", """file=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-cf" ] || [ "$1" = "-f" ]; then file=$2; shift 2; else shift; fi
done
if grep -v "^[[:space:]]*#" "$file" | grep -q requiretty; then
  echo "syntax error: unknown setting: 'requiretty'" >&2
  exit 1
fi
exit 0
""")
            # Keep real Python for stripping and parsing; only bundle verification
            # and /proc/net listener discovery are dev2-specific stubs.
            stub("python3", f'''if [ "${{2:-}}" = "-" ]; then
  printf 'none\\n'
  exit 0
fi
case "$*" in
  *hermes_bundle.py*--verify*) exit 0 ;;
esac
exec {sys.executable} "$@"
''')
            for command in ("nft", "runuser", "systemd-run", "findmnt", "groupadd", "usermod"):
                stub(command, "exit 0\n")

            fixed = "PATH=/usr/sbin:/usr/bin:/sbin:/bin\n"
            text = source.read_text()
            self.assertIn(fixed, text)
            # The listener is the one dev2-only read. Replace that block in the
            # temp copy; the strip and AST check below still use real Python.
            listener_start = text.index("read -r bind_problem listen_uid")
            listener_end = text.index("if [[ $bind_problem", listener_start)
            text = text[:listener_start] + "bind_problem=none\nlisten_uid=\n" + text[listener_end:]
            script.write_text(text.replace(fixed, f"PATH={stubs}:/usr/bin:/bin\n", 1))
            if keep_test_hook:
                common = copy / "bin" / "hermes_dev2_common.py"
                common.write_text(only_in_strip(common.read_text(), "    return source\n"))
            if strip_to_empty:
                common = copy / "bin" / "hermes_dev2_common.py"
                common.write_text(only_in_strip(common.read_text(), "    return ''\n"))
            result = subprocess.run(
                [
                    "bash",
                    str(script),
                    "--dry-run",
                    "--bundle",
                    str(bundle),
                    "--mac-key",
                    "ssh-ed25519 AAAAFAKE test",
                    "--upstream-user",
                    "model-user",
                ],
                cwd=copy,
                capture_output=True,
                text=True,
                env={**os.environ, "TMPDIR": str(stage_tmp)},
            )
            return result, text

    def test_fresh_box_dry_run_reaches_all_steps(self):
        # A fresh box: the work folder only a real run creates is missing (the 2026-10-14 dev2 dry-run bug).
        self.assertFalse(Path("/var/lib/hermes-jobs/work").exists())
        result, text = self.run_dry_run()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertRegex(result.stdout, r"staged dispatch \(\d+ bytes, checks ok\)")
        self.assertNotIn("refusing: the staged dispatch still has the test hook", result.stderr)
        headings = re.findall(r'^say "([1-8]\..*)"$', text, re.MULTILINE)
        self.assertEqual(len(headings), 8)
        pin = re.search(r"^PIN=([0-9a-f]+)", text, re.MULTILINE).group(1)
        rendered = [heading.replace("$PIN", pin) for heading in headings]
        positions = [result.stdout.index(f"== {heading}") for heading in rendered]
        self.assertEqual(positions, sorted(positions))

    def test_invalid_sudoers_fails_before_users(self):
        result, _ = self.run_dry_run("Defaults:hermes-sub !requiretty, env_reset, !setenv")
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        self.assertIn("does not parse", result.stderr)
        self.assertNotIn("== 2. users", result.stdout)

    def test_dry_run_refuses_if_stripper_leaves_test_hook(self):
        result, _ = self.run_dry_run(keep_test_hook=True)
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        self.assertIn("refusing: the staged dispatch still has the test hook", result.stderr)

    def test_dry_run_refuses_an_empty_staged_dispatch(self):
        # An empty file has no test hook and parses as Python, so only the size check stops it.
        result, _ = self.run_dry_run(strip_to_empty=True)
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        self.assertIn("refusing: staged dispatch is empty", result.stderr)


if __name__ == "__main__":
    unittest.main()
