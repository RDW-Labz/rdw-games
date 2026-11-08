#!/usr/bin/env python3
"""Drive the browser the human is actually signed into, over CDP (default Brave :9224).

`browser_exec` talks to its own daemon, which has no session anywhere. The desktop Brave does, so
filing has to happen there. This is a three-function CDP client: list targets, open a tab, evaluate JS.

  python3 engine/cdp_tab.py list
  python3 engine/cdp_tab.py eval https://hackerone.com/notifications "document.title"
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request

from websockets.sync.client import connect

# The port used to be the constant 9224, and the desktop browser has not listened there for days — it is on
# 9226. Every probe built on this module (`bc_session check`, `bc_web`, `h1_file`, `h1_comment`) was therefore
# failing to connect and reporting the failure in the shape of a *signed-out account*, which is the one
# false negative that stops all web filing. Ask which port is actually serving /json/version instead.
import os

CANDIDATE_PORTS = (9226, 9222, 9224)
_live_port: int | None = None


def port() -> int:
    global _live_port
    if _live_port is not None:
        return _live_port
    env = os.environ.get("CDP_PORT")
    if env:
        _live_port = int(env)
        return _live_port
    for p in CANDIDATE_PORTS:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{p}/json/version", timeout=1).read()
            _live_port = p
            return p
        except Exception:
            continue
    _live_port = CANDIDATE_PORTS[0]
    return _live_port


PORT = port()


def _http(path: str, method: str = "GET") -> dict | list:
    req = urllib.request.Request(f"http://127.0.0.1:{port()}{path}", method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read().decode()
    return json.loads(body) if body.strip() else {}


def targets(only_pages: bool = True) -> list[dict]:
    out = _http("/json/list")
    return [t for t in out if not only_pages or t.get("type") == "page"]


def open_tab(url: str) -> dict:
    return _http(f"/json/new?{urllib.parse.quote(url, safe='')}", method="PUT")


def close_tab(tid: str) -> None:
    try:
        _http(f"/json/close/{tid}")
    except Exception:
        pass


class Tab:
    def __init__(self, url: str | None = None, reuse: str | None = None) -> None:
        if url is None:
            raise SystemExit("need a url")
        self.info = open_tab(url)
        self.ws = connect(self.info["webSocketDebuggerUrl"], max_size=None, open_timeout=20)
        self._n = 0

    def send(self, method: str, **params):
        self._n += 1
        mid = self._n
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def ev(self, expr: str, await_promise: bool = False):
        r = self.send("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=await_promise, userGesture=True)
        return r.get("result", {}).get("value")

    def goto(self, url: str, wait: float = 3.0) -> None:
        self.send("Page.navigate", url=url)
        time.sleep(wait)

    def ready(self) -> str:
        return self.ev("document.readyState") or ""

    def close(self) -> None:
        try:
            self.ws.close()
        finally:
            close_tab(self.info["id"])


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        for t in targets():
            print(t["id"][:8], t.get("title", "")[:40], "|", t.get("url", "")[:90])
    elif cmd == "eval":
        url, expr = sys.argv[2], sys.argv[3]
        tab = Tab(url)
        try:
            time.sleep(2)
            print(json.dumps(tab.ev(expr), indent=1)[:2000])
        finally:
            tab.close()


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (used by open_tab)
    main()
