"""Behavioral checks for the host-namespace worker precheck."""

import builtins
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import mock_open, patch

from _load import load

precheck = load("sbin/hermes-unit-precheck", "hermes_unit_precheck")


GOOD_NFT = 'table inet hermes_w { chain output { meta skuid "hermes-w" counter packets 1 bytes 2 drop } }'
TMPFS_MOUNT = "1 2 0:3 / /var/lib/hermes-jobs/work rw - tmpfs tmpfs rw"
DISK_MOUNT = "1 2 0:3 / /var/lib/hermes-jobs/work rw - ext4 /dev/sda rw"


class PrecheckTest(unittest.TestCase):
    def run_check(self, argument, *, nft=GOOD_NFT, mount=TMPFS_MOUNT, stop=False):
        result = subprocess.CompletedProcess(["nft"], 0, stdout=nft, stderr="")
        with patch.object(precheck.subprocess, "run", return_value=result), \
             patch.object(precheck.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=123)), \
             patch.object(precheck.os.path, "lexists", return_value=stop), \
             patch.object(builtins, "open", mock_open(read_data=mount)):
            return precheck.main(["hermes-unit-precheck", argument])

    def test_valid_bare_and_instance_arguments_for_each_kind(self):
        for argument in ("job", "fwd", "probe", "job-j-0123456789abcdef", "fwd-probe-sandbox", "probe-iso-a"):
            with self.subTest(argument=argument):
                self.assertIsNotNone(precheck.parse_kind(argument))

    def test_bad_kind_characters_length_and_job_id_are_rejected(self):
        bad = ("nope", "nope-x", "fwd-bad_value", "probe-", "fwd-" + "a" * 65,
               "job-j-UPPER0000", "job-j-short")
        for argument in bad:
            with self.subTest(argument=argument):
                self.assertIsNone(precheck.parse_kind(argument))
                self.assertEqual(precheck.main(["hermes-unit-precheck", argument]), 2)

    def test_wrong_arity_keeps_usage_exit_code(self):
        self.assertEqual(precheck.main(["hermes-unit-precheck"]), 2)
        self.assertEqual(precheck.main(["hermes-unit-precheck", "job", "fwd"]), 2)

    def test_firewall_missing_is_refused(self):
        self.assertEqual(self.run_check("fwd", nft=""), 1)

    def test_stop_file_is_refused_for_jobs(self):
        self.assertEqual(self.run_check("job-j-0123456789abcdef", stop=True), 1)

    def test_work_area_must_be_tmpfs_for_jobs(self):
        self.assertEqual(self.run_check("job-j-0123456789abcdef", mount=DISK_MOUNT), 1)

    def test_all_checks_pass(self):
        self.assertEqual(self.run_check("job-j-0123456789abcdef"), 0)


if __name__ == "__main__":
    unittest.main()
