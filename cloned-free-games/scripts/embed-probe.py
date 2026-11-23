#!/usr/bin/env python3
"""embed-probe.py — prove which external game pages can be iframed AND play.

The library audit (scripts/library-audit.py) will only show a third-party URL as a
tile if that exact URL appears in .queue/embed-verified.json (written here). Before
this script existed the file had no writer, so every "links-out" card was quarantined
by construction — including real browser builds (Mindustry web, shapez.io, TPT).

What a pass means (both are required):

  1. FRAMABLE — the site does not forbid being framed (no X-Frame-Options DENY/SAMEORIGIN,
     no CSP frame-ancestors list that excludes us) and the iframe actually COMMITS when
     loaded inside a harness page served from a normal http origin.
  2. PLAYABLE — the framed document is a live game surface, not an error page or a
     marketing landing: it paints a canvas or a WebGL context, or renders a substantial
     interactive document, and does not immediately bounce out of frame.

Implementation: headless Chromium over raw CDP (stdlib only — no npm/pip deps), launched
with --site-per-process so every cross-origin iframe is an out-of-process frame we can
attach to (Target.setAutoAttach flatten) and evaluate inside. Header checks come from a
plain HTTP GET, which is what decides framing before any pixels are drawn.

usage:
  scripts/embed-probe.py                      # probe every links-out card in the audit
  scripts/embed-probe.py --limit 10           # smoke test
  scripts/embed-probe.py --only https://get.shapez.io
  scripts/embed-probe.py --workers 4 --out .queue/embed-verified.json

output: .queue/embed-verified.json
  {"generated": iso, "verified": [urls], "results": [{url,name,framable,playable,verdict,...}]}
  .queue/embed-probe.log  one line per URL (same data, greppable)
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/131.0.0.0 Safari/537.36")
SRC = os.path.expanduser("~/cloned-free-games")


# ---------------------------------------------------------------- minimal CDP client
class WS:
    """Bare-bones RFC6455 text-frame client: enough for CDP, no dependencies."""

    def __init__(self, url: str, timeout: float = 30.0):
        u = urllib.parse.urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path + (("?" + u.query) if u.query else "")
        req = (f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\n"
               "Upgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("websocket handshake closed")
            buf += chunk
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        if b"101" not in head.split(b"\r\n")[0]:
            raise RuntimeError("websocket handshake failed: " + head.split(b"\r\n")[0].decode(errors="replace"))
        self.lock = threading.Lock()

    def send(self, text: str) -> None:
        data = text.encode()
        hdr = bytearray([0x81])
        n = len(data)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack(">Q", n)
        mask = os.urandom(4)
        hdr += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        with self.lock:
            self.sock.sendall(bytes(hdr) + masked)

    def _read(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("websocket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self) -> str:
        while True:
            b0, b1 = self._read(2)
            opcode = b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(n)
            if opcode == 0x8:
                raise RuntimeError("websocket closed by peer")
            if opcode in (0x9, 0xA):
                continue
            if opcode in (0x1, 0x2, 0x0):
                return payload.decode("utf-8", "replace")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class CDP:
    def __init__(self, ws_url: str):
        self.ws = WS(ws_url, timeout=60)
        self.id = 0
        self.pending: dict[int, dict] = {}
        self.events: list[dict] = []
        self.alive = True
        self.t = threading.Thread(target=self._pump, daemon=True)
        self.t.start()

    def _pump(self):
        while self.alive:
            try:
                msg = json.loads(self.ws.recv())
            except Exception:
                return
            if "id" in msg and msg["id"] in self.pending:
                self.pending.pop(msg["id"]).update(msg)
            else:
                self.events.append(msg)

    def call(self, method: str, params: dict | None = None, timeout: float = 45.0) -> dict:
        self.id += 1
        i = self.id
        slot: dict = {}
        self.pending[i] = slot
        self.ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
        end = time.time() + timeout
        while time.time() < end:
            if "result" in slot or "error" in slot:
                self.pending.pop(i, None)
                if "error" in slot:
                    raise RuntimeError(f"{method}: {slot['error'].get('message')}")
                return slot["result"]
            time.sleep(0.01)
        self.pending.pop(i, None)
        raise TimeoutError(method)

    def drain(self) -> list[dict]:
        out, self.events = self.events, []
        return out


# ---------------------------------------------------------------- harness server
HARNESS = """<!doctype html><html><head><meta charset="utf-8"><title>frame probe</title>
<style>html,body{margin:0;background:#111}iframe{width:1280px;height:760px;border:0;display:block}</style>
</head><body><iframe id="f" src="__URL__" referrerpolicy="no-referrer-when-downgrade"
 allow="autoplay; fullscreen; gamepad; clipboard-write"
 sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-pointer-lock allow-orientation-lock"></iframe></body></html>"""


class Harness(BaseHTTPRequestHandler):
    """Serves /f?u=<urlencoded target>. The target travels in the path so parallel
    probes never share state (a module-level target raced and cross-fed workers)."""

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        target = (q.get("u") or ["about:blank"])[0]
        body = HARNESS.replace("__URL__", target).encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def start_harness() -> tuple[ThreadingHTTPServer, int]:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Harness)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


# ---------------------------------------------------------------- header check
CS_ATTR = re.compile(r"^\s*frame-ancestors\s+(.+)$", re.I | re.M)


def header_verdict(url: str) -> dict:
    """Framing decision from the real response headers (this is what browsers enforce)."""
    out = {"status": None, "xfo": "", "csp": "", "framable_by_header": True, "why": ""}
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            out["status"] = r.status
            out["final_url"] = r.geturl()
            hdrs = {k.lower(): v for k, v in r.headers.items()}
    except urllib.error.HTTPError as e:
        out["status"] = e.code
        hdrs = {k.lower(): v for k, v in (e.headers or {}).items()}
    except Exception as e:
        out["status"] = 0
        out["framable_by_header"] = False
        out["why"] = f"unreachable: {type(e).__name__}"
        return out
    out["xfo"] = hdrs.get("x-frame-options", "")
    out["csp"] = hdrs.get("content-security-policy", "")
    x = out["xfo"].lower()
    if "deny" in x or "sameorigin" in x:
        out["framable_by_header"] = False
        out["why"] = f"x-frame-options: {out['xfo']}"
    m = CS_ATTR.search(out["csp"]) if out["csp"] else None
    if m:
        val = m.group(1).strip().lower()
        if "'none'" in val:
            out["framable_by_header"] = False
            out["why"] = f"frame-ancestors {val}"
        elif "'self'" in val and "127.0.0.1" not in val and "localhost" not in val:
            out["framable_by_header"] = False
            out["why"] = f"frame-ancestors {val}"
    if out["status"] and out["status"] >= 400:
        out["framable_by_header"] = False
        out["why"] = out["why"] or f"http {out['status']}"
    return out


PROBE_JS = r"""(() => {
  const d = document;
  const canvases = [...d.querySelectorAll('canvas')];
  let liveCanvas = 0;
  for (const c of canvases) {
    if (c.width >= 200 && c.height >= 120) liveCanvas++;
  }
  let webgl = 0;
  try {
    webgl = canvases.filter(c => c.getContext('webgl2') || c.getContext('webgl')).length;
  } catch (e) {}
  const txt = (d.body ? d.body.innerText : '').replace(/\s+/g, ' ').trim();
  return {
    title: d.title || '',
    url: location.href,
    ready: d.readyState,
    canvases: canvases.length,
    liveCanvas, webgl,
    textLen: txt.length,
    textHead: txt.slice(0, 160),
    hasErrors: !!d.querySelector('#main-frame-error, .neterror'),
  };
})()"""


# ---------------------------------------------------------------- browser probe
class Browser:
    def __init__(self, port: int | None = None):
        binp = next((p for p in ("/usr/bin/chromium", "/usr/bin/chromium-browser",
                                 "/usr/bin/google-chrome") if os.path.exists(p)), None)
        if not binp:
            raise SystemExit("no chromium binary found")
        self.profile = tempfile.mkdtemp(prefix="embedprobe-")
        args = [binp, "--headless=new", "--remote-debugging-port=0", "--no-sandbox",
                "--disable-gpu", "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
                "--mute-audio", "--disable-dev-shm-usage", "--no-first-run",
                "--site-per-process", "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding", "--window-size=1280,800",
                f"--user-data-dir={self.profile}", "about:blank"]
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                     env={**os.environ, "TMPDIR": tempfile.gettempdir()})
        err = b""
        ws_url = None
        end = time.time() + 40
        while time.time() < end:
            line = self.proc.stderr.readline()
            if not line:
                continue
            err += line
            m = re.search(rb"DevTools listening on (ws://\S+)", err)
            if m:
                ws_url = m.group(1).decode()
                break
        if not ws_url:
            raise SystemExit("chromium devtools not up: " + err.decode(errors="replace")[-400:])
        self.cdp = CDP(ws_url)

    def close(self):
        try:
            self.cdp.alive = False
            self.proc.kill()
        finally:
            self.cdp.ws.close()
            shutil.rmtree(self.profile, ignore_errors=True)

    def new_page(self) -> str:
        t = self.cdp.call("Target.createTarget", {"url": "about:blank"})
        return t["targetId"]

    def close_page(self, tid: str):
        try:
            self.cdp.call("Target.closeTarget", {"targetId": tid}, timeout=10)
        except Exception:
            pass

    def probe(self, url: str, wait: float = 9.0) -> dict:
        """Load `url` twice: top-level (is it a game surface?) and inside the harness
        iframe (does it actually frame?) and report both."""
        tid = self.new_page()
        res: dict = {"url": url}
        try:
            s = self.cdp.call("Target.attachToTarget", {"targetId": tid, "flatten": True})["sessionId"]

            def send(method, params=None, timeout=45):
                self.cdp.id += 1
                i = self.cdp.id
                slot = {}
                self.cdp.pending[i] = slot
                self.cdp.ws.send(json.dumps({"id": i, "method": method,
                                             "params": params or {}, "sessionId": s}))
                end = time.time() + timeout
                while time.time() < end:
                    if "result" in slot or "error" in slot:
                        self.cdp.pending.pop(i, None)
                        if "error" in slot:
                            raise RuntimeError(method + ": " + str(slot["error"].get("message")))
                        return slot["result"]
                    time.sleep(0.01)
                raise TimeoutError(method)

            send("Page.enable"); send("Runtime.enable"); send("Network.enable")
            send("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": False,
                                          "flatten": True})

            # --- 1. top-level load: is the page itself a running game?
            send("Page.navigate", {"url": url})
            time.sleep(wait)
            top = send("Runtime.evaluate", {"expression": PROBE_JS, "returnByValue": True,
                                            "awaitPromise": True})
            res["top"] = top.get("result", {}).get("value") or {}

            # --- 2. framed load through the local harness (target in the query string)
            self.cdp.drain()
            host = urllib.parse.urlparse(url).netloc.lower()
            harness = (f"http://127.0.0.1:{self.harness_port}/f?u="
                       + urllib.parse.quote(url, safe=""))
            send("Page.navigate", {"url": harness})
            time.sleep(wait)
            # the OOPIF our harness spawned: match on the target host, never on "any iframe"
            frame_targets = [t for t in self.cdp.call("Target.getTargets")["targetInfos"]
                             if t.get("type") == "iframe"]
            match = None
            for t in frame_targets:
                th = urllib.parse.urlparse(t.get("url", "")).netloc.lower()
                if th and (th == host or th.endswith("." + host) or host.endswith("." + th)):
                    match = t
            res["frame_target"] = match["url"] if match else ""
            res["frame_candidates"] = [t.get("url", "")[:80] for t in frame_targets][:4]
            if match:
                fs = self.cdp.call("Target.attachToTarget",
                                   {"targetId": match["targetId"], "flatten": True})["sessionId"]

                def fsend(method, params=None, timeout=30):
                    self.cdp.id += 1
                    i = self.cdp.id
                    slot = {}
                    self.cdp.pending[i] = slot
                    self.cdp.ws.send(json.dumps({"id": i, "method": method,
                                                 "params": params or {}, "sessionId": fs}))
                    end = time.time() + timeout
                    while time.time() < end:
                        if "result" in slot or "error" in slot:
                            self.cdp.pending.pop(i, None)
                            if "error" in slot:
                                raise RuntimeError(method + ": " + str(slot["error"].get("message")))
                            return slot["result"]
                        time.sleep(0.01)
                    raise TimeoutError(method)

                fsend("Runtime.enable")
                time.sleep(1.5)
                fr = fsend("Runtime.evaluate", {"expression": PROBE_JS, "returnByValue": True})
                res["frame"] = fr.get("result", {}).get("value") or {}
        except Exception as e:
            res["error"] = f"{type(e).__name__}: {e}"
        finally:
            self.close_page(tid)
        return res


def judge(h: dict, r: dict) -> tuple[bool, bool, list[str]]:
    """(framable, playable, notes)."""
    notes: list[str] = []
    top = r.get("top") or {}
    fr = r.get("frame") or {}
    framable = bool(h.get("framable_by_header"))
    if not framable:
        notes.append(h.get("why") or "header blocks framing")
    if r.get("frame_target"):
        notes.append(f"iframe target {r['frame_target'][:60]}")
    else:
        framable = False
        notes.append("no iframe target attached under --site-per-process")
    if fr.get("hasErrors"):
        framable = False
        notes.append("frame showed a network error page")
    if not fr and framable:
        framable = False
        notes.append("frame never came up")
    # A game surface is a canvas / WebGL context — prose alone is a landing page, and
    # promoting a homepage as a playable tile is exactly the failure this gate exists for.
    playable = bool(top.get("liveCanvas") or top.get("webgl"))
    if not playable:
        notes.append(f"top-level not a game surface (canvas={top.get('canvases')} "
                     f"text={top.get('textLen')})")
    if fr and framable:
        if not (fr.get("liveCanvas") or fr.get("webgl") or playable):
            notes.append(f"frame has no game surface (canvas={fr.get('canvases')} "
                         f"text={fr.get('textLen')})")
            playable = False
    if r.get("error"):
        notes.append(r["error"])
    return framable, playable, notes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default=SRC)
    ap.add_argument("--audit", default=None, help="library-audit.json (default <src>/.queue/)")
    ap.add_argument("--out", default=None, help="default <src>/.queue/embed-verified.json")
    ap.add_argument("--only", nargs="*", default=None, help="probe these URLs instead of the audit set")
    ap.add_argument("--include", nargs="*", default=[], action="append",
                    help="extra URL(s) to probe on top of the audit set (repeatable)")
    ap.add_argument("--review", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                     "..", ".queue", "embed-review.json"),
                    help="visual-confirmation file: {url: {confirmed: bool, note: str}}. "
                         "The canvas heuristic cannot tell a game from a landing page with an "
                         "animated hero canvas; a confirmed verdict needs both gates.")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--wait", type=float, default=9.0)
    args = ap.parse_args()

    src = os.path.abspath(os.path.expanduser(args.src))
    audit_p = args.audit or os.path.join(src, ".queue", "library-audit.json")
    out_p = args.out or os.path.join(src, ".queue", "embed-verified.json")

    cands: list[tuple[str, str]] = []
    if args.only:
        cands = [(u, "") for u in args.only]
    else:
        data = json.load(open(audit_p, encoding="utf-8"))
        for r in data.get("entries_quarantine", []):
            if r.get("failure_mode") == "links-out" and (r.get("launch") or "").startswith("http"):
                cands.append((r["launch"], r.get("name") or ""))
    for grp in (args.include or []):
        for u in grp:
            cands.append((u, "override-target"))
    seen, uniq = set(), []
    for u, n in cands:
        if u not in seen:
            seen.add(u)
            uniq.append((u, n))
    if args.limit:
        uniq = uniq[: args.limit]
    print(f"probing {len(uniq)} URLs with {args.workers} workers", flush=True)

    srv, port = start_harness()
    lock = threading.Lock()
    results: list[dict] = []

    def work(chunk):
        b = Browser()
        b.harness_port = port
        for url, name in chunk:
            Harness.target = url
            t0 = time.time()
            h = header_verdict(url)
            r = b.probe(url, wait=args.wait)
            framable, playable, notes = judge(h, r)
            rec = {
                "url": url,
                "name": name,
                "verdict": "FRAMABLE" if (framable and playable) else (
                    "FRAMED-STATIC" if framable else "BLOCKED"),
                "framable": framable,
                "playable": playable,
                "status": h.get("status"),
                "xfo": h.get("xfo"),
                "csp_frame_ancestors": (CS_ATTR.search(h.get("csp") or "").group(1).strip()
                                        if CS_ATTR.search(h.get("csp") or "") else ""),
                "canvas": (r.get("top") or {}).get("liveCanvas", 0),
                "webgl": (r.get("top") or {}).get("webgl", 0),
                "text_len": (r.get("top") or {}).get("textLen", 0),
                "title": (r.get("top") or {}).get("title", "")[:120],
                "seconds": round(time.time() - t0, 1),
                "notes": notes,
            }
            print(f"{rec['verdict']:<13} {url}  ({rec['seconds']}s)  {'; '.join(notes)[:120]}",
                  flush=True)
            with lock:
                results.append(rec)
        b.close()

    n = max(1, args.workers)
    chunks = [uniq[i::n] for i in range(n)]
    threads = [threading.Thread(target=work, args=(c,), daemon=True) for c in chunks if c]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    srv.shutdown()

    review = {}
    try:
        review = {k: v for k, v in json.load(open(args.review, encoding="utf-8")).items()
                  if not k.startswith("_")}
    except Exception:
        review = {}
    order = {u: i for i, (u, _) in enumerate(uniq)}
    results.sort(key=lambda r: order.get(r["url"], 999))
    for r in results:
        rv = review.get(r["url"]) or review.get(r["url"].rstrip("/")) or {}
        if r["verdict"] != "FRAMABLE":
            r["reviewed"] = "n/a"
        elif not rv:
            r["reviewed"] = "unreviewed"
        else:
            r["reviewed"] = "confirmed" if rv.get("confirmed") else "rejected"
            r["review_note"] = rv.get("note", "")[:200]
    verified = [r["url"] for r in results
                if r["verdict"] == "FRAMABLE" and r["reviewed"] in ("confirmed", "unreviewed")]
    if review:
        verified = [u for u in verified if review.get(u, review.get(u.rstrip("/"), {})).get("confirmed")]
    payload = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "rule": "iframe commits AND the framed document is a live game surface (canvas/webgl), "
                "AND a human has visually confirmed it plays (embed-review.json)",
        "gates": {"automated": "headless Chromium: headers + OOPIF canvas/WebGL probe",
                  "visual": "embed-review.json confirmed=true (screenshot reviewed)"},
        "probed": len(results),
        "verified": verified,
        "results": results,
    }
    os.makedirs(os.path.dirname(out_p), exist_ok=True)
    json.dump(payload, open(out_p, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    with open(os.path.join(os.path.dirname(out_p), "embed-probe.log"), "w", encoding="utf-8") as fh:
        for r in results:
            fh.write(f"{r['verdict']}\t{r['url']}\tcanvas={r['canvas']} webgl={r['webgl']} "
                     f"text={r['text_len']}\t{'; '.join(r['notes'])}\n")
    from collections import Counter
    c = Counter(r["verdict"] for r in results)
    print(f"\nPROBED {len(results)}  " + "  ".join(f"{k} {v}" for k, v in c.most_common()))
    print(f"VERIFIED {len(verified)} -> {out_p}")
    for u in verified:
        print("  +", u)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
