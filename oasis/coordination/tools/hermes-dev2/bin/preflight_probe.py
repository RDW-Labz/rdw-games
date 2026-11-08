#!/usr/bin/python3 -I
"""Pre-flight probe for Hermes workers on dev2 (decision #384). Modes:

    --outside OUT.json               root, host network: what IS reachable
    --host-user OUT.json             hermes-w, host network (runuser): nft must drop
    --probe sandbox DIR              inside hermes-w-probe@sandbox: network, files, sockets, proxy
    --probe iso-a|iso-b DIR          inside hermes-w-probe@iso-*: two at once, each must fail to
                                     see, signal or read the other and still use its own folder
    --give DIR NAME JSON             root: write DIR/NAME exclusively, never through a link
    --collect DIR NAME DEST          root: copy DIR/NAME to DEST, never through a link
    --proxy-tricks SOCKET OUT.json   root: route, method and body tricks against the live proxy
    --other-user SOCKET              a user that is neither hermes-w nor root: must be refused
                                     ("no access" = the socket's mode; "refused by peer check" = the
                                     proxy's SO_PEERCRED check, proved with hermes-stranger)
    --combine OUTSIDE SANDBOX HOSTUSER ISO_A ISO_B TRICKS OTHER E2E
                                     print PASS / FAIL / NOT TESTED; exit 1 on any FAIL, or on a
                                     NOT TESTED where the check is always testable

A blocked target counts as PASS only when root reaches it from outside AND
the sandbox can't. If root can't reach it either (nothing listening), it is
"NOT TESTED (no listener)", never a PASS: a refused connection proves
nothing about the firewall. Python stdlib only; MODEL from config.conf.
"""

from __future__ import annotations

import errno
import json
import os
import random
import socket
import stat
import struct
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from hermes_dev2_common import UnixHTTPConnection, load_config  # noqa: E402

# (label, host, port): each must be unreachable from a worker.
TCP_TARGETS = [
    ("OpenBao on the LAN 10.10.10.220:8200", "10.10.10.220", 8200),
    ("loopback 8200", "127.0.0.1", 8200),
    ("loopback 8420", "127.0.0.1", 8420),
    ("loopback 8093", "127.0.0.1", 8093),
    ("loopback 3000", "127.0.0.1", 3000),
    ("loopback 22 (ssh)", "127.0.0.1", 22),
    ("loopback 4322", "127.0.0.1", 4322),
    ("loopback 4323", "127.0.0.1", 4323),
    ("model direct 127.0.0.1:8000", "127.0.0.1", 8000),
    ("LAN 10.10.10.220:22", "10.10.10.220", 22),
    ("LAN 10.10.10.220:8420", "10.10.10.220", 8420),
    ("docker bridge 172.20.0.1:3000", "172.20.0.1", 3000),
    ("tailscale 100.78.45.14:22", "100.78.45.14", 22),
    ("internet 1.1.1.1:443", "1.1.1.1", 443),
]
UDP_DNS_TARGETS = [("DNS over UDP to 1.1.1.1:53", "1.1.1.1"), ("DNS over UDP to 127.0.0.53:53", "127.0.0.53")]
# UDP sends that must fail at once inside the private namespace (no route).
UDP_SEND_TARGETS = [("UDP 10.10.10.220:8200", "10.10.10.220", 8200), ("UDP 10.10.10.220:161", "10.10.10.220", 161),
                    ("UDP 1.1.1.1:443", "1.1.1.1", 443), ("UDP 172.20.0.1:53", "172.20.0.1", 53)]
UNIX_TARGETS = ["/run/dbus/system_bus_socket", "/run/tailscale/tailscaled.sock",
                "/run/systemd/resolve/io.systemd.Resolve", "/run/docker.sock", "/var/run/docker.sock"]
KEY_FILES = ["/etc/hermes-proxy/model.key"]
HOST_FILES = ["/etc/shadow", "/var/log/syslog", "/etc/hermes-proxy/model.key", "/root/.bash_history"]
# SysV message-queue keys the isolation probes create (one each); the peer must not see the other's.
SYSV_KEYS = {"iso-a": 0x48444101, "iso-b": 0x48444102}
IPC_CREAT, IPC_RMID = 0o1000, 0
PEER_WAIT_S = 90
RELEASE_WAIT_S = 90


# --- primitive probes (injectable in tests) --------------------------------

def tcp(host: str, port: int, timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def dns_query(server: str, name: str = "github.com", timeout: float = 2.0) -> bool:
    """True when a UDP DNS answer comes back."""
    qid = random.randrange(65536)
    q = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    q += b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\0" + struct.pack(">HH", 1, 1)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.sendto(q, (server, 53))
            data, _ = s.recvfrom(512)
            return len(data) >= 2 and struct.unpack(">H", data[:2])[0] == qid
    except OSError:
        return False


def udp_send(host: str, port: int) -> str:
    """'sent' | 'blocked <errno name>' for one UDP datagram."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.sendto(b"x", (host, port))
            return "sent"
    except OSError as exc:
        return f"blocked {errno.errorcode.get(exc.errno, exc.errno)}"


def ipv6_socket() -> str:
    """'allowed' if an AF_INET6 socket can be made at all, else 'refused'."""
    try:
        socket.socket(socket.AF_INET6, socket.SOCK_STREAM).close()
        return "allowed"
    except OSError:
        return "refused"


def sysv_queue(key: int, create: bool, libc=None) -> int:
    """msgget(key): the queue id (>= 0), or -1 when it doesn't exist (or can't be made)."""
    import ctypes
    libc = libc or ctypes.CDLL(None, use_errno=True)
    return int(libc.msgget(ctypes.c_int(key), ctypes.c_int((IPC_CREAT | 0o600) if create else 0)))


def sysv_remove(qid: int, libc=None) -> None:
    import ctypes
    libc = libc or ctypes.CDLL(None, use_errno=True)
    libc.msgctl(ctypes.c_int(qid), ctypes.c_int(IPC_RMID), None)


def resolves(name: str) -> bool:
    try:
        socket.getaddrinfo(name, 443)
        return True
    except OSError:
        return False


def unix_connect(path: str) -> str:
    """'connected' | 'no socket support' | 'refused' (missing, no permission, not listening)."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    except OSError as exc:
        return "no socket support" if exc.errno in (errno.EAFNOSUPPORT, errno.EPERM, errno.EACCES) else "refused"
    try:
        s.settimeout(2)
        s.connect(path)
        return "connected"
    except OSError:
        return "refused"
    finally:
        s.close()


def unix_abstract() -> str:
    """Can this process create an AF_UNIX socket at all (path or abstract)?"""
    try:
        socket.socket(socket.AF_UNIX, socket.SOCK_STREAM).close()
        return "allowed"
    except OSError:
        return "refused"


def can_read(path: str) -> bool:
    try:
        with open(path, "rb") as fh:
            fh.read(1)
        return True
    except OSError:
        return False


def interfaces(proc_net_dev: str = "/proc/self/net/dev") -> list[str]:
    try:
        lines = open(proc_net_dev).read().splitlines()[2:]
    except OSError:
        return ["?"]
    return sorted(line.split(":")[0].strip() for line in lines if ":" in line)


def http_json(method: str, url: str, body: dict | None = None, timeout: float = 120) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as exc:
        return exc.code, {}


# --- root-side file moves: never through a link ---------------------------------

def give(dir_path: str, name: str, data: bytes) -> None:
    dfd = os.open(dir_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dfd)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
    finally:
        os.close(dfd)


def take(dir_path: str, name: str, limit: int = 1_000_000) -> bytes | None:
    """A regular file's bytes, never through a link; None if missing, a link or not regular."""
    try:
        dfd = os.open(dir_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
    except OSError:
        os.close(dfd)
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        return os.read(fd, limit)
    finally:
        os.close(fd)
        os.close(dfd)


# --- the probe runs --------------------------------------------------------------

def reach(tcp_=tcp, dns_=dns_query, resolve_=resolves, unix_=unix_connect) -> dict:
    """Reachability of every target from the calling process's network view."""
    return {
        "tcp": {label: tcp_(h, p) for label, h, p in TCP_TARGETS},
        "udp_dns": {label: dns_(server) for label, server in UDP_DNS_TARGETS},
        "github": resolve_("github.com") and tcp_("github.com", 443),
        "unix": {path: unix_(path) == "connected" for path in UNIX_TARGETS},
    }


def inside(config: dict[str, str], tcp_=tcp, dns_=dns_query, resolve_=resolves, unix_=unix_connect,
           abstract_=unix_abstract, read_=can_read, ifaces_=interfaces, http_=http_json,
           udp_=udp_send, ipv6_=ipv6_socket) -> dict:
    out = reach(tcp_, dns_, resolve_, unix_)
    out["dns_lookup"] = resolve_("github.com")
    out["af_unix"] = abstract_()
    out["ipv6"] = ipv6_()
    out["udp_send"] = {label: udp_(h, p) for label, h, p in UDP_SEND_TARGETS}
    out["key_readable"] = {p: read_(p) for p in KEY_FILES}
    out["host_files"] = {p: read_(p) for p in HOST_FILES}
    out["interfaces"] = ifaces_()
    base = config["JOB_PROXY_URL"].rstrip("/")
    try:
        status, models = http_("GET", base + "/models")
        out["models"] = [m.get("id") for m in models.get("data", [])] if status == 200 else f"status {status}"
    except Exception as exc:  # noqa: BLE001
        out["models"] = f"error {exc.__class__.__name__}"
    try:
        status, reply = http_("POST", base + "/chat/completions", {
            "model": config["MODEL"], "max_tokens": 8, "temperature": 0,
            "messages": [{"role": "user", "content": "Reply with the word ok."}]})
        text = (reply.get("choices") or [{}])[0].get("message", {}).get("content")
        out["chat"] = "returns" if status == 200 and isinstance(text, str) else f"status {status}"
    except Exception as exc:  # noqa: BLE001
        out["chat"] = f"error {exc.__class__.__name__}"
    try:
        status, _ = http_("POST", base + "/chat/completions", {"model": "some-other-model", "messages": []})
        out["other_model"] = status
    except Exception as exc:  # noqa: BLE001
        out["other_model"] = f"error {exc.__class__.__name__}"
    return out


def numeric_procs(proc: str = "/proc") -> list[int]:
    try:
        return sorted(int(n) for n in os.listdir(proc) if n.isdigit())
    except OSError:
        return []


def isolation_checks(own: str, own_dir: str, peer: dict, proc: str = "/proc", sysv_=sysv_queue,
                     shm: str = "/dev/shm") -> dict:
    """From inside one probe, try to see, signal and read the other. Each value: True = isolated."""
    pid = int(peer["peer_host_pid"])
    procs = numeric_procs(proc)
    res: dict[str, object] = {"own_procs": procs}
    res["peer pid not in our /proc"] = pid not in procs
    try:
        os.kill(pid, 0)
        res["peer pid can't be signalled"] = False
    except ProcessLookupError:
        res["peer pid can't be signalled"] = True
    except PermissionError:
        res["peer pid can't be signalled"] = False  # it exists here: not isolated
    for what in ("root", "cwd"):
        try:
            os.listdir(f"{proc}/{pid}/{what}")
            res[f"peer /proc/<pid>/{what} unreachable"] = False
        except OSError:
            res[f"peer /proc/<pid>/{what} unreachable"] = True
    for label, path in (("peer folder unreachable", peer["peer_dir"]),
                        ("peer marker file unreachable", os.path.join(peer["peer_dir"], "own.txt")),
                        ("peer /tmp marker unreachable", f"/tmp/iso-marker-{peer['peer']}"),
                        ("peer /dev/shm marker unreachable", f"{shm}/iso-shm-{peer['peer']}"),
                        ("outbox unreachable", "/var/lib/hermes-jobs/outbox"),
                        ("job work area unreachable", "/var/lib/hermes-jobs/work")):
        res[label] = not os.path.exists(path)
    try:
        res["only own probe folder visible"] = os.listdir(os.path.dirname(own_dir)) == [own]
    except OSError:
        res["only own probe folder visible"] = False
    try:
        with open(os.path.join(own_dir, "own-check.txt"), "w") as fh:
            fh.write("ok")
        with open(os.path.join(own_dir, "own-check.txt")) as fh:
            res["own folder usable"] = fh.read() == "ok"
    except OSError:
        res["own folder usable"] = False
    try:
        with open(f"/tmp/iso-marker-{own}") as fh:
            res["own /tmp usable"] = fh.read() == own
    except OSError:
        res["own /tmp usable"] = False
    try:
        with open(f"{shm}/iso-shm-{own}") as fh:
            res["own /dev/shm usable"] = fh.read() == own
    except OSError:
        res["own /dev/shm usable"] = False
    peer_key = SYSV_KEYS.get(str(peer.get("peer")))
    res["peer SysV message queue unreachable"] = peer_key is not None and sysv_(peer_key, False) < 0
    res["own SysV message queue usable"] = sysv_(SYSV_KEYS[own], False) >= 0
    return res


def run_isolation(own: str, own_dir: str) -> dict:
    """iso-a / iso-b inside their units: markers, wait for root's peer.json, check, wait for release."""
    with open(os.path.join(own_dir, "own.txt"), "w") as fh:
        fh.write(own)
    with open(f"/tmp/iso-marker-{own}", "w") as fh:
        fh.write(own)
    with open(f"/dev/shm/iso-shm-{own}", "w") as fh:
        fh.write(own)
    qid = sysv_queue(SYSV_KEYS[own], True)
    with open(os.path.join(own_dir, "ready.json"), "w") as fh:
        json.dump({"inside_pid": os.getpid()}, fh)
    deadline = time.monotonic() + PEER_WAIT_S
    peer = None
    while time.monotonic() < deadline:
        raw = take(own_dir, "peer.json")
        if raw:
            peer = json.loads(raw)
            break
        time.sleep(0.2)
    if peer is None:
        return {"error": "root never sent peer.json"}
    result = isolation_checks(own, own_dir, peer)
    with open(os.path.join(own_dir, "result.json"), "w") as fh:
        json.dump(result, fh)
    deadline = time.monotonic() + RELEASE_WAIT_S  # stay alive until the peer has checked us too
    while time.monotonic() < deadline and not os.path.exists(os.path.join(own_dir, "release")):
        time.sleep(0.2)
    if qid >= 0:
        sysv_remove(qid)
    return result


# --- root: tricks against the live proxy, and a stranger ------------------------

def proxy_tricks(socket_path: str, model: str, request=None) -> dict:
    """Each trick and the status the proxy answered; root has its own slot."""
    def default_request(method, path, body):
        conn = UnixHTTPConnection(socket_path, timeout=30)
        try:
            conn.request(method, path, body=body, headers={"content-type": "application/json"} if body else {})
            resp = conn.getresponse()
            resp.read()
            return resp.status
        finally:
            conn.close()
    request = request or default_request
    msgs = '"messages":[{"role":"user","content":"hi"}]'
    tricks = {
        "query string on /v1/models": ("GET", "/v1/models?x=1", None),
        "double slash //v1/models": ("GET", "//v1/models", None),
        "dot-dot /v1/models/../models": ("GET", "/v1/models/../models", None),
        "DELETE /v1/models": ("DELETE", "/v1/models", None),
        "POST /v1/models": ("POST", "/v1/models", b"{}"),
        "other route /v1/completions": ("POST", "/v1/completions", b"{}"),
        "duplicate model key": ("POST", "/v1/chat/completions",
                                ('{"model":"other","model":"%s",%s}' % (model, msgs)).encode()),
        "model in other case": ("POST", "/v1/chat/completions",
                                ('{"model":"%s",%s}' % (model.upper(), msgs)).encode()),
        "model only nested": ("POST", "/v1/chat/completions", ('{"x":{"model":"%s"},%s}' % (model, msgs)).encode()),
        "JSON with a comment": ("POST", "/v1/chat/completions",
                                ('{"model":"%s",%s /* hi */}' % (model, msgs)).encode()),
        "image_url content part": ("POST", "/v1/chat/completions", (
            '{"model":"%s","messages":[{"role":"user","content":[{"type":"image_url",'
            '"image_url":{"url":"http://10.10.10.220:8200/v1/sys/health"}}]}]}' % model).encode()),
        "tool_calls in a message": ("POST", "/v1/chat/completions", (
            '{"model":"%s","messages":[{"role":"assistant","content":"x","tool_calls":[]}]}' % model).encode()),
        "tool role message": ("POST", "/v1/chat/completions", (
            '{"model":"%s","messages":[{"role":"tool","content":"x"}]}' % model).encode()),
    }
    out = {}
    for label, (method, path, body) in tricks.items():
        try:
            out[label] = request(method, path, body)
        except Exception as exc:  # noqa: BLE001
            out[label] = f"error {exc.__class__.__name__}"
    return out


TRICK_EXPECT = {
    "query string on /v1/models": {404}, "double slash //v1/models": {404}, "dot-dot /v1/models/../models": {404},
    "DELETE /v1/models": {405}, "POST /v1/models": {404}, "other route /v1/completions": {404},
    "duplicate model key": {400}, "model in other case": {403}, "model only nested": {403},
    "JSON with a comment": {400}, "image_url content part": {400}, "tool_calls in a message": {400},
    "tool role message": {400},
}


def other_user(socket_path: str, connect=None) -> str:
    """As a user that is neither hermes-w nor root:
    'no access'              the socket's file mode kept us out (connect failed);
    'refused by peer check'  we connected, and the proxy closed on us (SO_PEERCRED);
    'served <status>'        the proxy answered: NOT isolated."""
    def default_connect():
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(10)
        s.connect(socket_path)
        return s
    try:
        sock = (connect or default_connect)()
    except OSError:
        return "no access"
    try:
        sock.sendall(b"GET /v1/models HTTP/1.0\r\n\r\n")
        data = sock.recv(64)
    except OSError:
        return "refused by peer check"
    finally:
        sock.close()
    if not data:
        return "refused by peer check"
    first = data.split(b"\r\n", 1)[0].split()
    return f"served {first[1].decode(errors='replace') if len(first) > 1 else '?'}"


# --- combine: the verdicts ---------------------------------------------------------

def combine(outside: dict, inner: dict, host_user: dict | None, config: dict[str, str], iso_a: dict | None = None,
            iso_b: dict | None = None, tricks: dict | None = None, other: str | None = None,
            e2e: dict | None = None, stranger: str | None = None) -> list[tuple[str, str, str]]:
    """[(verdict, check, detail)] with verdict PASS | FAIL | NOT TESTED | NOT TESTED (required)."""
    rows = []

    def blocked(label: str, out_ok: bool, in_ok: bool) -> None:
        if in_ok:
            rows.append(("FAIL", f"blocked in sandbox: {label}", "the sandbox reached it"))
        elif not out_ok:
            rows.append(("NOT TESTED", f"blocked in sandbox: {label}", "no listener (root can't reach it either)"))
        else:
            rows.append(("PASS", f"blocked in sandbox: {label}", "reachable outside, blocked inside"))

    for label in outside["tcp"]:
        blocked(label, outside["tcp"][label], inner["tcp"].get(label, True))
    for label in outside["udp_dns"]:
        blocked(label, outside["udp_dns"][label], inner["udp_dns"].get(label, True))
    blocked("github.com:443", outside["github"], inner["github"])
    for path in outside["unix"]:
        blocked(f"unix socket {path}", outside["unix"][path], inner["unix"].get(path, True))
    def required(check: str) -> None:
        rows.append(("NOT TESTED (required)", check, "this check is always testable; it did not run"))

    if not host_user or not host_user.get("tcp"):
        required("nft drops hermes-w on the host network (the host-user probe gave no result)")
    for label in (host_user or {}).get("tcp", {}):
        if host_user["tcp"][label]:
            rows.append(("FAIL", f"nft drops hermes-w on the host: {label}", "hermes-w reached it outside the sandbox"))
        elif outside["tcp"].get(label):
            rows.append(("PASS", f"nft drops hermes-w on the host: {label}", "root reaches it, hermes-w can't"))
        else:
            rows.append(("NOT TESTED", f"nft drops hermes-w on the host: {label}", "no listener"))

    def must(check: str, ok: bool, detail: str) -> None:
        rows.append(("PASS" if ok else "FAIL", check, detail))

    must("sandbox: DNS lookup of github.com fails", not inner["dns_lookup"], "resolves" if inner["dns_lookup"] else "fails")
    must("sandbox: AF_UNIX sockets refused (path and abstract)", inner["af_unix"] == "refused", inner["af_unix"])
    if "ipv6" in inner:
        must("sandbox: IPv6 sockets refused", inner["ipv6"] == "refused", inner["ipv6"])
    else:
        required("sandbox: IPv6 sockets refused")
    if inner.get("udp_send"):
        for label, res in inner["udp_send"].items():
            must(f"sandbox: {label} can't be sent", str(res).startswith("blocked"), str(res))
    else:
        required("sandbox: UDP sends to other ports fail")
    must("sandbox: only a loopback interface", inner["interfaces"] == ["lo"], ",".join(inner["interfaces"]))
    for path, readable in inner["key_readable"].items():
        must(f"sandbox: key not readable {path}", not readable, "readable" if readable else "not readable")
    for path, readable in (inner.get("host_files") or {}).items():
        must(f"sandbox: host file not readable {path}", not readable, "readable" if readable else "not readable")
    must(f"proxy /v1/models lists exactly {config['MODEL']}", inner["models"] == [config["MODEL"]], str(inner["models"]))
    must("proxy chat completion returns", inner["chat"] == "returns", str(inner["chat"]))
    must("proxy refuses any other model (403)", inner["other_model"] == 403, str(inner["other_model"]))

    # Two jobs at once: neither may see, signal or read the other.
    for name, res in (("iso-a", iso_a), ("iso-b", iso_b)):
        if not res:
            required(f"isolation: probe {name} ran alongside its peer")
            continue
        if "error" in res:
            must(f"isolation: probe {name} ran alongside its peer", False, str(res["error"]))
            continue
        for check, ok in res.items():
            if check == "own_procs":
                continue
            must(f"isolation {name}: {check}", ok is True, "isolated" if ok is True else "NOT isolated")
        procs = res.get("own_procs") or []
        must(f"isolation {name}: its /proc shows only its own few processes", 0 < len(procs) <= 16, f"{len(procs)} pids")
    if iso_a and iso_b and "overlapped" in iso_a:
        must("isolation: both probes ran at the same time", iso_a["overlapped"] is True, str(iso_a["overlapped"]))

    if tricks:
        for label, want in TRICK_EXPECT.items():
            got = tricks.get(label)
            must(f"proxy refuses: {label}", got in want, f"status {got}, want {sorted(want)}")
    else:
        required("proxy refuses route, method and body tricks")
    if other is None:
        required("socket mode keeps out a user outside hermes-sock")
    else:
        must("socket mode keeps out a user outside hermes-sock", other in ("no access", "refused by peer check"), other)
    if stranger is None:
        required("proxy peer check refuses hermes-stranger (in hermes-sock, not hermes-w)")
    else:
        must("proxy peer check refuses hermes-stranger (in hermes-sock, not hermes-w)",
             stranger == "refused by peer check", stranger)

    if not e2e:
        required("end to end: a real submit through dispatch")
    elif e2e.get("skipped"):
        # Never a pass: workers must not start until a real job has gone through once.
        rows.append(("FAIL", "end to end: a real submit through dispatch", "end-to-end not run: " + e2e["skipped"]))
    else:
        must("end to end: dispatch submit answers ok", e2e.get("submit") == "ok", str(e2e.get("submit")))
        must("end to end: the job finishes with exit 0", e2e.get("status") == "done 0", str(e2e.get("status")))
        must("end to end: fetch returns Hermes output", bool(e2e.get("fetched_bytes")), f"{e2e.get('fetched_bytes')} bytes")
    return rows


def exit_code(rows: list[tuple[str, str, str]]) -> int:
    return 1 if any(v in ("FAIL", "NOT TESTED (required)") for v, _, _ in rows) else 0


def _load(path: str):
    with open(path) as fh:
        text = fh.read().strip()
    return json.loads(text) if text else None


def main(argv: list[str]) -> int:
    config = load_config()
    if len(argv) == 3 and argv[1] in ("--outside", "--host-user"):
        with open(argv[2], "w") as fh:
            json.dump(reach(), fh)
        return 0
    if len(argv) == 4 and argv[1] == "--probe":
        name, own_dir = argv[2], argv[3]
        if name == "sandbox":
            result = inside(config)
        elif name in ("iso-a", "iso-b"):
            result = run_isolation(name, own_dir)
        else:
            return 2
        with open(os.path.join(own_dir, "inside.json"), "w") as fh:
            json.dump(result, fh)
        return 0
    if len(argv) == 5 and argv[1] == "--give":
        give(argv[2], argv[3], argv[4].encode())
        return 0
    if len(argv) == 5 and argv[1] == "--collect":
        data = take(argv[2], argv[3])
        with open(argv[4], "wb") as fh:
            fh.write(data or b"")
        return 0 if data else 1
    if len(argv) == 4 and argv[1] == "--proxy-tricks":
        with open(argv[3], "w") as fh:
            json.dump(proxy_tricks(argv[2], config["MODEL"]), fh)
        return 0
    if len(argv) == 3 and argv[1] == "--other-user":
        print(other_user(argv[2]))
        return 0
    if len(argv) == 10 and argv[1] == "--combine":
        outside_, sandbox, host_user, iso_a, iso_b, tricks, other, e2e = (_load(p) for p in argv[2:10])
        rows = combine(outside_, sandbox, host_user, config, iso_a, iso_b, tricks,
                       other.get("other") if isinstance(other, dict) else None, e2e,
                       other.get("stranger") if isinstance(other, dict) else None)
        for verdict, check, detail in rows:
            print(f"{verdict:<21} {check} ({detail})")
        return exit_code(rows)
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
