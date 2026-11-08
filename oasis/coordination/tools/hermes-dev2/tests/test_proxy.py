"""The key-holding proxy: Unix socket only, peer-uid check, MODEL only, upstream owner check,
two routes, our key replaces any client key, size cap, connection cap, fixed errors."""

import http.client
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from _load import config, load

proxy = load("bin/hermes_proxy.py", "hermes_proxy")
common = load("bin/hermes_dev2_common.py", "hermes_dev2_common")
FAKE_KEY = "sk-FAKE-0000"
MODEL = config()["MODEL"]
UPSTREAM_UID = 4242


class FakeUpstream(BaseHTTPRequestHandler):
    seen: list = []
    status = 200  # tests set an error status to check the error body is never passed on

    def log_message(self, *a):
        pass

    def _answer(self):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        FakeUpstream.seen.append({"method": self.command, "path": self.path,
                                  "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
        if FakeUpstream.status != 200:  # a server that echoes the request headers (and so the key) in its error
            out = json.dumps({"error": "bad", "echo": dict(self.headers.items())}).encode()
            self.send_response(FakeUpstream.status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        out = json.dumps({"data": [{"id": MODEL}]} if self.command == "GET" else
                         {"choices": [{"message": {"content": "ok"}}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("x-upstream-secret", "never-forwarded")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = _answer


class ProxyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.up = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        threading.Thread(target=cls.up.serve_forever, daemon=True).start()
        cls.logs = []
        cls.owner = [UPSTREAM_UID]
        cls.peer = os.getuid()
        cls.gates = proxy.make_gates(3)
        handler = proxy.make_handler(FAKE_KEY, ("127.0.0.1", cls.up.server_address[1]), MODEL, UPSTREAM_UID,
                                     cls.gates, log=lambda *a, **k: cls.logs.append(a[0]),
                                     upstream_owner=lambda sock, up: list(cls.owner), max_tokens=100)
        cls.dir = tempfile.mkdtemp(dir="/tmp")  # short path: AF_UNIX path limit on macOS
        cls.path = os.path.join(cls.dir, "p.sock")
        cls.px = proxy.Server(cls.path, handler, allowed_uids={0, 1001}, peer_uid=lambda req: cls.peer)
        threading.Thread(target=cls.px.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.px.shutdown()
        cls.px.server_close()
        cls.up.shutdown()
        cls.up.server_close()
        os.unlink(cls.path)
        os.rmdir(cls.dir)

    def setUp(self):
        FakeUpstream.seen.clear()
        FakeUpstream.status = 200
        type(self).owner = [UPSTREAM_UID]
        type(self).peer = 1001  # hermes-w

    def request(self, method, path, body=None, headers=None):
        conn = common.UnixHTTPConnection(self.path, timeout=10)
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp, data

    def chat(self, model=MODEL, **headers):
        return self.request("POST", "/v1/chat/completions",
                            body=json.dumps({"model": model, "messages": [{"role": "user", "content": "hi"}]}).encode(),
                            headers={"content-type": "application/json", **headers})

    def test_models_passes_and_key_is_ours(self):
        resp, data = self.request("GET", "/v1/models", headers={"Authorization": "Bearer worker-guess"})
        self.assertEqual(resp.status, 200)
        self.assertIn(MODEL, data.decode())
        self.assertEqual(FakeUpstream.seen[0]["headers"]["authorization"], f"Bearer {FAKE_KEY}")

    def test_chat_for_the_model_forwards_and_drops_other_headers(self):
        resp, _ = self.chat(authorization="Bearer x", cookie="a=b")
        self.assertEqual(resp.status, 200)
        sent = FakeUpstream.seen[0]
        self.assertEqual(sent["headers"]["authorization"], f"Bearer {FAKE_KEY}")
        self.assertNotIn("cookie", sent["headers"])
        self.assertIsNone(resp.getheader("x-upstream-secret"))

    def test_any_other_model_is_refused_before_upstream(self):
        msgs = [{"role": "user", "content": "x"}]
        for body in [json.dumps({"model": "some-other-model", "messages": msgs}).encode(),
                     json.dumps({"messages": msgs}).encode(), b'["model"]',
                     json.dumps({"model": MODEL.upper(), "messages": msgs}).encode(),
                     json.dumps({"x": {"model": MODEL}, "messages": msgs}).encode()]:
            resp, data = self.request("POST", "/v1/chat/completions", body=body)
            self.assertEqual(resp.status, 403, body)
            self.assertEqual(data, b"model not allowed\n")
        self.assertEqual(FakeUpstream.seen, [])

    def test_duplicate_keys_and_bad_json_are_refused(self):
        for body in [('{"model":"other","model":"%s","messages":[{"role":"user"}]}' % MODEL).encode(),
                     ('{"model":"%s","messages":[{"role":"user","role":"system"}]}' % MODEL).encode(),
                     b"not json", ('{"model":"%s" /* c */}' % MODEL).encode()]:
            resp, _ = self.request("POST", "/v1/chat/completions", body=body)
            self.assertEqual(resp.status, 400, body)
        self.assertEqual(FakeUpstream.seen, [])

    def test_body_is_rebuilt_from_the_allow_list(self):
        body = {"model": MODEL, "messages": [{"role": "user", "content": "hi"}], "temperature": 0.2, "stream": True,
                "stream_options": {"include_usage": True, "evil": 1}, "max_tokens": 5000, "n": 9, "logit_bias": {"1": 100},
                "tools": [{"type": "function"}], "extra_server_option": "x", "chat_template_kwargs": {"a": 1}}
        resp, _ = self.request("POST", "/v1/chat/completions", body=json.dumps(body).encode())
        self.assertEqual(resp.status, 200)
        sent = json.loads(FakeUpstream.seen[0]["body"])
        self.assertEqual(sent, {"model": MODEL, "messages": [{"role": "user", "content": "hi"}], "temperature": 0.2,
                                "stream": True, "stream_options": {"include_usage": True}, "max_tokens": 100, "n": 1})

    def test_max_tokens_cap_and_default(self):
        for asked, want in [(None, 100), (50, 50), (100, 100), (101, 100), (10**9, 100)]:
            body = {"model": MODEL, "messages": [{"role": "user", "content": "x"}]}
            if asked is not None:
                body["max_completion_tokens"] = asked
            sent = json.loads(proxy.build_chat_body(json.dumps(body).encode(), MODEL, 100))
            self.assertEqual(sent["max_tokens"], want, asked)
            self.assertNotIn("max_completion_tokens", sent)
        for bad in [0, -1, "10", True, 1.5]:
            with self.assertRaises(proxy.BodyRefused):
                proxy.build_chat_body(json.dumps({"model": MODEL, "messages": [{"role": "u"}], "max_tokens": bad}).encode(), MODEL, 100)

    def test_upstream_error_body_never_reaches_the_job(self):
        FakeUpstream.status = 401
        resp, data = self.chat()
        self.assertEqual(resp.status, 401)
        self.assertEqual(data, b"upstream error\n")
        self.assertNotIn(FAKE_KEY.encode(), data)
        FakeUpstream.status = 500
        resp, data = self.request("GET", "/v1/models")
        self.assertEqual((resp.status, data), (500, b"upstream error\n"))

    def test_root_keeps_its_own_upstream_slot(self):
        jobs = self.gates["jobs"]
        taken = 0
        while jobs.acquire(blocking=False):
            taken += 1
        try:
            type(self).peer = 1001
            orig = proxy.time.monotonic
            resp, data = self.request_with_gate_timeout()
            self.assertEqual((resp.status, data), (503, b"busy\n"))
            type(self).peer = 0  # root: the watchdog's probe still gets through
            self.assertEqual(self.request("GET", "/v1/models")[0].status, 200)
        finally:
            for _ in range(taken):
                jobs.release()

    def request_with_gate_timeout(self):
        # The jobs gate waits up to 30 s; shorten it for the test by patching acquire's timeout.
        real = self.gates["jobs"].acquire
        self.gates["jobs"].acquire = lambda timeout=None, blocking=True: real(blocking=False)
        try:
            return self.request("GET", "/v1/models")
        finally:
            self.gates["jobs"].acquire = real

    def test_peer_other_than_hermes_w_or_root_is_dropped(self):
        type(self).peer = 1234
        with self.assertRaises((ConnectionError, http.client.RemoteDisconnected, OSError)):
            self.request("GET", "/v1/models")
        self.assertEqual(FakeUpstream.seen, [])
        type(self).peer = 0  # root (watchdog, pre-flight)
        self.assertEqual(self.request("GET", "/v1/models")[0].status, 200)

    def test_key_never_sent_when_upstream_owner_is_wrong(self):
        for owner in ([1234], [], [UPSTREAM_UID, 1234]):
            type(self).owner = owner
            resp, data = self.request("GET", "/v1/models")
            self.assertEqual(resp.status, 502)
            self.assertEqual(data, b"upstream owner mismatch\n")
        self.assertEqual(FakeUpstream.seen, [])  # the request (and the key) never went out

    def test_other_routes_and_methods_refused_without_reaching_upstream(self):
        for method, path in [("GET", "/v1/embeddings"), ("POST", "/v1/models"), ("GET", "/v1/models?x=1"),
                             ("GET", "/v1/models/../x"), ("GET", "//v1/models"), ("GET", "/admin"),
                             ("DELETE", "/v1/models"), ("POST", "/v1/completions")]:
            resp, _ = self.request(method, path)
            self.assertIn(resp.status, (404, 405), (method, path))
        self.assertEqual(FakeUpstream.seen, [])

    def test_body_cap(self):
        conn = common.UnixHTTPConnection(self.path, timeout=10)
        conn.putrequest("POST", "/v1/chat/completions")
        conn.putheader("content-length", str(proxy.MAX_BODY + 1))
        conn.endheaders()
        resp = conn.getresponse()
        resp.read()
        conn.close()
        self.assertEqual(resp.status, 413)
        self.assertEqual(FakeUpstream.seen, [])

    def test_logs_never_carry_the_key_or_bodies(self):
        self.request("POST", "/v1/chat/completions",
                     body=json.dumps({"model": MODEL, "messages": [{"role": "user", "content": "private text"}]}).encode())
        joined = "\n".join(self.logs)
        self.assertNotIn(FAKE_KEY, joined)
        self.assertNotIn("private text", joined)

    def test_upstream_headers_function(self):
        h = proxy.upstream_headers({"Authorization": "Bearer evil", "Content-Type": "application/json", "Host": "x"}, FAKE_KEY, 5)
        self.assertEqual(h, {"content-type": "application/json", "authorization": f"Bearer {FAKE_KEY}", "content-length": "5"})


class ConnectionCapTest(unittest.TestCase):
    def test_root_has_a_connection_slot_jobs_cant_take(self):
        started = threading.Event()
        release = threading.Event()
        served = []

        class Slow(BaseHTTPRequestHandler):
            def handle(self):
                served.append(1)
                started.set()
                release.wait(5)

        d = tempfile.mkdtemp(dir="/tmp")
        path = os.path.join(d, "r.sock")
        who = {"uid": 1001}
        srv = proxy.Server(path, Slow, allowed_uids={0, 1001}, peer_uid=lambda r: who["uid"], max_connections=2)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            a = socket.socket(socket.AF_UNIX)
            a.connect(path)  # the one job slot (2 - 1 for root)
            started.wait(5)
            b = socket.socket(socket.AF_UNIX)
            b.connect(path)
            b.settimeout(5)
            self.assertEqual(b.recv(1), b"")  # a second job connection: closed at once
            who["uid"] = 0
            started.clear()
            c = socket.socket(socket.AF_UNIX)
            c.connect(path)  # root still gets in
            self.assertTrue(started.wait(5))
            release.set()
            for s_ in (a, b, c):
                s_.close()
        finally:
            srv.shutdown()
            srv.server_close()
            os.unlink(path)
            os.rmdir(d)

    def test_extra_connections_are_closed_without_a_thread(self):
        started = threading.Event()
        release = threading.Event()

        class Slow(BaseHTTPRequestHandler):
            def handle(self):
                started.set()
                release.wait(5)

        d = tempfile.mkdtemp(dir="/tmp")
        path = os.path.join(d, "c.sock")
        srv = proxy.Server(path, Slow, allowed_uids={1001}, peer_uid=lambda r: 1001, max_connections=2)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            a = socket.socket(socket.AF_UNIX)
            a.connect(path)
            started.wait(5)
            b = socket.socket(socket.AF_UNIX)
            b.connect(path)
            b.settimeout(5)
            self.assertEqual(b.recv(1), b"")  # closed at once: the one slot is taken
            release.set()
            a.close()
            b.close()
        finally:
            srv.shutdown()
            srv.server_close()
            os.unlink(path)
            os.rmdir(d)


class KeyTest(unittest.TestCase):
    def test_key_must_be_printable_ascii(self):
        d = tempfile.mkdtemp()
        for bad in ["", "two words", "tab\there", "ctrl\x07char", "café"]:
            with open(os.path.join(d, "model.key"), "w", encoding="utf-8") as fh:
                fh.write(bad)
            with self.assertRaises(SystemExit, msg=repr(bad)) as cm:
                proxy.read_key(d)
            self.assertNotIn(bad or "@@", str(cm.exception))  # the key never appears in the error
        with open(os.path.join(d, "model.key"), "w") as fh:
            fh.write(FAKE_KEY + "\n")
        self.assertEqual(proxy.read_key(d), FAKE_KEY)

    def test_build_chat_body_refusals(self):
        msgs = [{"role": "user", "content": "x"}]
        for body, status in [(b"", 400), (b"null", 403), (b'{"model": null}', 403), (json.dumps({"model": "x"}).encode(), 403),
                             (json.dumps({"model": MODEL}).encode(), 400), (json.dumps({"model": MODEL, "messages": []}).encode(), 400),
                             (json.dumps({"model": MODEL, "messages": [{"content": "no role"}]}).encode(), 400),
                             (json.dumps({"model": MODEL, "messages": msgs, "temperature": "hot"}).encode(), 400),
                             (json.dumps({"model": MODEL, "messages": msgs, "stream": "yes"}).encode(), 400),
                             (json.dumps({"model": MODEL, "messages": msgs, "stop": [1]}).encode(), 400)]:
            with self.assertRaises(proxy.BodyRefused, msg=body) as cm:
                proxy.build_chat_body(body, MODEL, 100)
            self.assertEqual(cm.exception.status, status, body)


class MessageAllowListTest(unittest.TestCase):
    """build_message: only role (system/user/assistant) and text content survive; everything
    else about a message is refused (400), not silently dropped."""

    def test_string_content_passes_through_unchanged(self):
        self.assertEqual(proxy.build_message({"role": "user", "content": "hi"}), {"role": "user", "content": "hi"})

    def test_text_parts_list_passes_through_unchanged(self):
        m = {"role": "assistant", "content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}
        self.assertEqual(proxy.build_message(m), m)

    def test_unknown_top_level_key_refused(self):
        for extra in ({"name": "bob"}, {"tool_calls": []}, {"tool_call_id": "1"}, {"audio": {}}, {"function_call": {}}):
            with self.assertRaises(proxy.BodyRefused) as cm:
                proxy.build_message({"role": "user", "content": "x", **extra})
            self.assertEqual(cm.exception.status, 400)

    def test_extra_roles_refused(self):
        for role in ("tool", "function", "developer", "Tool", "USER", ""):
            with self.assertRaises(proxy.BodyRefused) as cm:
                proxy.build_message({"role": role, "content": "x"})
            self.assertEqual(cm.exception.status, 400)

    def test_missing_role_refused(self):
        with self.assertRaises(proxy.BodyRefused):
            proxy.build_message({"content": "x"})

    def test_nested_non_text_part_refused(self):
        bad_parts = [
            {"type": "image_url", "image_url": {"url": "http://10.10.10.220:8200/x"}},
            {"type": "input_audio", "input_audio": {"data": "...", "format": "wav"}},
            {"type": "text"},  # missing text
            {"type": "text", "text": "x", "extra": 1},  # extra key on the part
            "just a string",  # not even a dict
        ]
        for part in bad_parts:
            with self.assertRaises(proxy.BodyRefused, msg=part) as cm:
                proxy.build_message({"role": "user", "content": [part]})
            self.assertEqual(cm.exception.status, 400, part)

    def test_empty_or_missing_or_non_text_content_refused(self):
        for content in ([], None, 5, {"type": "text", "text": "x"}, True):
            with self.assertRaises(proxy.BodyRefused, msg=repr(content)) as cm:
                proxy.build_message({"role": "user", "content": content})
            self.assertEqual(cm.exception.status, 400)

    def test_end_to_end_through_build_chat_body(self):
        msgs = [{"role": "assistant", "content": "ok", "tool_calls": [{"id": "1"}]}]
        with self.assertRaises(proxy.BodyRefused) as cm:
            proxy.build_chat_body(json.dumps({"model": MODEL, "messages": msgs}).encode(), MODEL, 100)
        self.assertEqual(cm.exception.status, 400)
        msgs = [{"role": "tool", "content": "x"}]
        with self.assertRaises(proxy.BodyRefused) as cm:
            proxy.build_chat_body(json.dumps({"model": MODEL, "messages": msgs}).encode(), MODEL, 100)
        self.assertEqual(cm.exception.status, 400)


if __name__ == "__main__":
    unittest.main()
