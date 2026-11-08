"""Pre-flight verdicts: PASS only when reachable outside AND blocked inside; never a false PASS;
isolation between two jobs; root-side file moves never follow links; proxy tricks; required checks."""

import json
import os
import tempfile
import unittest
from pathlib import Path

from _load import config, load

probe = load("bin/preflight_probe.py", "preflight_probe")
CFG = config()


def reach(all_up=True, up=(), dns=True):
    tcp = {label: all_up or label in up for label, _, _ in probe.TCP_TARGETS}
    return {"tcp": tcp, "udp_dns": {label: dns for label, _ in probe.UDP_DNS_TARGETS}, "github": all_up,
            "unix": {p: all_up for p in probe.UNIX_TARGETS}}


def inner(**over):
    base = reach(all_up=False, dns=False)
    base.update({"dns_lookup": False, "af_unix": "refused", "ipv6": "refused",
                 "udp_send": {label: "blocked ENETUNREACH" for label, _, _ in probe.UDP_SEND_TARGETS},
                 "key_readable": {p: False for p in probe.KEY_FILES}, "host_files": {p: False for p in probe.HOST_FILES},
                 "interfaces": ["lo"], "models": [CFG["MODEL"]], "chat": "returns", "other_model": 403})
    base.update(over)
    return base


def iso(**over):
    res = {"own_procs": [1], "peer pid not in our /proc": True, "peer pid can't be signalled": True,
           "peer /proc/<pid>/root unreachable": True, "peer /proc/<pid>/cwd unreachable": True,
           "peer folder unreachable": True, "peer marker file unreachable": True, "peer /tmp marker unreachable": True,
           "outbox unreachable": True, "job work area unreachable": True, "only own probe folder visible": True,
           "own folder usable": True, "own /tmp usable": True, "peer /dev/shm marker unreachable": True,
           "own /dev/shm usable": True, "peer SysV message queue unreachable": True,
           "own SysV message queue usable": True}
    res.update(over)
    return res


HOST_USER_BLOCKED = {"tcp": {label: False for label, _, _ in probe.TCP_TARGETS}}
TRICKS_OK = {label: sorted(want)[0] for label, want in probe.TRICK_EXPECT.items()}
E2E_OK = {"submit": "ok", "status": "done 0", "fetched_bytes": 120}


def verdicts(outside=None, inside_=None, host_user=HOST_USER_BLOCKED, iso_a="default", iso_b="default",
             tricks=TRICKS_OK, other="no access", e2e=E2E_OK, stranger="refused by peer check"):
    a = dict(iso(), overlapped=True) if iso_a == "default" else iso_a
    b = iso() if iso_b == "default" else iso_b
    return probe.combine(outside or reach(), inside_ or inner(), host_user, CFG, a, b, tricks, other, e2e, stranger)


class CombineTest(unittest.TestCase):
    def test_all_blocked_and_all_reachable_outside_is_all_pass(self):
        rows = verdicts()
        self.assertEqual({v for v, _, _ in rows}, {"PASS"}, [r for r in rows if r[0] != "PASS"])
        self.assertEqual(probe.exit_code(rows), 0)

    def test_refused_outside_is_not_tested_never_pass(self):
        rows = verdicts(outside=reach(all_up=False, up=("model direct 127.0.0.1:8000",)))
        by = {c: v for v, c, _ in rows}
        self.assertEqual(by["blocked in sandbox: model direct 127.0.0.1:8000"], "PASS")
        self.assertEqual(by["blocked in sandbox: OpenBao on the LAN 10.10.10.220:8200"], "NOT TESTED")
        self.assertNotIn("FAIL", by.values())
        self.assertEqual(probe.exit_code(rows), 0)  # no listener: not testable, allowed

    def test_any_leak_fails(self):
        leak = inner()
        leak["tcp"]["OpenBao on the LAN 10.10.10.220:8200"] = True
        self.assertIn("FAIL", {v for v, _, _ in verdicts(inside_=leak)})
        for over in [{"af_unix": "allowed"}, {"ipv6": "allowed"}, {"interfaces": ["eth0", "lo"]}, {"dns_lookup": True},
                     {"models": ["some-other-model"]}, {"models": [CFG["MODEL"], "x"]}, {"other_model": 200},
                     {"key_readable": {probe.KEY_FILES[0]: True}}, {"chat": "status 502"},
                     {"host_files": {"/etc/shadow": True}},
                     {"udp_send": {probe.UDP_SEND_TARGETS[0][0]: "sent"}}]:
            rows = verdicts(inside_=inner(**over))
            self.assertIn("FAIL", {v for v, _, _ in rows}, over)
            self.assertEqual(probe.exit_code(rows), 1, over)

    def test_host_user_reaching_anything_fails(self):
        hu = {"tcp": dict(HOST_USER_BLOCKED["tcp"])}
        hu["tcp"]["internet 1.1.1.1:443"] = True
        self.assertIn("FAIL", {v for v, _, _ in verdicts(host_user=hu)})

    def test_isolation_any_gap_fails(self):
        for key in [k for k in iso() if k != "own_procs"]:
            rows = verdicts(iso_b=iso(**{key: False}))
            self.assertIn(("FAIL", f"isolation iso-b: {key}"), {(v, c) for v, c, _ in rows}, key)
        rows = verdicts(iso_a=dict(iso(own_procs=list(range(1, 80))), overlapped=True))
        self.assertIn("FAIL", {v for v, _, _ in rows})  # it can see many processes: not its own namespace
        rows = verdicts(iso_a=dict(iso(), overlapped=False))
        self.assertIn(("FAIL", "isolation: both probes ran at the same time"), {(v, c) for v, c, _ in rows})
        rows = verdicts(iso_a={"error": "root never sent peer.json"})
        self.assertEqual(probe.exit_code(rows), 1)

    def test_required_checks_missing_fail_the_run(self):
        for kwargs in [{"iso_a": None}, {"iso_b": None}, {"tricks": None}, {"other": None}, {"e2e": None},
                       {"stranger": None}, {"host_user": None}, {"host_user": {"tcp": {}}}, {"host_user": {}},
                       {"inside_": {k: v for k, v in inner().items() if k != "ipv6"}},
                       {"inside_": {k: v for k, v in inner().items() if k != "udp_send"}}]:
            rows = verdicts(**kwargs)
            self.assertIn("NOT TESTED (required)", {v for v, _, _ in rows}, kwargs)
            self.assertEqual(probe.exit_code(rows), 1, kwargs)

    def test_e2e_outside_the_window_fails(self):
        rows = verdicts(e2e={"skipped": "outside the off-hours window (now 14:00); run the pre-flight between 22:00 and 06:00"})
        bad = [(v, d) for v, c, d in rows if c == "end to end: a real submit through dispatch"]
        self.assertEqual(bad, [("FAIL", "end-to-end not run: outside the off-hours window (now 14:00); "
                                        "run the pre-flight between 22:00 and 06:00")])
        self.assertEqual(probe.exit_code(rows), 1)
        self.assertEqual(probe.exit_code(verdicts(e2e={"skipped": "STOP file present"})), 1)
        for bad in [{"submit": "refused: x"}, {**E2E_OK, "status": "done 1"}, {**E2E_OK, "fetched_bytes": 0}]:
            self.assertEqual(probe.exit_code(verdicts(e2e=bad)), 1, bad)

    def test_proxy_tricks_and_stranger(self):
        for label in probe.TRICK_EXPECT:
            rows = verdicts(tricks={**TRICKS_OK, label: 200})
            self.assertIn(("FAIL", f"proxy refuses: {label}"), {(v, c) for v, c, _ in rows}, label)
        self.assertEqual(probe.exit_code(verdicts(other="served 200")), 1)
        self.assertEqual(probe.exit_code(verdicts(stranger="served 200")), 1)
        self.assertEqual(probe.exit_code(verdicts(stranger="no access")), 1)  # the peer check itself never ran
        self.assertEqual(probe.exit_code(verdicts(other="refused by peer check")), 0)

    def test_message_tricks_are_in_the_live_set(self):
        for label in ("image_url content part", "tool_calls in a message", "tool role message"):
            self.assertEqual(probe.TRICK_EXPECT[label], {400})

    def test_named_targets_are_checked(self):
        targets = {(h, p) for _, h, p in probe.TCP_TARGETS}
        for want in [("10.10.10.220", 8200), ("127.0.0.1", 8420), ("127.0.0.1", 8093), ("127.0.0.1", 3000),
                     ("127.0.0.1", 22), ("127.0.0.1", 4322), ("127.0.0.1", 4323), ("127.0.0.1", 8000),
                     ("100.78.45.14", 22), ("1.1.1.1", 443)]:
            self.assertIn(want, targets)
        self.assertTrue(any(h.startswith("172.20.0.1") for _, h, _ in probe.TCP_TARGETS))

    def test_inside_uses_the_model_setting(self):
        seen = []

        def http(method, url, body=None):
            seen.append((method, url, body))
            if url.endswith("/models"):
                return 200, {"data": [{"id": CFG["MODEL"]}]}
            return (200, {"choices": [{"message": {"content": "ok"}}]}) if body.get("model") == CFG["MODEL"] else (403, {})
        res = probe.inside(CFG, tcp_=lambda h, p: False, dns_=lambda s: False, resolve_=lambda n: False,
                           unix_=lambda p: "no socket support", abstract_=lambda: "refused", read_=lambda p: False,
                           ifaces_=lambda: ["lo"], http_=http, udp_=lambda h, p: "blocked ENETUNREACH",
                           ipv6_=lambda: "refused")
        self.assertEqual(res["models"], [CFG["MODEL"]])
        self.assertEqual(res["chat"], "returns")
        self.assertEqual(res["other_model"], 403)
        self.assertTrue(all(u.startswith(CFG["JOB_PROXY_URL"].rstrip("/")) for _, u, _ in seen))


class IsolationChecksTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.own_dir = base / "probe" / "iso-a"
        self.own_dir.mkdir(parents=True)
        self.proc = base / "proc"
        self.proc.mkdir()
        (self.proc / "1").mkdir()  # only our own PID 1 in our namespace
        self.marker = Path("/tmp/iso-marker-iso-a")
        self.marker.write_text("iso-a")
        self.shm = base / "shm"
        self.shm.mkdir()
        (self.shm / "iso-shm-iso-a").write_text("iso-a")
        self.queues = {probe.SYSV_KEYS["iso-a"]: 7}  # only our own queue exists in our IPC namespace

    def sysv(self, key, create):
        return self.queues.get(key, -1)

    def tearDown(self):
        self.marker.unlink(missing_ok=True)
        self.tmp.cleanup()

    def peer(self, pid):
        return {"peer": "iso-b", "peer_host_pid": pid, "peer_dir": str(Path(self.tmp.name) / "probe" / "iso-b")}

    def test_isolated_view(self):
        res = probe.isolation_checks("iso-a", str(self.own_dir), self.peer(999_999), proc=str(self.proc),
                                     sysv_=self.sysv, shm=str(self.shm))
        self.assertTrue(all(v is True for k, v in res.items() if k != "own_procs"), res)
        self.assertEqual(res["own_procs"], [1])

    def test_shared_ipc_is_caught(self):
        (self.shm / "iso-shm-iso-b").write_text("iso-b")  # the peer's /dev/shm file is visible
        self.queues[probe.SYSV_KEYS["iso-b"]] = 8            # and so is its SysV queue
        res = probe.isolation_checks("iso-a", str(self.own_dir), self.peer(999_999), proc=str(self.proc),
                                     sysv_=self.sysv, shm=str(self.shm))
        self.assertFalse(res["peer /dev/shm marker unreachable"])
        self.assertFalse(res["peer SysV message queue unreachable"])
        rows = verdicts(iso_b={k: v for k, v in res.items()})
        self.assertIn(("FAIL", "isolation iso-b: peer SysV message queue unreachable"), {(v, c) for v, c, _ in rows})

    def test_a_visible_live_peer_is_caught(self):
        pid = os.getpid()  # a process that really exists and can be signalled
        (self.proc / str(pid)).mkdir()
        (Path(self.tmp.name) / "probe" / "iso-b").mkdir()
        (Path(self.tmp.name) / "probe" / "iso-b" / "own.txt").write_text("iso-b")
        res = probe.isolation_checks("iso-a", str(self.own_dir), self.peer(pid), proc=str(self.proc),
                                     sysv_=self.sysv, shm=str(self.shm))
        for key in ("peer pid not in our /proc", "peer pid can't be signalled", "peer folder unreachable",
                    "peer marker file unreachable", "only own probe folder visible"):
            self.assertFalse(res[key], key)


class OtherUserTest(unittest.TestCase):
    """The stranger row needs the PEER CHECK to refuse, not the socket's file mode."""

    class Sock:
        def __init__(self, reply):
            self.reply, self.sent = reply, b""

        def sendall(self, data):
            self.sent += data

        def recv(self, n):
            return self.reply[:n]

        def close(self):
            pass

    def test_three_outcomes(self):
        def no_access():
            raise PermissionError(13, "denied")
        self.assertEqual(probe.other_user("/x.sock", connect=no_access), "no access")
        self.assertEqual(probe.other_user("/x.sock", connect=lambda: self.Sock(b"")), "refused by peer check")
        self.assertEqual(probe.other_user("/x.sock", connect=lambda: self.Sock(b"HTTP/1.0 200 OK\r\n")), "served 200")


class FileMoveTest(unittest.TestCase):
    def test_give_and_take_never_follow_links(self):
        with tempfile.TemporaryDirectory() as d:
            secret = Path(d) / "secret"
            secret.write_text("TOP SECRET")
            box = Path(d) / "box"
            box.mkdir()
            os.symlink(secret, box / "result.json")
            self.assertIsNone(probe.take(str(box), "result.json"))  # never reads through the link
            os.symlink(secret, box / "peer.json")
            with self.assertRaises(OSError):
                probe.give(str(box), "peer.json", b"{}")  # never writes through the link
            self.assertEqual(secret.read_text(), "TOP SECRET")
            probe.give(str(box), "release", b"")
            self.assertEqual(probe.take(str(box), "release"), b"")
            os.rename(box, Path(d) / "real")
            os.symlink(Path(d) / "real", box)
            self.assertIsNone(probe.take(str(box), "release"))  # the folder itself as a link: refused

    def test_proxy_tricks_sends_every_trick(self):
        seen = []
        res = probe.proxy_tricks("/x.sock", CFG["MODEL"], request=lambda m, p, b: seen.append((m, p, b)) or 404)
        self.assertEqual(set(res), set(probe.TRICK_EXPECT))
        dup = next(b for m, p, b in seen if b and b.count(b'"model"') == 2)
        self.assertIn(CFG["MODEL"].encode(), dup)
        json.loads(next(b for m, p, b in seen if b and b"comment" not in b and b.count(b'"model"') == 1 and b"upper" not in b))


if __name__ == "__main__":
    unittest.main()
