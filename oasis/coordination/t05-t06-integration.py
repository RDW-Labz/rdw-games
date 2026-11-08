"""Disposable controlled HTTP integration across the isolated T05/T06 branches.

No machine proxy/certificate changes, external services, keychain reads or private
macros in git. Run using the T05 Python; only this process extends import paths.
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
T05 = ROOT / "worktrees" / "remote-t05"
T06 = ROOT / "worktrees" / "remote-t06"
sys.path.insert(0, str(T05 / "src"))
# Reuse exact installed PyYAML in the sibling environment without changing either.
for packages in (T06 / ".venv" / "lib").glob("python*/site-packages"):
    sys.path.append(str(packages))
import remote  # noqa: E402

remote.__path__.append(str(T06 / "src" / "remote"))
from remote.macro import (  # noqa: E402
    infer_macro,
    load_macro,
    load_recording,
    replay_macro,
    save_macro,
)
from remote.macro_transport import HttpTransport  # noqa: E402
from remote.proxy import TraceWriter  # noqa: E402


class NoSecrets:
    def get(self, name: str):
        raise AssertionError("Controlled public requests must never resolve a secret")


def check() -> dict[str, object]:
    calls: list[list[dict[str, object]]] = [[], []]

    def handler_for(index):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                raw = self.rfile.read(int(self.headers["Content-Length"]))
                calls[index].append(json.loads(raw))
                self.send_response(201)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, format, *args):
                pass

        return Handler

    servers = [ThreadingHTTPServer(("127.0.0.1", 0), handler_for(i)) for i in range(2)]
    threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in servers]
    for thread in threads:
        thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="oasis-t05-t06-", dir="/private/tmp") as temp:
            folder = Path(temp)
            paths = []
            for sample, person in enumerate(("Ada", "Eve")):
                path = folder / f"sample-{sample}.jsonl"
                writer = TraceWriter(path)
                try:
                    bodies = [{"name": person, "mode": "demo"}, {"state": "ready", "count": 1}]
                    for index, (server, body) in enumerate(zip(servers, bodies, strict=True)):
                        route = "/tasks" if index == 0 else "/archive"
                        url = f"http://127.0.0.1:{server.server_port}{route}"
                        encoded = json.dumps(body).encode()
                        request = urllib.request.Request(
                            url,
                            data=encoded,
                            method="POST",
                            headers={"Content-Type": "application/json"},
                        )
                        with urllib.request.urlopen(request, timeout=3) as response:
                            assert response.status == 201
                        writer.write_request({
                            "method": "POST",
                            "url": url,
                            "headers": [["Content-Type", "application/json"],
                                        ["Content-Length", str(len(encoded))]],
                            "body": encoded.decode(),
                        })
                finally:
                    writer.close()
                paths.append(path)
            macro = infer_macro("integration", [load_recording(path) for path in paths])
            assert macro["arguments"] == {"arg1": "Ada"}
            macro_path = save_macro(macro, folder / "drawer")
            assert not macro_path.is_relative_to(ROOT)
            macro = load_macro("integration", folder / "drawer")
            for observed in calls:
                observed.clear()
            waiting, release = threading.Event(), threading.Event()
            audits = []
            approvals = []

            def confirm(index, summary):
                approvals.append(index)
                waiting.set()
                return release.wait(timeout=5)

            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(
                    replay_macro,
                    macro,
                    {"arg1": "Mia"},
                    transport=HttpTransport(),
                    secret_reader=NoSecrets(),
                    confirm=confirm,
                    audit=audits.append,
                )
                assert waiting.wait(timeout=3)
                assert calls == [[], []]
                assert not future.done()
                release.set()
                result = future.result(timeout=5)
            assert result.status == "complete" and result.completed_steps == 2
            assert approvals == [1, 2]
            assert calls == [[{"name": "Mia", "mode": "demo"}],
                             [{"state": "ready", "count": 1}]]
            audit_text = json.dumps(audits)
            assert all(value not in audit_text for value in ("Ada", "Eve", "Mia"))
            assert len(audits) == 8
            return {
                "result": "PASS",
                "recorded_samples": 2,
                "services": 2,
                "completed_steps": result.completed_steps,
                "changed_arguments": 1,
                "approval_wait_proven": True,
                "approvals": len(approvals),
                "metadata_audit_events": len(audits),
                "private_temp_files_cleaned_on_exit": True,
            }
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(timeout=2)


if __name__ == "__main__":
    print(json.dumps(check(), sort_keys=True))
