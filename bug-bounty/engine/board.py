#!/usr/bin/env python3
"""The board — what is waiting, which rail is broken, and what any of it is worth.

Every earlier status surface in this repo answered one question and drifted from the others: `brief.py`
counted coverage and filings, `money.py` counted money, the block file knew the write path was dead,
`bc_token.py` knew Bugcrowd had no token, and nothing put them on one page. So a session could read any
one of them and still not know that a verified report was sitting behind a 403.

This is that one page. It is deterministic and read-only: no writes unless `--write`, no model in the
path, exit code always 0. A board that fails loudly on a quiet day is a board that gets ignored, which
is exactly how the write block went unnoticed for three hours.

  ./board.py                 human board
  ./board.py --json          machine-readable, same facts
  ./board.py --write         also drop reports/BOARD.md
  ./board.py --no-probe      skip the two network probes (mail, bugcrowd session)

Probes are the point: a credential that rots silently is a credential that will. Each probe has a
timeout and degrades to `unknown` rather than taking the board down.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KYC_FILE = ROOT / "engine" / ".kyc.json"
VDP_FILE = ROOT / "engine" / ".h1-vdp.json"   # last real submission attempt against a submission-only scope
ENG = ROOT / "engine"
REPORTS = ROOT / "reports"
NOW = dt.datetime.now(dt.timezone.utc)


def utc(ts: str | None) -> dt.datetime | None:
    if not ts:
        return None
    try:
        return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def ago(ts: str | None) -> str:
    t = utc(ts)
    if not t:
        return "unknown"
    d = (NOW - t).total_seconds()
    if d < 0:
        return "just now"
    for unit, sec in (("d", 86400), ("h", 3600), ("m", 60)):
        if d >= sec:
            return f"{int(d // sec)}{unit}"
    return f"{int(d)}s"


def read_json(p: Path, default=None):
    try:
        return json.loads(p.read_text())
    except Exception:
        return default


def run(cmd: list[str], timeout: float = 40) -> tuple[int, str, str]:
    try:
        cp = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=str(ROOT))
        return cp.returncode, cp.stdout or "", cp.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"
    except Exception as e:  # pragma: no cover - a probe must never kill the board
        return 1, "", str(e)


# ----------------------------------------------------------------------------- rails

def rail_h1_reports() -> dict:
    """Per-report state. The list endpoint 401s on a personal token; `/hackers/reports/{id}` does not.

    This is the rail that answers informative / duplicate / paid, and the one that decides whether the
    whole dangling-takeover class is worth another filing.
    """
    try:
        sys.path.insert(0, str(ENG))
        import h1_api  # noqa: WPS433
    except Exception as e:
        return {"rail": "hackerone:reports", "state": f"error: {e}"}
    ids = []
    for row in read_json(REPORTS / "filed.json", []) or []:
        rid = str(row.get("id") if isinstance(row, dict) else row)
        if rid.isdigit():
            ids.append(rid)
    states, bad = {}, []
    for rid in ids[:6]:
        try:
            code, payload = h1_api.call("GET", f"/hackers/reports/{rid}")
            attrs = ((payload or {}).get("data") or {}).get("attributes") or {}
            states[rid] = attrs.get("state") or f"http {code}"
            if code != 200:
                bad.append(rid)
        except Exception as e:
            states[rid] = f"error ({e})"
            bad.append(rid)
    detail = " · ".join(f"{k} {v}" for k, v in states.items())
    return {"rail": "hackerone:reports", "state": "ok" if states and not bad else
            ("unreadable" if not states else "partial"), "reports": states, "detail": detail}


def rail_h1_write() -> dict:
    """Can the token create a report — measured now, not remembered.

    This used to read `reports/h1-write-blocked.json` as the truth, and `h1_autofile.py` wrote that file on
    any 401 *or* 403. So one programme refusing one filing (Spotify answers a bare `{"status": 403}` for its
    `*.withspotify.com` wildcard) made a perfectly good credential look dead, and the rail stayed red until a
    human deleted the marker — while three reports on that same token had already been filed.

    The question is answerable in one request: POST a deliberately incomplete report. A 400/404 means the
    body was parsed and the credential accepted (only a parameter is missing); 401 means the token is gone;
    403 here would mean the token cannot reach the endpoint at all. Programme-level refusals land in
    `hold-queue.json` and are reported as held leads, not as a broken rail.
    """
    try:
        sys.path.insert(0, str(ENG))
        import h1_api  # noqa: WPS433
        code, payload = h1_api.call("POST", "/hackers/reports",
                                    {"data": {"type": "report", "attributes": {}}})
        held = read_json(REPORTS / "hold-queue.json") or []
        if code in (400, 404):
            return {"rail": "hackerone:write", "state": "ok", "probe": f"http {code}",
                    "detail": "credential accepted on /v1/hackers/reports (probe rejected for a missing "
                              "parameter, which is the point)",
                    "held_leads": len(held)}
        return {"rail": "hackerone:write", "state": "blocked" if code == 401 else f"http {code}",
                "probe": f"http {code}", "detail": str(payload)[:200], "held_leads": len(held)}
    except Exception as e:
        return {"rail": "hackerone:write", "state": f"error: {e}"}


def rail_h1_read() -> dict:
    """Read is a different credential surface from write, and it is the one that still works."""
    try:
        sys.path.insert(0, str(ENG))
        import h1_api  # noqa: WPS433
        code, payload = h1_api.call("GET", "/hackers/programs?page%5Bsize%5D=1")
        rows = len((payload or {}).get("data") or [])
        tok = Path.home() / ".config/rdwlabz/hackerone_api.token"
        age = (f"{(NOW - dt.datetime.fromtimestamp(tok.stat().st_mtime, dt.timezone.utc)).days}d"
               if tok.exists() else "missing")
        return {"rail": "hackerone:read", "state": "ok" if code == 200 else f"http {code}",
                "programs_seen": rows, "token_age": age}
    except Exception as e:
        return {"rail": "hackerone:read", "state": f"error: {e}"}


def rail_kyc() -> dict:
    """Bugcrowd's identity gate, as last read from the live settings page by tools/kyc_state.py.

    An unverified account can fill and autosave any draft and still have every Managed Bug Bounty submit
    refused, so this rail exists to stop a session from treating "signed in" as "can file". The file is a
    stamp, not a probe: the vendor only lets you look so often, so the stamp carries its own age.
    """
    try:
        d = json.loads(KYC_FILE.read_text())
    except Exception:
        return {"rail": "bugcrowd:kyc", "state": "unknown",
                "detail": "not checked — tools/kyc_state.py --write reads the settings page"}
    age_days = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(d["checked"])).days
    state = "verified" if d.get("verified") else "unverified"
    return {"rail": "bugcrowd:kyc", "state": state, "days_since_check": age_days,
            "detail": d.get("detail", "")[:120]}


def rail_h1_vdp():
    """HackerOne's write rail, tested where it matters: against an asset that accepts reports but pays $0.

    `hackerone:write` answers "is the token accepted", and it says yes — which let the board tell every
    session that the queue files itself. It does not: a POST to /v1/hackers/reports against a
    submission-only scope comes back 403 with an empty error body. Both facts belong on the board, or a
    session reads "write: ok", fires the queue, and gets nothing but 403s.
    """
    try:
        d = json.loads(VDP_FILE.read_text())
    except Exception:
        return {"rail": "hackerone:vdp-write", "state": "untested",
                "detail": "no submission-only attempt recorded — tools/h1_file_draft.py --allow-vdp stamps this"}
    code = d.get("code")
    state = "ok" if isinstance(code, int) and code < 300 else (f"refused({code})" if code else "unknown")
    age_h = int((dt.datetime.now(dt.timezone.utc)
                 - dt.datetime.fromisoformat(d["checked"])).total_seconds() // 3600)
    return {"rail": "hackerone:vdp-write", "state": state, "age_hours": age_h,
            "detail": f"{d.get('team','?')} scope {d.get('scope_id','?')} → {str(d.get('detail',''))[:90]}"}


def rail_browser():
    """The lane's own browser on the bot screen — the surface that signs in and files.

    Whether a page renders is the whole question: HackerOne and Bugcrowd both sit behind Cloudflare, and a
    browser that cannot pass the wall is a rail that looks alive (port open, tab present) and delivers
    nothing. Sign-in is read from the session cookie, because a signed-out tab still answers on the port.
    """
    port = os.environ.get("BOUNTY_CDP_PORT", "9226")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=4) as r:
            browser = json.loads(r.read()).get("Browser", "?")
    except Exception as e:
        return {"rail": "browser:lane", "state": "off",
                "detail": f"nothing on :{port} ({type(e).__name__}) — systemctl --user start bounty-browser"}
    cookies = _cdp_cookie_names(port, ["https://hackerone.com", "https://bugcrowd.com",
                                       "https://login.hackers.bugcrowd.com"])
    h1 = "_hackerone_session" in cookies
    bc = any(c.startswith("_bugcrowd_session") or c.startswith("okta-oauth") for c in cookies)
    return {"rail": "browser:lane", "state": "ok", "port": port, "browser": browser,
            "hackerone_signed_in": h1, "bugcrowd_signed_in": bc,
            "detail": (f"hackerone {'signed in' if h1 else 'signed out'}, "
                       f"bugcrowd {'signed in' if bc else 'signed out'}")}


def _cdp_cookie_names(port: str, urls: list[str], timeout: float = 10) -> set[str]:
    """Cookie names for the given origins, read over CDP.

    A private helper rather than a dependency: board.py must keep working when websockets is missing, which
    is why the failure path returns no cookies instead of raising.
    """
    async def _go() -> set[str]:
        import websockets  # noqa: WPS433
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=4) as r:
            pages = [t for t in json.loads(r.read()) if t.get("type") == "page"]
        if not pages:
            return set()
        async with websockets.connect(pages[0]["webSocketDebuggerUrl"], max_size=2 ** 22) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Network.getCookies",
                                      "params": {"urls": urls}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == 1:
                    rows = (msg.get("result") or {}).get("cookies") or []
                    return {c.get("name", "") for c in rows}
    try:
        return asyncio.run(asyncio.wait_for(_go(), timeout))
    except Exception:
        return set()


def rail_bugcrowd(probe: bool) -> dict:
    rc, out, err = run([sys.executable, "engine/bc_token.py", "status"], timeout=30)
    text = (out + err).strip()
    first = text.splitlines()[0] if text else "no output"
    state = "invalid_token(pre-GA)" if ("401" in text or "invalid_token" in text) else (
        "ok" if rc == 0 and "FAIL" not in text else "unknown")
    detail = ("token FAIL (401 invalid_token) — API is pre-GA; submits go through the web form"
              if state.startswith("invalid_token") else first[:160])
    res = {"rail": "bugcrowd:api", "state": state, "detail": detail}
    if probe:
        rc2, out2, err2 = run([sys.executable, "engine/bc_session.py", "check"], timeout=45)
        text = (out2 + err2).strip()
        low = text.lower()
        # Three states, not two. `bc_session.py` exits 2 when it cannot reach the browser at all, and for
        # weeks that was rendered as "signed out" because the probe was on a dead CDP port — so the board
        # kept telling every session that Bugcrowd filing was impossible while the browser sat signed in.
        if rc2 == 2 or "probe failed" in low:
            res["session"] = "probe-failed"
        else:
            res["session"] = ("signed-in" if ("signed in" in low and "not" not in low.split("signed in")[0][-6:])
                              else "signed-out" if "signed out" in low or "not signed" in low else "unknown")
        res["session_detail"] = text.splitlines()[-1][:160] if text else "no output"
    return res


def rail_mail(probe: bool, timeout: float = 240) -> dict:
    """Can the lane read the mailbox — asked of the path that actually reads it.

    The Google API lane is permanently dead on this box (`invalid_grant`, needs an interactive OAuth run to
    fix), but the board kept reporting that as the state of *mail*, so every session was told replies,
    DocuSign codes and vendor threads were unreachable. They are not: `tools/mail_search.py` drives the
    operator's signed-in Firefox profile copy and reads Gmail fine. Probing the dead path and calling it
    "mail:gmail" is how a working mailbox got treated as a freeze.
    """
    if not probe:
        return {"rail": "mail:gmail", "state": "not-probed"}
    tool = ROOT / "tools" / "mail_search.py"
    if not tool.exists():
        return {"rail": "mail:gmail", "state": "unavailable", "detail": "tools/mail_search.py missing"}
    rc, out, err = run([sys.executable, str(tool), "is:unread newer_than:7d", "--json"], timeout=timeout)
    text = (out + err).strip()
    try:
        d = json.loads(out)
    except Exception:
        d = None
    if d and d.get("ok"):
        return {"rail": "mail:gmail", "state": "ok", "path": "firefox-profile",
                "unread_7d": d.get("matched"), "detail": "tools/mail_search.py — signed-in profile copy"}
    if "sign in" in text.lower() or "accounts.google.com" in text.lower():
        return {"rail": "mail:gmail", "state": "signed-out", "path": "firefox-profile",
                "fix": "re-copy the signed-in Firefox profile into engine/profiles/mail"}
    return {"rail": "mail:gmail", "state": f"error(rc={rc})", "path": "firefox-profile",
            "detail": text.splitlines()[-1][:160] if text else ""}


def rails_lock() -> dict:
    """The recon lanes serialise on a flock, so the file existing means nothing — the lock does.

    `flock -n` on the same path is the only honest test: rc 0 means nobody holds it, rc 1 means a run
    is live right now. Reading the file's mtime (the obvious check) reports a stale lock on a free path
    and would send someone hunting a process that is not there.
    """
    lock = ENG / ".recon.lock"
    if not lock.exists():
        return {"rail": "recon:lock", "state": "free"}
    rc, _, _ = run(["flock", "-n", str(lock), "true"], timeout=10)
    if rc == 0:
        return {"rail": "recon:lock", "state": "free",
                "note": "lock file present but unheld — the 15m lane will proceed"}
    return {"rail": "recon:lock", "state": "held", "note": "a recon run is active; the 15m lane will skip"}


def holds() -> list[dict]:
    return read_json(REPORTS / "hold-queue.json", []) or []


def crons() -> list[dict]:
    """Armed or disarmed, read from the default profile's job store.

    A disabled lane is invisible in every log — nothing runs, so nothing is written, so nothing looks
    wrong. That is how the 15-minute lantern and the Bugcrowd session watchdog were both quietly off.
    """
    p = Path.home() / ".local/share/z13/releases/hermes-stock-l9m64A/profile/cron/jobs.json"
    data = read_json(p, {}) or {}
    jobs = data.get("jobs", data) if isinstance(data, dict) else data
    rows = []
    for j in (jobs if isinstance(jobs, list) else list(jobs.values())):
        name = str(j.get("name") or "")
        if "bounty" not in name.lower() and "bugcrowd" not in name.lower():
            continue
        sched = (j.get("schedule") or {}).get("display") or (j.get("schedule") or {}).get("expr") or "?"
        rows.append({"id": (j.get("id") or "")[:12], "name": name, "schedule": sched,
                     "armed": bool(j.get("enabled")), "last": j.get("last_status") or "never"})
    return rows


# ----------------------------------------------------------------------------- queue & money

def queue() -> dict:
    qmd = REPORTS / "QUEUE.md"
    bullets, skipped = [], 0
    if qmd.exists():
        for line in qmd.read_text().splitlines():
            if line.startswith("- **"):
                bullets.append(line[2:].strip())
            elif line.startswith("- skip"):
                skipped += 1
    subs = sorted(p.name for p in REPORTS.glob("*submission*.md"))
    return {"queued": len(bullets), "skipped": skipped, "items": bullets, "human_reports": subs}


def claimable_backlog() -> dict:
    """Hosts still worth work — which is not the same as hosts a sweep once liked.

    Every one of the three rows that sat here was already dispositioned: Spotify answered 403 to the same
    probe, Expedia is paused, and `nines.githubapp.com` points at the `azurewebsites.net` *apex*, where
    there is no app label for anyone to register. Counting them as backlog made the board promise inventory
    it had already thrown away, so the exclusions live here rather than in whoever reads it next.
    """
    dead = read_json(ENG / "claimable_dead.json", {}) or {}
    hold_targets = {(h.get("target") or "").strip().lower().rstrip(".")
                    for h in (read_json(REPORTS / "hold-queue.json", []) or [])}
    hold_hosts = {(x or "").strip().lower().rstrip(".")
                  for h in (read_json(REPORTS / "hold-queue.json", []) or [])
                  for x in (h.get("hosts") or [])}
    # A host we already filed is not backlog, whatever its state reads: `nines.githubapp.com` was filed and
    # closed informative, and it kept appearing here as fresh inventory the board could sell.
    # `filed.json` records the report, not the host — there is no `host` field to join on, only a title and a
    # report id — so match the host against the whole entry rather than pretending the column exists.
    filed_blob = " ".join(str(v) for r in (read_json(REPORTS / "filed.json", []) or [])
                          if isinstance(r, dict) for v in r.values()).lower()
    try:
        sys.path.insert(0, str(ENG))
        import h1_autofile as A
    except Exception:
        A = None
    out: dict[str, list[str]] = {}
    for program, rows in dead.items():
        if not isinstance(rows, list):
            continue
        keep = []
        for r in rows:
            if not r:
                continue
            host = (r[0] or "").strip().lower().rstrip(".")
            target = ((r[1] if len(r) > 1 else "") or "").strip().lower().rstrip(".")
            if host in filed_blob or host in hold_hosts or target in hold_targets:
                continue
            if A is not None and A.is_provider_apex(target):
                continue
            keep.append(host)
        if keep:
            out[program] = keep
    return {"programmes": len(out), "hosts": sum(len(v) for v in out.values()), "detail": out}


def money() -> dict:
    rc, out, err = run([sys.executable, "engine/money.py", "--json"], timeout=90)
    try:
        return json.loads(out)
    except Exception:
        return {"error": (out + err).strip()[:300] or "money.py produced no JSON"}


# ----------------------------------------------------------------------------- next actions

def next_actions(rail_list: list[dict], q: dict, m: dict, backlog: dict, lanes: list[dict]) -> list[str]:
    acts: list[str] = []
    by = {r["rail"]: r for r in rail_list}
    h1w, h1r = by.get("hackerone:write", {}), by.get("hackerone:read", {})
    bc, mail = by.get("bugcrowd:api", {}), by.get("mail:gmail", {})

    for lane in lanes:
        if not lane["armed"]:
            acts.append(f"Lane '{lane['name']}' is disarmed ({lane['schedule']}, last {lane['last']}) — "
                        f"nothing it watches is being watched: `hermes cron resume {lane['id']}`")

    br = by.get("browser:lane", {})
    if br.get("state") == "ok" and not br.get("hackerone_signed_in"):
        # The password is no longer the blocker: the reset rail completed (tools/h1_password.py rotated the
        # secret into the vault) and the sign-in is refused at a WebAuthn "Security Key" prompt, which no
        # headless session can satisfy. The API write path accepts the token but refuses submission-only
        # scopes with a bodyless 403, so neither rail files these drafts — say both halves.
        vdp = by.get("hackerone:vdp-write", {})
        acts.append("HackerOne web sign-in reaches the password step and stops at a WebAuthn security-key "
                    "prompt (touch required), and the API refuses submission-only scopes with a bodyless "
                    f"403 [{vdp.get('state','?')}] — only a bounty-eligible asset or a tapped key files "
                    "these drafts")
    if br.get("state") == "ok" and not br.get("bugcrowd_signed_in"):
        acts.append("Bugcrowd is signed out; its Okta code goes to security@rdwlabz.com and the mailbox is "
                    "readable through tools/mail_search.py, so the code step can be automated — "
                    "`CDP_PORT=9226 python3 engine/bc_login.py` walks it — it reads the Okta code from the same mailbox")
    kyc = by.get("bugcrowd:kyc", {})
    if br.get("state") == "ok" and br.get("bugcrowd_signed_in") and kyc.get("state") == "unverified":
        acts.append("Bugcrowd accepts the session but refuses every Managed Bug Bounty submit until identity "
                    "verification is done — government ID + selfie, 5 attempts, 15 min each, at "
                    "/h/settings/identity_verification. That one is yours; VDP submissions are exempt until then")
    if h1w.get("state") == "blocked":
        host = h1w.get("host") or "the queued host"
        acts.append(
            f"HackerOne write path blocked since {h1w.get('since')} (HTTP {h1w.get('code')}) while "
            f"{host} is verified and waiting — mint a Hacker API token with report-write scope, or file "
            f"it through the signed-in browser: `python3 engine/h1_fill.py --from-report <md> --team <handle> --dry`")
    if h1r.get("state") != "ok":
        acts.append(f"HackerOne read path is {h1r.get('state')} — fix before trusting any tally")
    if q.get("queued"):
        acts.append(f"{q['queued']} report(s) drafted in the filing queue, none filed — work the queue "
                    f"in platform order (HackerOne first: the write path is the only one that reads back)")
    for h in holds():
        acts.append(f"HOLD {h.get('target')} [{h.get('team')}] submission_state={h.get('submission_state')} "
                    f"since {h.get('checked_at')} — re-check the programme state; file the moment it reopens")
    if str(bc.get("state", "")).startswith("invalid_token"):
        acts.append("Bugcrowd Hacker API is pre-GA (every token 401s) — submit through the web form "
                    "(`engine/bc_web.py`) with the signed-in browser, and keep `engine/bc_session.py watch` armed")
    if bc.get("session") == "signed-out":
        acts.append("Bugcrowd web session is signed out — no Bugcrowd filing is possible until it is back")
    elif bc.get("session") == "probe-failed":
        acts.append("Bugcrowd session probe could not reach the browser (not the same as signed out) — "
                    "start the desktop browser before acting on any Bugcrowd line")
    if str(mail.get("state", "")).startswith("dead"):
        acts.append("Mail lane is dead (invalid_grant) — replies and e-sign codes are unreadable until "
                    "the Google OAuth flow is re-run once")
    filed_n = m.get("claims_filed") if isinstance(m, dict) else None
    if filed_n and not m.get("claims_open"):
        acts.append(f"All {filed_n} claims are closed ({m.get('claims_closed', '?')}) and "
                    f"${m.get('collected_usd', 0):,.2f} collected — the dangling-takeover class is not paying; "
                    f"the next dollar comes from one application read closely, not another sweep")
    if (m.get("outreach_offers") or 0):
        why = ("replies cannot be counted while the mail lane is dead, so treat '0 replies' as unknown"
               if str(mail.get("state", "")).startswith("dead") else
               "no replies after a week means the ask or the addresses are wrong, not that the idea is")
        acts.append(f"{m.get('outreach_offers')} cold offer(s) to {m.get('outreach_orgs', '?')} organisation(s), "
                    f"${m.get('outreach_ask_usd', 0):,} asked, {m.get('outreach_bounced', 0)} bounced — {why}")
    if backlog.get("hosts"):
        acts.append(f"{backlog['hosts']} claimable host(s) across {backlog['programmes']} programme(s) sit in the "
                    f"backlog — they are inventory, not income, until a report is filed")
    return acts


# ----------------------------------------------------------------------------- render

def build(probe: bool) -> dict:
    rail_list = [rails_lock(), rail_browser(), rail_kyc(), rail_h1_read(), rail_h1_reports(),
                 rail_h1_write(), rail_h1_vdp(), rail_bugcrowd(probe), rail_mail(probe)]
    q, m, backlog, lanes = queue(), money(), claimable_backlog(), crons()
    return {
        "at": NOW.isoformat(timespec="seconds"),
        "rails": rail_list,
        "lanes": lanes,
        "queue": q,
        "backlog": backlog,
        "money": m,
        "next": next_actions(rail_list, q, m, backlog, lanes),
    }


def render(b: dict) -> str:
    L = [f"BOUNTY BOARD — {b['at'][:16]}Z", ""]
    L.append("RAILS")
    for r in b["rails"]:
        state = r.get("state", "?")
        flag = "ok " if state in ("ok", "free", "signed-in", "not-probed") else "!! "
        extra = r.get("detail") or r.get("held_for") or r.get("programs_seen") or ""
        if r["rail"] == "hackerone:write" and state == "blocked":
            extra = f"since {r.get('since')} · HTTP {r.get('code')} · {r.get('host') or r.get('team') or ''}"
        L.append(f"  {flag}{r['rail']:17} {state:22} {str(extra)[:110]}")

    q = b["queue"]
    L += ["", f"QUEUE  {q['queued']} drafted · {q['skipped']} skipped as out-of-scope-or-live · "
              f"{len(q['human_reports'])} hand-written submission(s)"]
    for item in q["items"][:12]:
        L.append(f"  {item[:118]}")
    if q["queued"] > 12:
        L.append(f"  … {q['queued'] - 12} more (reports/QUEUE.md)")

    L += ["", "LANES"]
    if not b.get("lanes"):
        L.append("  no bounty lanes registered")
    for lane in b.get("lanes", []):
        L.append(f"  {'armed ' if lane['armed'] else 'OFF   '}{lane['name'][:44]:46} "
                 f"{lane['schedule']:14} last {lane['last']}")

    bl = b["backlog"]
    L += ["", f"BACKLOG  {bl['hosts']} claimable host(s) across {bl['programmes']} programme(s)"]
    for prog, hosts in list(bl["detail"].items())[:8]:
        L.append(f"  {prog:16} {', '.join(hosts)[:100]}")

    m = b["money"] or {}
    L += [""]
    if m.get("error"):
        L.append(f"MONEY  unavailable: {m['error']}")
    else:
        L.append(f"MONEY  collected ${m.get('collected_usd', 0):,.2f} · claims {m.get('claims_filed', 0)} filed "
                 f"({m.get('claims_open', '?')} open / {m.get('claims_closed', '?')} closed) · "
                 f"offers {m.get('outreach_offers', 0)} sent to {m.get('outreach_orgs', 0)} orgs "
                 f"(${m.get('outreach_ask_usd', 0):,} asked) · backlog {m.get('backlog_claimable', 0)}")

    L += ["", "NEXT"]
    if b["next"]:
        for i, a in enumerate(b["next"], 1):
            L.append(f"  {i}. {a}")
    else:
        L.append("  nothing is blocked and nothing is waiting — pick the next application to read")
    return "\n".join(L)


def main() -> None:
    ap = argparse.ArgumentParser(description="One-page state of the bounty operation.")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--write", action="store_true", help="also write reports/BOARD.md")
    ap.add_argument("--no-probe", action="store_true", help="skip mail and browser session probes")
    a = ap.parse_args()
    b = build(probe=not a.no_probe)
    text = render(b)
    print(json.dumps(b, indent=1) if a.json else text)
    if a.write:
        (REPORTS / "BOARD.md").write_text(text + "\n")
        if not a.json:
            print(f"\nwritten {REPORTS / 'BOARD.md'}")


if __name__ == "__main__":
    main()
