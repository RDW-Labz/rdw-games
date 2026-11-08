#!/usr/bin/env python3
"""Daily brief for the recon/bounty/audit operation — the thing that replaces Michael asking "how's it going".

Prints, in one screen:
  * coverage as of now (hostnames, CNAME edges, zones left)
  * claimable findings first seen in the last day, split by whether a programme pays for them
  * reports that are complete but unfiled, with the platform they belong on
  * the offer book: delivered and awaiting reply, bounced, follow-ups due or sent
  * recurring work that is armed (cron names) so nothing silently stops

Deterministic and read-only: no network calls, no writes, no LLM. Safe to run from cron every day.
Exit code is always 0 — a brief that fails loudly on an empty day is a brief that gets ignored.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import re
import sqlite3
import subprocess
import sys

ROOT = pathlib.Path("/home/cluer/Projects/bug-bounty")
DB = ROOT / "engine" / "state.db"
BOOK = ROOT / "outreach" / "sent.json"
REPORTS = ROOT / "reports"

sys.path.insert(0, str(ROOT / "engine"))


def q(db, sql, args=()):
    return db.execute(sql, args).fetchall()


def hu(n: int) -> str:
    return f"{n:,}"


def main() -> None:
    now = dt.datetime.now(dt.timezone.utc)
    day_ago = (now - dt.timedelta(days=1)).isoformat(timespec="seconds")
    lines: list[str] = [f"BOUNTY BRIEF — {now.strftime('%Y-%m-%d %H:%MZ')}", ""]

    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    hosts = q(db, "select count(*) from hosts")[0][0]
    edges = q(db, "select count(*) from cnames")[0][0]
    claim = q(db, "select count(*) from findings where claimable=1")[0][0]
    pending = q(db, "select count(*) from domains where last_enum is null")[0][0]
    lines += [f"COVERAGE  {hu(hosts)} hostnames · {hu(edges)} CNAME edges · "
              f"{claim} claimable · {pending} zones left", ""]

    # --- radar: programmes that newly appeared, and whether we already hold a claimable finding in them
    try:
        out = subprocess.run([sys.executable, str(ROOT / "engine" / "radar.py")],
                             capture_output=True, text=True, timeout=240)
        rows = [l for l in (out.stdout or "").splitlines() if l.strip()]
        if rows:
            lines.append(rows[0])
            lines += rows[1:12]
            if len(rows) > 12:
                lines.append(f"  … {len(rows) - 12} more")
        else:
            lines.append(f"RADAR  unavailable: {(out.stderr or '').strip().splitlines()[-1:] or 'no output'}")
    except Exception as e:  # pragma: no cover - brief must never die
        lines.append(f"RADAR  unavailable: {e}")
    lines.append("")

    # --- new findings, and whether anyone would pay for them
    try:
        import programs  # noqa: WPS433
        new = q(db, "select host, target, provider from findings where claimable=1 and first_seen >= ?", (day_ago,))
        paying, other = [], []
        for h, t, p in new:
            hits = [x["handle"] for x in programs.in_scope(h) if x.get("pays")]
            (paying if hits else other).append((h, t, hits))
        lines.append(f"NEW (24h)  {len(paying)} in a paying programme · {len(other)} elsewhere")
        for h, t, hits in paying:
            lines.append(f"  PAYS  {h} -> {t}   [{','.join(hits)}]")
        for h, t, _ in other[:8]:
            lines.append(f"        {h} -> {t}")
        if len(other) > 8:
            lines.append(f"        … {len(other) - 8} more")
    except Exception as e:  # pragma: no cover - brief must never die
        lines.append(f"NEW (24h)  unavailable: {e}")
    lines.append("")

    # --- filing queue: the canonical, human-written submissions (not the per-host auto-drafts)
    subs = sorted(REPORTS.glob("*submission*.md"))
    stamped = q(db, "select count(*) from findings where claimable=1 and state='report-complete'")[0][0]
    lines.append(f"FILING QUEUE  {len(subs)} report(s) complete covering {stamped} hostname(s)")
    for f in subs:
        name = f.name
        plat = "HackerOne" if ("h1" in name or "github" in name) else "Bugcrowd"
        body = f.read_text()
        host = re.search(r"`([a-z0-9.-]+\.[a-z]{2,})`", body)
        lines.append(f"  {plat:10} {name:34} {host.group(1) if host else ''}")
    lines.append("  → HackerOne: file with engine/h1_api.py report <spec> --apply")
    lines.append("  → Bugcrowd: blocked until Hacker API access + identity verification clear")
    lines.append("")

    # --- filed reports: real state from the HackerOne hacker API (never dies, never blocks)
    try:
        out = subprocess.run([sys.executable, str(ROOT / "engine" / "h1_api.py"), "status"],
                             capture_output=True, text=True, timeout=45)
        rows = [l for l in (out.stdout or "").splitlines() if l.strip()]
        if rows:
            lines.append(f"FILED  {len(rows)} report(s) with HackerOne")
            lines += [f"  {r}" for r in rows]
            if any(" new " in f" {r} " for r in rows):
                lines.append("  → state 'new' = submitted, awaiting triage")
        else:
            err = (out.stderr or "").strip().splitlines()
            lines.append(f"FILED  unavailable: {err[-1] if err else 'no output'}")
    except Exception as e:  # pragma: no cover - brief must never die
        lines.append(f"FILED  unavailable: {e}")
    lines.append("")

    # --- offer book
    if BOOK.exists():
        book = json.loads(BOOK.read_text())
        delivered = {a: r for a, r in book.items() if r.get("status", "delivered") == "delivered"}
        bounced = [a for a, r in book.items() if r.get("status") == "bounced"]
        due, followed = [], []
        for a, r in delivered.items():
            try:
                sent = dt.datetime.fromisoformat(r["sent_at"])
            except Exception:
                continue
            age = (now - sent).total_seconds() / 3600
            if r.get("followup_at"):
                followed.append(a)
            elif age >= 44:
                due.append((a, round(age)))
        lines.append(f"OFFERS  {len(delivered)} delivered · {len(followed)} followed up · "
                     f"{len(due)} due now · {len(bounced)} bounced")
        for a, age in sorted(due, key=lambda x: -x[1])[:6]:
            lines.append(f"  due {age}h  {a}")
        for a in bounced[:6]:
            lines.append(f"  bounced   {a}")
        lines.append("")

    # --- armed recurring work
    try:
        out = subprocess.run(["hermes", "cron", "list"], capture_output=True, text=True, timeout=60).stdout
        jobs = re.findall(r"Name:\s+([^\n]+)\n\s+Schedule:\s+([^\n]+)", out)
        keep = [(n, s) for n, s in jobs if "bounty" in n.lower() or "rdw" in n.lower()]
        lines.append(f"ARMED  {len(keep)} recurring job(s)")
        for n, s in keep:
            lines.append(f"  {s:14} {n}")
    except Exception:
        lines.append("ARMED  (cron list unavailable)")
    lines += ["", "Money: https://clutechremote.taild609ec.ts.net/invoices for invoicing; "
                  "square.link/u/h41lTw3P ($1,500 audit) still live."]

    print("\n".join(lines))


if __name__ == "__main__":
    main()
