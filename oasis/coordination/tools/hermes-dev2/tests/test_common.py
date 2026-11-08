"""Shared helpers: job ids, /proc/net/tcp owners, the firewall-rule check."""

import unittest

from _load import HERE, load

common = load("bin/hermes_dev2_common.py", "hermes_dev2_common")

# /proc/net/tcp: a LISTEN on 127.0.0.1:8000 (uid 990), our ESTABLISHED connection
# 127.0.0.1:41000 -> 127.0.0.1:8000, and the server side of it (uid 990).
PROC = """  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000   990        0 11111 1
   1: 0100007F:A028 0100007F:1F40 01 00000000:00000000 00:00000000 00000000   997        0 22222 1
   2: 0100007F:1F40 0100007F:A028 01 00000000:00000000 00:00000000 00000000   990        0 33333 1
   3: 0100007F:1F41 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1234        0 44444 1
"""


class CommonTest(unittest.TestCase):
    def test_job_ids(self):
        for ok in ["j-0123456789abcdef", "j-abcdefgh"]:
            self.assertTrue(common.valid_job_id(ok), ok)
        for bad in ["preflight", "probe", "0123456789abcdef", "j-short", "j-UPPERCASE1", "j-abc-defghij", "j-" + "a" * 63, "../j-aaaaaaaa"]:
            self.assertFalse(common.valid_job_id(bad), bad)

    def test_listener_and_connected_peer_owner(self):
        self.assertEqual(common.tcp_socket_uids(PROC, ("127.0.0.1", 8000), None, "0A"), [990])
        self.assertEqual(common.tcp_socket_uids(PROC, ("127.0.0.1", 8000), ("127.0.0.1", 41000), "01"), [990])
        self.assertEqual(common.tcp_socket_uids(PROC, ("127.0.0.1", 8000), ("127.0.0.1", 41001), "01"), [])
        self.assertEqual(common.tcp_socket_uids(PROC, ("127.0.0.1", 8001), None, "0A"), [1234])

    def test_firewall_ok(self):
        good = 'table inet hermes_w {\n\tchain output {\n\t\ttype filter hook output priority filter; policy accept;\n\t\tmeta skuid "hermes-w" counter packets 3 bytes 180 drop\n\t}\n}\n'
        self.assertTrue(common.firewall_ok(good, 997))
        self.assertTrue(common.firewall_ok(good.replace('"hermes-w"', "997"), 997))
        self.assertEqual(common.drop_counter(good, 997), 3)
        self.assertFalse(common.firewall_ok("", 997))  # table flushed away
        self.assertIsNone(common.drop_counter("", 997))
        with_accept = good.replace("\t\tmeta skuid", '\t\tmeta skuid "hermes-w" ip daddr 127.0.0.1 tcp dport 22 accept\n\t\tmeta skuid')
        self.assertFalse(common.firewall_ok(with_accept, 997))
        self.assertFalse(common.firewall_ok(good.replace("drop", "accept"), 997))
        self.assertFalse(common.firewall_ok(good.replace('"hermes-w"', "1000"), 997))  # someone else's rule

    def test_window(self):
        for hour, ok in [(21, False), (22, True), (0, True), (5, True), (6, False)]:
            self.assertEqual(common.in_window(hour, 22, 6), ok, hour)


class StripTestHookTest(unittest.TestCase):
    """The installed dispatch must carry no test-only hook or env override at all: this is
    what setup-dev2.sh runs before it ever writes /opt/hermes-sub/bin/dispatch."""

    def test_the_real_dispatch_py_strips_clean(self):
        src = (HERE / "bin" / "dispatch.py").read_text()
        self.assertIn("HERMES_DEV2_TEST_ROOT", src)  # the repo copy still has the hook
        out = common.strip_test_hook(src)
        self.assertNotIn("HERMES_DEV2_TEST_ROOT", out)  # inert/absent in the installed copy
        self.assertNotIn(common.HOOK_START, out)
        self.assertNotIn(common.HOOK_END, out)
        self.assertLess(len(out), len(src))
        compile(out, "dispatch", "exec")  # still valid, runnable Python

    def test_round_trips_through_the_cli_entry_point(self):
        import subprocess
        import sys
        p = subprocess.run([sys.executable, str(HERE / "bin" / "hermes_dev2_common.py"),
                            "--strip-test-hook", str(HERE / "bin" / "dispatch.py")],
                           capture_output=True, text=True, check=True)
        self.assertNotIn("HERMES_DEV2_TEST_ROOT", p.stdout)
        compile(p.stdout, "dispatch", "exec")

    def test_refuses_a_missing_or_duplicated_or_unbalanced_block(self):
        for bad in [
            "no markers here at all\n",
            common.HOOK_START + "\nx = 1\n",  # start with no end
            common.HOOK_END + "\nx = 1\n",  # end with no start
            f"{common.HOOK_END}\nx = 1\n{common.HOOK_START}\n",  # end before start
            f"{common.HOOK_START}\na\n{common.HOOK_END}\nmore\n{common.HOOK_START}\nb\n{common.HOOK_END}\n",  # two blocks
        ]:
            with self.assertRaises(ValueError, msg=bad):
                common.strip_test_hook(bad)

    def test_refuses_if_the_test_root_name_survives_outside_the_block(self):
        src = (f"{common.HOOK_START}\nx = 1\n{common.HOOK_END}\n"
               "y = 'HERMES_DEV2_TEST_ROOT'  # leaked outside the marked block\n")
        with self.assertRaises(ValueError):
            common.strip_test_hook(src)


if __name__ == "__main__":
    unittest.main()
