#!/usr/bin/env python3
"""HackerOne hacker API client — read programs/scopes/weaknesses, file reports.

Auth: HTTP Basic with `<hacker username>:<api token>` against
https://api.hackerone.com/v1 — token from https://hackerone.com/settings/api_token/edit

  /v1/me and /v1/reports are the *customer* API and answer
  "These credentials are not a Customer API token" for a hacker token.
  The hacker surface lives under /v1/hackers/*.

Token: $HACKERONE_TOKEN or ~/.config/rdwlabz/hackerone_api.token (mode 600).
Username: $HACKERONE_API_USER or the first line of ~/.config/rdwlabz/hackerone_api.user

Commands
  programs [handle]         list programs, or one program's attributes
  scopes <handle>           structured scopes (asset_identifier, bounty, max severity)
  weaknesses <handle>       weakness ids (CWE mapping) for that program
  report <spec.json> [--apply]
                            POST /v1/hackers/reports; dry run unless --apply
  status                    poll reports/filed.json — state of every report you filed
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://api.hackerone.com/v1"
TOKEN_FILE = Path.home() / ".config/rdwlabz/hackerone_api.token"
USER_FILE = Path.home() / ".config/rdwlabz/hackerone_api.user"
ROOT = Path(__file__).resolve().parent.parent
FILED = ROOT / "reports" / "filed.json"


def record_filed(spec_path: str, spec: dict, rid: str, state: str, created: str) -> None:
    """Append a successful filing to reports/filed.json so the daily brief can poll it."""
    try:
        book = json.loads(FILED.read_text()) if FILED.exists() else []
    except Exception:
        book = []
    book = [r for r in book if str(r.get("id")) != str(rid)]
    book.append({
        "id": str(rid),
        "program": spec.get("team_handle"),
        "team_handle": spec.get("team_handle"),
        "scope_id": spec.get("structured_scope_id"),
        "weakness_id": spec.get("weakness_id"),
        "severity": spec.get("severity_rating"),
        "title": spec.get("title"),
        "spec": str(spec_path),
        "state": state,
        "filed_at": created,
        "filed_via": "engine/h1_api.py report --apply",
    })
    FILED.parent.mkdir(parents=True, exist_ok=True)
    FILED.write_text(json.dumps(book, indent=2) + "\n")


def cmd_status() -> None:
    """Poll the state of everything in reports/filed.json — the only field a hacker token sees."""
    if not FILED.exists():
        print("no filings recorded yet (reports/filed.json absent)")
        return
    book = json.loads(FILED.read_text())
    for r in book:
        rid = r.get("id")
        code, payload = call("GET", f"/hackers/reports/{rid}")
        if code != 200:
            print(f"{rid:<9} HTTP {code}  {r.get('title', '')[:60]}")
            continue
        a = (payload.get("data") or {}).get("attributes", {})
        print(f"{rid:<9} {a.get('state', '?'):<12} {r.get('program') or '':<10} "
              f"{a.get('created_at', r.get('filed_at', ''))[:19]}  {r.get('title', '')[:60]}")



def username() -> str:
    u = os.environ.get("HACKERONE_API_USER")
    if u:
        return u.strip()
    if USER_FILE.exists():
        return USER_FILE.read_text().strip()
    return "rdwlabz"


def token() -> str:
    t = os.environ.get("HACKERONE_TOKEN")
    if t:
        return t.strip()
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text().strip()
    sys.exit(f"no token: set $HACKERONE_TOKEN or write it to {TOKEN_FILE}")


def call(method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    cred = base64.b64encode(f"{username()}:{token()}".encode()).decode()
    req.add_header("Authorization", "Basic " + cred)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:400]}
    except urllib.error.URLError as e:
        sys.exit(f"network error on {method} {path}: {e.reason}")


def show_errors(code: int, payload: dict) -> None:
    for e in payload.get("errors") or [{"status": code}]:
        print(f"  ! {e.get('status')} {e.get('title', '')}: {e.get('detail', '')}")
        src = e.get("source") or {}
        if src.get("parameter"):
            print(f"    parameter: {src['parameter']}")


def cmd_programs(handle: str | None) -> None:
    if handle:
        code, payload = call("GET", f"/hackers/programs/{handle}")
        if code != 200:
            print(f"HTTP {code}"); show_errors(code, payload); return
        a = payload.get("attributes", {})
        print(f"{payload.get('id')} {a.get('handle')} | {a.get('name')} | "
              f"bounty={a.get('offers_bounties')} | state={a.get('state')}")
        return
    code, payload = call("GET", "/hackers/programs?page%5Bsize%5D=100")
    if code != 200:
        print(f"HTTP {code}"); show_errors(code, payload); return
    rows = payload.get("data") or []
    print(f"{len(rows)} programs")
    for r in rows:
        a = r.get("attributes", {})
        print(f"  {r.get('id'):>6}  {a.get('handle', ''):28s} bounty={a.get('offers_bounties')}")


def cmd_scopes(handle: str) -> None:
    url = f"/hackers/programs/{handle}/structured_scopes?page%5Bsize%5D=100"
    while url:
        code, payload = call("GET", url)
        if code != 200:
            print(f"HTTP {code}"); show_errors(code, payload); return
        for r in payload.get("data") or []:
            a = r.get("attributes", {})
            print(f"  {r.get('id'):>5}  {a.get('asset_identifier', ''):40s} "
                  f"{a.get('asset_type', ''):6s} bounty={a.get('eligible_for_bounty')} "
                  f"max={a.get('max_severity')}")
        nxt = (payload.get("links") or {}).get("next")
        url = nxt.split("/v1", 1)[1] if nxt else None


def cmd_weaknesses(handle: str) -> None:
    url = f"/hackers/programs/{handle}/weaknesses?page%5Bsize%5D=100"
    while url:
        code, payload = call("GET", url)
        if code != 200:
            print(f"HTTP {code}"); show_errors(code, payload); return
        for r in payload.get("data") or []:
            a = r.get("attributes", {})
            print(f"  {r.get('id'):>5}  {a.get('external_id') or '-':10s} {a.get('name')}")
        nxt = (payload.get("links") or {}).get("next")
        url = nxt.split("/v1", 1)[1] if nxt else None


def cmd_report(spec_path: str, apply: bool) -> None:
    spec = json.loads(Path(spec_path).read_text())
    attrs = {k: spec[k] for k in ("title", "vulnerability_information", "impact",
                                  "severity_rating", "weakness_id", "structured_scope_id",
                                  "team_handle", "report_type")
             if spec.get(k) is not None}
    team = spec.get("team_id") or spec.get("program_id")
    if team:
        attrs["team_id"] = str(team)
    print(f"spec {spec_path}: {len(spec.get('vulnerability_information', ''))} chars of detail")
    print(f"  team={team} scope={spec.get('structured_scope_id')} "
          f"weakness={spec.get('weakness_id')} severity={spec.get('severity_rating')}")
    if not spec.get("vulnerability_information"):
        sys.exit("spec has no vulnerability_information")
    if not apply:
        print("dry run — re-run with --apply to POST /v1/hackers/reports")
        return
    code, payload = call("POST", "/hackers/reports", {"data": {"type": "report", "attributes": attrs}})
    print(f"POST /v1/hackers/reports -> HTTP {code}")
    if code < 300:
        d = payload.get("data") or {}
        a = d.get("attributes", {})
        print(f"  report id  {d.get('id')}")
        print(f"  state      {a.get('state')}")
        print(f"  url        https://hackerone.com/reports/{d.get('id')}")
        record_filed(spec_path, spec, d.get("id", ""), a.get("state", ""),
                     a.get("created_at", ""))
        print(f"  recorded   {FILED.relative_to(ROOT)}")
    else:
        show_errors(code, payload)


def main() -> None:
    a = sys.argv[1:]
    if not a:
        print(__doc__); return
    c, rest = a[0], a[1:]
    if c == "programs":
        cmd_programs(rest[0] if rest else None)
    elif c == "status":
        cmd_status()
    elif c == "scopes" and rest:
        cmd_scopes(rest[0])
    elif c == "weaknesses" and rest:
        cmd_weaknesses(rest[0])
    elif c == "report" and rest:
        cmd_report(rest[0], "--apply" in rest)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
