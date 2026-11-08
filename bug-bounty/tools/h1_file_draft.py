#!/usr/bin/env python3
"""File a drafted HackerOne report through the API — no browser, no session, no security key.

`engine/h1_fill.py` files through the web form and therefore needs a signed-in browser, and HackerOne's
sign-in now stops at a WebAuthn security-key prompt that no headless session can answer. The API does not
need that session at all: the token can create a report (`POST /v1/hackers/reports` answers `400` for a
malformed body, i.e. the credential is accepted), so this is the rail that files unattended.

  python3 tools/h1_file_draft.py reports/h1-priceline-generic-1hosts.md --team priceline \
      --host dev.customerservice-ccp.priceline.com --dry
  ... --apply        # POST it, record the id in reports/filed.json, mark the finding filed

Guards, in order: the draft must exist; the CNAME must not name the provider zone itself (no name to
claim); `h1_fill.api_spec` must find a live *bounty-eligible* structured scope covering the host; and the
body must carry a weakness id and severity, because HackerOne rejects a report without them.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))

import h1_api  # noqa: E402
import h1_fill  # noqa: E402
import h1_scope  # noqa: E402

FILED = ROOT / "reports" / "filed.json"
DB = ROOT / "engine" / "state.db"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("report")
    ap.add_argument("--team", required=True)
    ap.add_argument("--host", required=True)
    ap.add_argument("--severity", default="medium")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--allow-vdp", action="store_true",
                    help="permit a scope that accepts submissions but is not bounty-eligible (pays $0)")
    ap.add_argument("--dry", action="store_true", help="accepted for symmetry; dry is the default")
    a = ap.parse_args()

    md = Path(a.report)
    if not md.exists():
        print(f"no such draft: {md}")
        return 2

    spec_path = h1_fill.api_spec(md, a.team, a.host, severity=a.severity,
                                 need_bounty=not a.allow_vdp)   # raises on no eligible scope
    spec = json.loads(spec_path.read_text())
    if not spec.get("weakness_id"):
        print("no weakness id resolved — HackerOne would reject the report; not filing")
        return 4

    scope = h1_scope.match(a.team, a.host, need_bounty=not a.allow_vdp)
    print(json.dumps({"team": a.team, "host": a.host, "scope": (scope or {}).get("asset"),
                      "scope_id": spec["structured_scope_id"], "weakness_id": spec["weakness_id"],
                      "severity": spec["severity_rating"], "title": spec["title"]}, indent=1))
    if not a.apply:
        print("dry run — re-run with --apply to POST /v1/hackers/reports")
        return 0

    body = {"data": {"type": "report", "attributes": {
        "team_handle": spec["team_handle"],
        "title": spec["title"],
        "vulnerability_information": spec["vulnerability_information"],
        "impact": spec["impact"],
        "severity_rating": spec["severity_rating"],
        "structured_scope_id": spec["structured_scope_id"],
        "weakness_id": spec["weakness_id"],
        "report_type": "vulnerability",
    }}}
    code, payload = h1_api.call("POST", "/hackers/reports", body)
    print(f"POST -> {code} {str(payload)[:300]}")
    if code == 401:
        print("credential refused — the token needs replacing; nothing filed")
        return 3
    if code == 403:
        print("this programme refused the filing (403) — queue it in reports/hold-queue.json, "
              "the credential is fine")
        return 5
    rid = ((payload or {}).get("data") or {}).get("id")
    if not rid:
        return 6

    filed = json.loads(FILED.read_text()) if FILED.exists() else []
    filed.append({"id": rid, "program": a.team, "team_handle": a.team,
                  "scope_id": spec["structured_scope_id"], "weakness_id": spec["weakness_id"],
                  "severity": spec["severity_rating"], "title": spec["title"],
                  "spec": str(spec_path.relative_to(ROOT)), "state": "new",
                  "hosts": [a.host], "filed_via": "tools/h1_file_draft.py --apply"})
    FILED.write_text(json.dumps(filed, indent=1) + "\n")
    db = sqlite3.connect(DB)
    db.execute("update findings set report = ?, state = 'filed' where host = ?",
               (f"https://hackerone.com/reports/{rid}", a.host))
    db.commit()
    print(f"filed https://hackerone.com/reports/{rid} — recorded in reports/filed.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
