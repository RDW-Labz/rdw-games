#!/usr/bin/python3 -I
"""The model proxy for Hermes workers on dev2 (decision #384: the proxy holds the key).

Listens ONLY on a Unix socket (PROXY_SOCKET, hermes-proxy:hermes-sock 0660)
and accepts a connection only when the peer (SO_PEERCRED) is hermes-w or
root. There is no TCP listener, so no other local user or container can use
the model through it. It forwards exactly two calls to the model on
UPSTREAM_HOST:UPSTREAM_PORT:

    GET  /v1/models
    POST /v1/chat/completions      (only for the configured MODEL)

A chat body is never passed through as sent. It is parsed (a key repeated
at any level is refused), then a NEW body is built from an allow-list of
fields; everything else is dropped, max_tokens is capped at MAX_TOKENS and
n is forced to 1. One upstream slot and one connection slot are kept for
root (the watchdog's speed probe and the pre-flight), so jobs can never
starve the stop rule. A non-200 answer from the model reaches the job only
as a fixed message with the same status: an upstream that echoes the key
in an error body can't leak it into job output.

It drops any Authorization header the client sends and adds its own bearer
key, read once at start from the systemd credential `model.key`. Before the
key goes out, it checks that the TCP peer it just connected to is owned by
UPSTREAM_UID (from /proc/net/tcp), so a squatter on port 8000 never sees it.

Logs one line per request: method, path, status, duration. Never bodies,
never headers, never the key; every error is a fixed message. Python stdlib
only.
"""

from __future__ import annotations

import http.client
import json
import os
import grp
import pwd
import re
import socket
import socketserver
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from hermes_dev2_common import PROXY_CONF_PATH, load_config, loads_strict, parse_config, tcp_socket_uids  # noqa: E402

ALLOWED = {("GET", "/v1/models"), ("POST", "/v1/chat/completions")}
MAX_BODY = 2_000_000
MAX_UPSTREAM = 3  # concurrent model calls: MAX_UPSTREAM - 1 for jobs, 1 kept for root
MAX_CONNECTIONS = 8  # concurrent client connections: MAX_CONNECTIONS - 1 for jobs, 1 kept for root
DEFAULT_MAX_TOKENS = 8192
SOCKET_GROUP = "hermes-sock"
UPSTREAM_TIMEOUT = 600  # seconds; one long completion
CLIENT_TIMEOUT = 30  # seconds to send the request (slowloris cap)
PASS_REQUEST_HEADERS = ("content-type", "accept")
PASS_RESPONSE_HEADERS = ("content-type", "cache-control")
KEY_CHARS = re.compile(r"[\x21-\x7e]+")


def read_key(credentials_dir: str | None) -> str:
    """The bearer key from $CREDENTIALS_DIRECTORY/model.key. Printable ASCII only."""
    if not credentials_dir:
        raise SystemExit("no CREDENTIALS_DIRECTORY: run under hermes-proxy.service (LoadCredential=model.key)")
    try:
        key = (Path(credentials_dir) / "model.key").read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        raise SystemExit("model.key unreadable or not ASCII") from None
    if not KEY_CHARS.fullmatch(key):
        raise SystemExit("model.key must be one line of printable ASCII (no spaces or control characters)")
    return key


def allowed(method: str, path: str) -> bool:
    """Exact method + path match; no query strings, no other routes."""
    return (method, path) in ALLOWED


class BodyRefused(Exception):
    """A chat body we turn down: (status, fixed message)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


ROLES = ("system", "user", "assistant")


def build_message(m) -> dict:
    """One message rebuilt from scratch, or BodyRefused (400).

    Kept: role (system, user or assistant) and content, which is either a
    string or a list of parts that are each exactly {"type": "text", "text":
    str}. Any other key (name, tool_calls, tool_call_id, audio, ...) and any
    other part type (image_url, input_audio, file, ...) is refused, not
    dropped: a model server that fetches an image URL would do it as itself,
    on the host network.
    """
    if not isinstance(m, dict) or set(m) - {"role", "content"}:
        raise BodyRefused(400, "each message may hold only role and content")
    if m.get("role") not in ROLES:
        raise BodyRefused(400, "role must be system, user or assistant")
    content = m.get("content")
    if isinstance(content, str):
        return {"role": m["role"], "content": content}
    if isinstance(content, list) and content:
        parts = []
        for part in content:
            if not isinstance(part, dict) or set(part) != {"type", "text"} or part["type"] != "text" \
                    or not isinstance(part["text"], str):
                raise BodyRefused(400, "content parts must be text only")
            parts.append({"type": "text", "text": part["text"]})
        return {"role": m["role"], "content": parts}
    raise BodyRefused(400, "content must be text")


def build_chat_body(raw: bytes, model: str, max_tokens: int) -> bytes:
    """A NEW chat body built from an allow-list, or BodyRefused.

    Kept: model (must equal MODEL), messages (each rebuilt by build_message:
    role + text content only), temperature, top_p, stream,
    stream_options.include_usage, stop.
    max_tokens / max_completion_tokens become one max_tokens, capped at
    `max_tokens` (and set to it when missing). n is always 1. Every other
    field (tools, extra_body keys, logit_bias, n > 1, server-specific
    options) is dropped.
    """
    try:
        data = loads_strict(raw)
    except (ValueError, UnicodeDecodeError):
        raise BodyRefused(400, "body must be one JSON object with no repeated keys") from None
    if not isinstance(data, dict) or data.get("model") != model:
        raise BodyRefused(403, "model not allowed")
    messages = data.get("messages")
    if not isinstance(messages, list) or not messages:
        raise BodyRefused(400, "messages must be a non-empty list")
    out: dict = {"model": model, "messages": [build_message(m) for m in messages]}
    for name in ("temperature", "top_p"):
        if name in data:
            if not _number(data[name]):
                raise BodyRefused(400, f"{name} must be a number")
            out[name] = data[name]
    if "stream" in data:
        if not isinstance(data["stream"], bool):
            raise BodyRefused(400, "stream must be true or false")
        out["stream"] = data["stream"]
        opts = data.get("stream_options")
        if out["stream"] and isinstance(opts, dict) and isinstance(opts.get("include_usage"), bool):
            out["stream_options"] = {"include_usage": opts["include_usage"]}
    if "stop" in data:
        stop = data["stop"]
        if isinstance(stop, str):
            out["stop"] = stop
        elif isinstance(stop, list) and len(stop) <= 4 and all(isinstance(x, str) for x in stop):
            out["stop"] = stop
        elif stop is not None:
            raise BodyRefused(400, "stop must be a string or up to 4 strings")
    asked = [v for v in (data.get("max_tokens"), data.get("max_completion_tokens")) if v is not None]
    if any(not isinstance(v, int) or isinstance(v, bool) or v < 1 for v in asked):
        raise BodyRefused(400, "max_tokens must be a positive integer")
    out["max_tokens"] = min([max_tokens, *asked])
    out["n"] = 1
    return json.dumps(out, separators=(",", ":")).encode()


def upstream_headers(incoming: dict[str, str], key: str, length: int | None) -> dict[str, str]:
    """Headers sent upstream: only the pass-list, plus our Authorization."""
    out = {k: v for k, v in ((k.lower(), v) for k, v in incoming.items()) if k in PASS_REQUEST_HEADERS}
    out["authorization"] = f"Bearer {key}"
    if length is not None:
        out["content-length"] = str(length)
    return out


def peer_uid_linux(sock: socket.socket) -> int:
    """The connecting process's uid, from SO_PEERCRED (pid, uid, gid)."""
    creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    return struct.unpack("3i", creds)[1]


def upstream_owner_linux(sock: socket.socket, upstream: tuple[str, int]) -> list[int]:
    """uids owning the server end of OUR connection to upstream, from /proc/net/tcp."""
    local_port = sock.getsockname()[1]
    text = Path("/proc/net/tcp").read_text()
    return tcp_socket_uids(text, upstream, (upstream[0], local_port), "01")


def make_gates(max_upstream: int = MAX_UPSTREAM) -> dict[str, threading.BoundedSemaphore]:
    """Upstream slots: jobs share max_upstream - 1, root always has its own one."""
    return {"jobs": threading.BoundedSemaphore(max(1, max_upstream - 1)), "root": threading.BoundedSemaphore(1)}


def make_handler(key: str, upstream: tuple[str, int], model: str, upstream_uid: int,
                 gates: dict[str, threading.BoundedSemaphore], log=print, upstream_owner=upstream_owner_linux,
                 max_tokens: int = DEFAULT_MAX_TOKENS):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"  # close-delimited bodies: streaming passes straight through
        timeout = CLIENT_TIMEOUT

        def address_string(self) -> str:  # AF_UNIX peers have no address
            return "unix"

        def log_message(self, *args) -> None:  # silence default access log (it can echo paths)
            pass

        def _finish(self, status: int, started: float) -> None:
            path = self.path.split("?")[0][:64] if isinstance(getattr(self, "path", None), str) else "-"
            log(f"{getattr(self, 'command', '-')} {path} {status} {time.monotonic() - started:.2f}s", flush=True)

        def _reply(self, status: int, message: str) -> None:
            body = (message + "\n").encode()
            self.send_response(status)
            self.send_header("content-type", "text/plain")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _handle(self) -> None:
            started = time.monotonic()
            status = 500
            try:
                status = self._serve()
            except Exception:  # noqa: BLE001 - never let an exception text (or the key) reach a log or a client
                status = 502
                try:
                    self._reply(status, "upstream error")
                except Exception:  # noqa: BLE001
                    pass
            finally:
                self._finish(status, started)

        def _raw_path(self) -> str:
            """The path exactly as sent (http.server rewrites a leading '//' in self.path)."""
            parts = self.requestline.split()
            return parts[1] if len(parts) == 3 else ""

        def _serve(self) -> int:
            if not allowed(self.command, self._raw_path()) or self.path != self._raw_path():
                self._reply(404, "not allowed")
                return 404
            body = None
            peer = getattr(self.server, "peer_uid", None)
            is_root = False
            if peer is not None:
                try:
                    is_root = peer(self.request) == 0
                except OSError:
                    is_root = False
            gate = gates["root"] if is_root else gates["jobs"]
            if self.command == "POST":
                try:
                    length = int(self.headers.get("content-length", ""))
                except ValueError:
                    self._reply(411, "content-length required")
                    return 411
                if length < 0 or length > MAX_BODY:
                    self._reply(413, "body too large")
                    return 413
                raw = self.rfile.read(length)
                if len(raw) != length:
                    self._reply(400, "short body")
                    return 400
                try:
                    body = build_chat_body(raw, model, max_tokens)
                except BodyRefused as why:
                    self._reply(why.status, why.message)
                    return why.status
            if not gate.acquire(timeout=30):
                self._reply(503, "busy")
                return 503
            try:
                conn = http.client.HTTPConnection(upstream[0], upstream[1], timeout=UPSTREAM_TIMEOUT)
                conn.connect()
                if upstream_owner(conn.sock, upstream) != [upstream_uid]:
                    conn.close()
                    self._reply(502, "upstream owner mismatch")
                    return 502
                conn.request(self.command, self.path, body=body,
                             headers=upstream_headers(dict(self.headers.items()), key,
                                                      len(body) if body is not None else None))
                resp = conn.getresponse()
                if resp.status != 200:
                    # Never pass an upstream error body on: it could echo the key.
                    resp.read(MAX_BODY)
                    conn.close()
                    status = resp.status if 400 <= resp.status <= 599 else 502
                    self._reply(status, "upstream error")
                    return status
                self.send_response(resp.status)
                for name in PASS_RESPONSE_HEADERS:
                    if resp.getheader(name):
                        self.send_header(name, resp.getheader(name))
                self.end_headers()
                while chunk := resp.read1(65536):
                    self.wfile.write(chunk)
                    self.wfile.flush()
                conn.close()
                return resp.status
            finally:
                gate.release()

        do_GET = do_POST = _handle

        def _refuse(self) -> None:
            started = time.monotonic()
            self._reply(405, "method not allowed")
            self._finish(405, started)

        do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _refuse

    return Handler


class Server(socketserver.UnixStreamServer):
    """Unix-socket HTTP server: peer-uid check and connection caps before any thread starts.

    Jobs (hermes-w) share max_connections - 1 slots; root (uid 0) always has
    one of its own. A connection over its cap is closed at once, with no thread.
    """

    def __init__(self, path: str, handler, allowed_uids: set[int], peer_uid=peer_uid_linux,
                 max_connections: int = MAX_CONNECTIONS):
        self.allowed_uids, self.peer_uid = allowed_uids, peer_uid
        self.slots = {"jobs": threading.BoundedSemaphore(max(1, max_connections - 1)),
                      "root": threading.BoundedSemaphore(1)}
        super().__init__(path, handler)

    def verify_request(self, request, client_address) -> bool:
        try:
            return self.peer_uid(request) in self.allowed_uids
        except OSError:
            return False

    def process_request(self, request, client_address) -> None:
        try:
            pool = self.slots["root"] if self.peer_uid(request) == 0 else self.slots["jobs"]
        except OSError:
            self.shutdown_request(request)
            return
        if not pool.acquire(blocking=False):
            self.shutdown_request(request)  # full: close at once, no thread
            return
        thread = threading.Thread(target=self._serve_one, args=(request, client_address, pool), daemon=True)
        try:
            thread.start()
        except Exception:  # noqa: BLE001
            pool.release()
            self.shutdown_request(request)
            raise

    def _serve_one(self, request, client_address, pool) -> None:
        try:
            self.finish_request(request, client_address)
        except Exception:  # noqa: BLE001 - fixed handling, never echo an exception
            pass
        finally:
            self.shutdown_request(request)
            pool.release()


def main() -> None:
    config = load_config()
    pconf = parse_config(PROXY_CONF_PATH.read_text())
    key = read_key(os.environ.get("CREDENTIALS_DIRECTORY"))
    if not pconf.get("UPSTREAM_UID", "").isdigit():
        raise SystemExit("proxy.conf UPSTREAM_UID is not set (run setup-dev2.sh again)")
    upstream = (pconf["UPSTREAM_HOST"], int(pconf["UPSTREAM_PORT"]))
    path = config["PROXY_SOCKET"]
    if os.path.lexists(path):
        os.unlink(path)
    worker = pwd.getpwnam("hermes-w")
    sock_group = grp.getgrnam(SOCKET_GROUP)
    handler = make_handler(key, upstream, config["MODEL"], int(pconf["UPSTREAM_UID"]), make_gates(),
                           max_tokens=int(config.get("MAX_TOKENS", DEFAULT_MAX_TOKENS)))
    old = os.umask(0o117)
    try:
        server = Server(path, handler, allowed_uids={0, worker.pw_uid})
    finally:
        os.umask(old)
    os.chown(path, -1, sock_group.gr_gid)  # hermes-proxy:hermes-sock (SupplementaryGroups=hermes-sock)
    os.chmod(path, 0o660)
    print(f"hermes-proxy listening on {path} -> {upstream[0]}:{upstream[1]} (model {config['MODEL']})",
          file=sys.stderr, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
