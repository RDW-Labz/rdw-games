#!/usr/bin/env python3
"""Bugcrowd Hacker API client — create submission drafts without a browser.

Docs: https://docs.bugcrowd.com/hacker-api/
Auth: Authorization: Token <api_username>:<api_token>
      from https://bugcrowd.com/settings/api_credentials
      scopes: read:engagement_list, read:submissions, write:draft_submissions
      (write scope is only offered after Bugcrowd Researcher Success enables it)

Token resolution order: $BUGROWD_TOKEN, ~/.config/rdwlabz/bugcrowd_hacker.cred,
then ~/.config/rdwlabz/bugcrowd_api.cred.  Files hold "username:token", mode 600.

Commands
  health                        whoami/credential sanity check
  engagements                   list engagements visible to this token
  scope <engagement_id>         targets + VRT rules for an engagement
  submissions                   list your submissions
  draft <spec.json> [--apply]   create a submission draft (dry run by default)
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://hacker-api.bugcrowd.com/v1"
CRED_FILES = [
    Path.home() / ".config/rdwlabz/bugcrowd_hacker.cred",
    Path.home() / ".config/rdwlabz/bugcrowd_api.cred",
]


def token() -> str:
    env = os.environ.get("BUGROWD_TOKEN")
    if env:
        return env.strip()
    for p in CRED_FILES:
        if p.exists():
            t = p.read_text().strip()
            if t:
                return t
    sys.exit("no Bugcrowd token: set $BUGROWD_TOKEN or write 'user:token' to "
             "~/.config/rdwlabz/bugcrowd_hacker.cred")


def call(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Token " + token())
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:400]}
    except urllib.error.URLError as e:
        sys.exit(f"network error talking to {url}: {e.reason}")


def explain(code: int, payload: dict) -> None:
    if code < 300:
        return
    errs = payload.get("errors")
    if isinstance(errs, list):
        for e in errs:
            print(f"  ! {e.get('status', code)} {e.get('code', '')}: "
                  f"{e.get('detail', '')} (field={e.get('field', '-')})")
    else:
        print("  !", json.dumps(payload)[:400])
    if code == 401:
        print("  => this token is not a Hacker API token. Mint one at "
              "https://bugcrowd.com/settings/api_credentials with scopes "
              "read:engagement_list, read:submissions, write:draft_submissions.")
    if code == 403:
        print("  => account/token lacks the scope, or the identity is unverified, "
              "or Bugcrowd has not enabled write:draft_submissions yet.")


def cmd_health() -> None:
    code, payload = call("GET", "/engagements")
    print(f"GET /v1/engagements -> HTTP {code}")
    if code == 200:
        print(f"  engagements visible: {len(payload.get('data') or [])}")
        print("  credential OK for the Hacker API")
    else:
        explain(code, payload)


def cmd_engagements() -> None:
    code, payload = call("GET", "/engagements")
    if code != 200:
        print(f"HTTP {code}")
        explain(code, payload)
        return
    rows = payload.get("data") or []
    if not rows:
        print("no engagements visible to this token (join a program first)")
        return
    for e in rows:
        a = e.get("attributes", e)
        print(f"{e.get('id')}  {a.get('name', '?')}  "
              f"[{a.get('state', a.get('status', '?'))}]  "
              f"{a.get('brief_url', a.get('slug', ''))}")


def cmd_scope(engagement_id: str) -> None:
    code, payload = call("GET", f"/engagements/{engagement_id}/scope")
    if code != 200:
        print(f"HTTP {code}")
        explain(code, payload)
        return
    for item in payload.get("data") or []:
        a = item.get("attributes", {})
        print(f"target {item.get('id')}  {a.get('name')}  "
              f"category={a.get('category')}  "
              f"in_scope={a.get('in_scope')}  uri={a.get('uri', '')}")
        for v in a.get("vrt_scope") or a.get("allowed_vrt") or []:
            print(f"    vrt: {v if isinstance(v, str) else json.dumps(v)[:120]}")


def cmd_submissions() -> None:
    code, payload = call("GET", "/submissions?limit=50")
    if code != 200:
        print(f"HTTP {code}")
        explain(code, payload)
        return
    rows = payload.get("data") or []
    print(f"{len(rows)} submission(s)")
    for s in rows:
        a = s.get("attributes", {})
        print(f"  {s.get('id')}  {a.get('state', '?'):14s} {a.get('title', '')[:70]}")


def cmd_draft(spec_path: str, apply: bool) -> None:
    spec = json.loads(Path(spec_path).read_text())
    for k in ("engagement_id", "title", "description"):
        if not spec.get(k):
            sys.exit(f"spec missing required field: {k}")
    body = {k: spec[k] for k in
            ("engagement_id", "title", "description", "bug_url",
             "vulnerability_type", "target") if spec.get(k)}
    print(f"draft spec: {spec_path}")
    print(f"  engagement {spec['engagement_id']}")
    print(f"  title      {spec['title'][:90]}")
    print(f"  vrt        {spec.get('vulnerability_type', '(unset)')}")
    print(f"  target     {spec.get('target', '(unset)')}")
    print(f"  description {len(spec['description'])} chars")
    if not apply:
        print("dry run — re-run with --apply to POST /v1/submissions?draft=true")
        return
    code, payload = call("POST", "/submissions?draft=true", body)
    print(f"POST /v1/submissions?draft=true -> HTTP {code}")
    if code < 300:
        d = payload.get("data") or {}
        print(f"  draft created: {d.get('id')}")
        for m in payload.get("validation_messages") or []:
            print(f"  ! validation: {m.get('code')} {m.get('field')} — {m.get('detail')}")
    else:
        explain(code, payload)


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    cmd, rest = args[0], args[1:]
    if cmd == "health":
        cmd_health()
    elif cmd == "engagements":
        cmd_engagements()
    elif cmd == "scope" and rest:
        cmd_scope(rest[0])
    elif cmd == "submissions":
        cmd_submissions()
    elif cmd == "draft" and rest:
        cmd_draft(rest[0], "--apply" in rest)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
