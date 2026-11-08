"""Shared, OS-free helpers for the Hermes-on-dev2 tools (decision #384).

Everything here is pure or takes its inputs as arguments, so the Mac tests
run it without dev2.
"""

from __future__ import annotations

import http.client
import json
import re
import socket
from pathlib import Path

CONFIG_PATH = Path("/etc/hermes-dev2/config.conf")
PROXY_CONF_PATH = Path("/etc/hermes-dev2/proxy.conf")
# Job ids: "j-" plus 8-62 lowercase letters/digits. "preflight"/"probe" can
# never match, so they can't collide with the pre-flight's own folder.
JOB_ID = re.compile(r"^j-[a-z0-9]{8,62}$")
GIB = 1024**3


def parse_config(text: str) -> dict[str, str]:
    """KEY=VALUE lines; `#` comments and blank lines skipped; no shell syntax."""
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key.strip()):
            raise ValueError(f"bad config line: {raw!r}")
        out[key.strip()] = value.strip()
    return out


def load_config(path: Path = CONFIG_PATH) -> dict[str, str]:
    return parse_config(path.read_text())


def valid_job_id(job_id: str) -> bool:
    return bool(JOB_ID.fullmatch(job_id))


def in_window(hour: int, start: int, end: int) -> bool:
    """True when `hour` is inside [start, end) on a 24 h clock, wrapping midnight."""
    if start == end:
        return True
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


# --- JSON with no duplicate keys ---------------------------------------------

def _no_duplicates(pairs: list[tuple[str, object]]) -> dict:
    out: dict = {}
    for key, value in pairs:
        if key in out:
            raise ValueError(f"duplicate key {key!r}")
        out[key] = value
    return out


def loads_strict(raw: bytes | str):
    """json.loads that refuses a duplicate key at ANY level (ValueError).

    A body like {"model": "x", "model": "MODEL"} would read as MODEL in
    Python (last wins) and as "x" in a server that keeps the first one.
    """
    return json.loads(raw, object_pairs_hook=_no_duplicates)


# --- mounts ---------------------------------------------------------------------

def mount_fstype(mountinfo: str, path: str) -> str | None:
    """The filesystem type mounted exactly AT `path` (last match wins), from /proc/self/mountinfo text."""
    found = None
    for line in mountinfo.splitlines():
        left, sep, right = line.partition(" - ")
        fields = left.split()
        if sep and len(fields) >= 5 and fields[4].replace("\\040", " ") == path:
            found = right.split()[0]
    return found


# --- /proc/net/tcp: who owns a TCP socket ------------------------------------

def _hex_addr(host: str, port: int) -> str:
    """127.0.0.1:8000 -> '0100007F:1F40' (the /proc/net/tcp little-endian form)."""
    packed = socket.inet_aton(host)
    return "".join(f"{b:02X}" for b in reversed(packed)) + f":{port:04X}"


def tcp_socket_uids(proc_net_tcp: str, local: tuple[str, int], remote: tuple[str, int] | None,
                    state: str) -> list[int]:
    """uids of /proc/net/tcp rows matching local (and remote) address and state.

    state: '0A' = LISTEN, '01' = ESTABLISHED. Column 7 is the owning uid.
    """
    want_local = _hex_addr(*local)
    want_remote = _hex_addr(*remote) if remote else None
    uids = []
    for line in proc_net_tcp.splitlines()[1:]:
        cols = line.split()
        if len(cols) < 8:
            continue
        if cols[1] == want_local and cols[3] == state and (want_remote is None or cols[2] == want_remote):
            uids.append(int(cols[7]))
    return uids


def listeners(proc_net_tcp: str, proc_net_tcp6: str, port: int) -> list[tuple[str, int]]:
    """(address, uid) of every LISTEN socket on `port`, IPv4 and IPv6.

    Addresses come back as '127.0.0.1', '0.0.0.0', '::', '::1' or the raw hex
    for anything else, so a caller can refuse a wildcard bind.
    """
    out = []
    for text, v6 in ((proc_net_tcp, False), (proc_net_tcp6, True)):
        for line in text.splitlines()[1:]:
            cols = line.split()
            if len(cols) < 8 or cols[3] != "0A":
                continue
            addr, _, hexport = cols[1].partition(":")
            if int(hexport, 16) != port:
                continue
            if not v6:
                name = socket.inet_ntoa(bytes(reversed(bytes.fromhex(addr))))
            else:
                raw = bytes.fromhex(addr)
                name = socket.inet_ntop(socket.AF_INET6, b"".join(raw[i:i + 4][::-1] for i in range(0, 16, 4)))
            out.append((name, int(cols[7])))
    return out


def upstream_bind_problem(binds: list[tuple[str, int]], host: str) -> str | None:
    """None when the model listens ONLY on `host`; else a plain reason to refuse."""
    if not binds:
        return f"nothing listens on {host}"
    wild = [a for a, _ in binds if a in ("0.0.0.0", "::")]
    if wild:
        return (f"the model server listens on {', '.join(sorted(set(wild)))} (every address), not only {host}; "
                f"bind it to {host} so other machines can't reach it")
    others = sorted({a for a, _ in binds if a != host})
    if others:
        return f"the model server also listens on {', '.join(others)}; expected only {host}"
    if len({u for _, u in binds}) != 1:
        return "more than one user listens on that port"
    return None


# --- firewall check ------------------------------------------------------------

def firewall_ok(nft_chain_listing: str, worker_uid: int) -> bool:
    """True when `nft list chain inet hermes_w output` holds the worker drop and no accept.

    nft may print the uid by name or number, with or without quotes.
    """
    who = rf'(?:"?hermes-w"?|{worker_uid})'
    has_drop = re.search(rf"meta skuid {who} counter packets \d+ bytes \d+ drop\b", nft_chain_listing)
    has_accept = re.search(rf"meta skuid {who}\b[^\n]*\baccept\b", nft_chain_listing)
    return bool(has_drop) and not has_accept


def drop_counter(nft_chain_listing: str, worker_uid: int) -> int | None:
    """Packets counted by the worker drop rule, or None when the rule is missing."""
    who = rf'(?:"?hermes-w"?|{worker_uid})'
    m = re.search(rf"meta skuid {who} counter packets (\d+) bytes \d+ drop\b", nft_chain_listing)
    return int(m.group(1)) if m else None


# --- HTTP over the proxy's Unix socket (root tools: watchdog, pre-flight) -----

class UnixHTTPConnection(http.client.HTTPConnection):
    """http.client over an AF_UNIX stream socket."""

    def __init__(self, path: str, timeout: float = 120):
        super().__init__("localhost", timeout=timeout)
        self.unix_path = path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.unix_path)
        self.sock = sock


def unix_json(path: str, method: str, url_path: str, body: dict | None = None, timeout: float = 120) -> dict:
    conn = UnixHTTPConnection(path, timeout=timeout)
    try:
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method, url_path, body=data, headers={"content-type": "application/json"} if data else {})
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status != 200:
            raise OSError(f"proxy answered {resp.status}")
        return json.loads(raw)
    finally:
        conn.close()


# --- the installed dispatch carries no test hook -------------------------------

HOOK_START = "# >>> test-hook (setup-dev2.sh strips these lines from the installed copy)"
HOOK_END = "# <<< test-hook"


def strip_test_hook(source: str) -> str:
    """dispatch.py's source with its one marked test-hook block removed.

    Raises ValueError unless there is exactly one well-formed block, and if
    anything naming the test root survives (so the installed copy can never
    honour it, whatever its environment).
    """
    lines = source.splitlines(keepends=True)
    starts = [i for i, ln in enumerate(lines) if ln.strip() == HOOK_START]
    ends = [i for i, ln in enumerate(lines) if ln.strip() == HOOK_END]
    if len(starts) != 1 or len(ends) != 1 or ends[0] <= starts[0]:
        raise ValueError("dispatch.py must hold exactly one test-hook block")
    out = "".join(lines[:starts[0]] + lines[ends[0] + 1:])
    if "HERMES_DEV2_TEST_ROOT" in out:
        raise ValueError("the test root is still named outside the test-hook block")
    compile(out, "dispatch", "exec")
    return out


if __name__ == "__main__":
    import sys as _sys
    if len(_sys.argv) == 3 and _sys.argv[1] == "--strip-test-hook":
        with open(_sys.argv[2]) as _fh:
            _sys.stdout.write(strip_test_hook(_fh.read()))
        _sys.exit(0)
    print("usage: hermes_dev2_common.py --strip-test-hook dispatch.py", file=_sys.stderr)
    _sys.exit(2)
