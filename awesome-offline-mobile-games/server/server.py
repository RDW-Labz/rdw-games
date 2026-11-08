#!/usr/bin/env python3
"""Local library server for Awesome Offline Mobile Games.

Why it exists: the collection is static, but two things need a process —
(a) serving the shell to a phone over the LAN without an internet connection,
(b) a place to land exported save slots so progress can hop between devices.

Design rules (mirrors docs/SCOPE-GATE.md):
  * Binds 127.0.0.1 by default; --lan opts in to 0.0.0.0 for phone testing.
  * Reads the repo; never writes anywhere except server/saves/.
  * No outbound requests, no third-party packages, stdlib only.
  * Sends no-store on API routes so a stale catalog can't hide a new game.

Run:  python3 server/server.py [--port 8787] [--lan]
API:  GET /api/health, /api/catalog, /api/saves, /api/saves/<id>
      PUT /api/saves/<id>   (JSON body, <= 2 MiB)
      DELETE /api/saves/<id>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
SAVES = ROOT / "server" / "saves"
CATALOG = ROOT / "catalog" / "games.json"
VERSION = "1.0.0"
MAX_SAVE = 2 * 1024 * 1024
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,48}$")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
}


def catalog_bytes() -> bytes:
    return CATALOG.read_bytes()


def catalog_etag() -> str:
    return '"' + hashlib.sha256(catalog_bytes()).hexdigest()[:16] + '"'


class Handler(BaseHTTPRequestHandler):
    server_version = "AOMG/" + VERSION
    protocol_version = "HTTP/1.1"

    # ---------- helpers ----------
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj: dict, extra: dict | None = None) -> None:
        hdrs = {"Cache-Control": "no-store"}
        hdrs.update(extra or {})
        self._send(code, json.dumps(obj, indent=1).encode(), MIME[".json"], hdrs)

    def _err(self, code: int, msg: str) -> None:
        self._json(code, {"error": msg, "status": code})

    def log_message(self, fmt: str, *args) -> None:  # quieter, single-line
        sys.stderr.write("%s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _resolve(self, url_path: str) -> Path | None:
        rel = unquote(url_path).lstrip("/")
        if not rel:
            rel = "shell/index.html"
        target = (ROOT / rel).resolve()
        try:
            target.relative_to(ROOT)
        except ValueError:
            return None
        if target.is_dir():
            target = target / "index.html"
        return target if target.is_file() else None

    # ---------- verbs ----------
    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        path = urlparse(self.path).path

        if path == "/api/health":
            return self._json(HTTPStatus.OK, {
                "ok": True, "service": "aomg-library", "version": VERSION,
                "games": len(json.loads(catalog_bytes())["games"]),
                "saves": len(list(SAVES.glob("*.json"))) if SAVES.exists() else 0,
                "root": str(ROOT),
            })

        if path == "/api/catalog":
            etag = catalog_etag()
            if self.headers.get("If-None-Match") == etag:
                self.send_response(HTTPStatus.NOT_MODIFIED)
                self.send_header("ETag", etag)
                self.end_headers()
                return
            return self._send(HTTPStatus.OK, catalog_bytes(), MIME[".json"],
                              {"Cache-Control": "no-store", "ETag": etag})

        if path == "/api/saves":
            items = []
            if SAVES.exists():
                for f in sorted(SAVES.glob("*.json")):
                    st = f.stat()
                    items.append({"id": f.stem, "bytes": st.st_size,
                                  "modified": int(st.st_mtime)})
            return self._json(HTTPStatus.OK, {"saves": items})

        m = re.match(r"^/api/saves/([^/]+)$", path)
        if m:
            gid = m.group(1)
            if not SAFE_ID.match(gid):
                return self._err(HTTPStatus.BAD_REQUEST, "bad game id")
            f = SAVES / (gid + ".json")
            if not f.exists():
                return self._err(HTTPStatus.NOT_FOUND, "no save for " + gid)
            return self._send(HTTPStatus.OK, f.read_bytes(), MIME[".json"],
                              {"Cache-Control": "no-store"})

        if path == "/":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/shell/index.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        target = self._resolve(path)
        if target is None:
            return self._err(HTTPStatus.NOT_FOUND, "not found: " + path)
        body = target.read_bytes()
        ctype = MIME.get(target.suffix.lower(), "application/octet-stream")
        return self._send(HTTPStatus.OK, body, ctype, {
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
        })

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        m = re.match(r"^/api/saves/([^/]+)$", path)
        if not m:
            return self._err(HTTPStatus.NOT_FOUND, "unknown endpoint")
        gid = m.group(1)
        if not SAFE_ID.match(gid):
            return self._err(HTTPStatus.BAD_REQUEST, "bad game id")
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_SAVE:
            return self._err(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "save must be 1..2MiB")
        raw = self.rfile.read(length)
        try:
            json.loads(raw)
        except json.JSONDecodeError:
            return self._err(HTTPStatus.BAD_REQUEST, "body must be JSON")
        SAVES.mkdir(parents=True, exist_ok=True)
        (SAVES / (gid + ".json")).write_bytes(raw)
        return self._json(HTTPStatus.OK, {"stored": gid, "bytes": len(raw)})

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        m = re.match(r"^/api/saves/([^/]+)$", path)
        if not m:
            return self._err(HTTPStatus.NOT_FOUND, "unknown endpoint")
        gid = m.group(1)
        if not SAFE_ID.match(gid):
            return self._err(HTTPStatus.BAD_REQUEST, "bad game id")
        f = SAVES / (gid + ".json")
        if not f.exists():
            return self._err(HTTPStatus.NOT_FOUND, "no save for " + gid)
        f.unlink()
        return self._json(HTTPStatus.OK, {"deleted": gid})


def main() -> int:
    ap = argparse.ArgumentParser(description="Serve the AOMG collection offline")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--lan", action="store_true",
                    help="bind 0.0.0.0 so a phone on the same network can load it")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not CATALOG.exists():
        print("catalog/games.json missing", file=sys.stderr)
        return 1
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    httpd = ThreadingHTTPServer((host, args.port), Handler)
    httpd.daemon_threads = True
    shown = "127.0.0.1" if host == "0.0.0.0" else host
    n = len(json.loads(catalog_bytes())["games"])
    print(f"aomg-library {VERSION} — {n} games")
    print(f"  shell : http://{shown}:{args.port}/shell/index.html")
    print(f"  api   : http://{shown}:{args.port}/api/catalog")
    if args.lan:
        print("  LAN   : bound to 0.0.0.0 — reachable from your phone on this network")
    print("  ctrl-c to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
