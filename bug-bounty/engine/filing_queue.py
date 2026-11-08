#!/usr/bin/env python3
"""Turn verified dead delegations in `findings` into filing-ready report files, one per
(platform, program, upstream namespace).

Why this exists: the report text used to be assembled by hand, and a hand-assembled host→target
table is how `wfmnaposps.starbucks.com` ended up paired with the wrong Traffic Manager profile.
Here every pair is read from `state.db` and every target is re-measured before it is written down,
so what lands in the report is what the resolver said in this run.

Anything that resolves (LIVE) is dropped rather than filed: a CNAME whose target answers is not a
takeover, and filing it costs a trial report and the account's credibility.
"""
from __future__ import annotations

import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import json

import h1_autofile as A
import h1_scope as H1S
from claimable_pass import UUID_LABEL

HERE = Path(__file__).resolve().parent
DB = HERE / "state.db"
OUT = HERE.parent / "reports"

# A live name inside each vendor's namespace, used to prove the zone is healthy rather than dead.
CONTROLS = {
    "azure-tm": ("mco-rc-rc2.trafficmanager.net", None),
    "azure": ("ninesapp-app-service.azurewebsites.net", None),
}


def dns(target: str) -> tuple[str, int]:
    try:
        out = subprocess.run(["dig", "+noall", "+comments", "+answer", target, "A"],
                             capture_output=True, text=True, timeout=8).stdout
    except Exception:
        return ("ERR", 0)
    status = "?"
    for line in out.splitlines():
        if "status:" in line:
            status = line.split("status:")[1].split(",")[0].strip()
            break
    answers = [ln for ln in out.splitlines() if ln.strip() and not ln.startswith(";")]
    return (status, len(answers))


def live_control(vendor: str) -> tuple[str, str] | None:
    """Resolve the vendor's control name; skip the control line if it is not answering today."""
    name, _ = CONTROLS.get(vendor, (None, None))
    if not name:
        return None
    status, n = dns(name)
    if n == 0:
        return None
    out = subprocess.run(["dig", "+short", name], capture_output=True, text=True, timeout=8).stdout
    first = next((ln.strip() for ln in out.splitlines() if ln.strip()), None)
    return (name, first) if first else None


def program_from_queue(host: str):
    """The local `scopes` table and `claimable_pass.py` do not agree on wildcards, so a host the pass found
    inside `h1:aon via *.aon-hugeops.uk` can still miss `program_for` and read as "no programme scope
    matches". The pass already knows the platform and handle, so borrow them instead of dropping the find."""
    try:
        rows = json.loads((OUT / "claimable-queue.json").read_text())
    except Exception:
        return None
    for r in rows:
        if (r.get("host") or "").strip().lower().rstrip(".") != host:
            continue
        scope = r.get("scope") or ""
        platform, _, rest = scope.partition(":")
        handle = rest.split(" via")[0].strip()
        asset = ("via" in rest and rest.split("via", 1)[1].strip()) or host
        if platform and handle:
            return (platform, handle, asset, False)
    return None


def program_for(host: str, scopes) -> tuple[str, str, str, object] | None:
    """Longest-suffix match wins, so `*.emakina.at` beats a bare `at` style scope."""
    best = None
    for s in scopes:
        asset = (s["asset"] or "").lower()
        suffix = asset[2:] if asset.startswith("*.") else asset
        suffix = suffix.rstrip(".")
        if not suffix or not (host == suffix or host.endswith("." + suffix)):
            continue
        if best is None or len(suffix) > best[0]:
            best = (len(suffix), s["platform"], s["handle"], asset, s["bounty"])
    return None if best is None else (best[1], best[2], best[3], best[4])


def main() -> int:
    import sqlite3

    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    # `drafted` used to be the only door in, and only `dangling.py report` ever set it — so candidates that
    # `claimable_pass.py` found and persisted as `new` were filed into the database and then never queued.
    # A claimable row is fair game here whatever its state, because this function re-measures DNS and asks
    # HackerOne about scope before it writes a report; `new` just means nobody has touched it yet.
    rows = db.execute(
        "select host, target, provider, state from findings "
        "where state in ('drafted', 'report-complete') "
        "   or (claimable = 1 and state = 'new') order by host").fetchall()
    scopes = db.execute("select platform, handle, asset, bounty, apex from scopes").fetchall()
    # Hosts that already have a report are not "queued" — re-listing them invites a duplicate filing,
    # which is the one thing a programme punishes harder than a slow report (4179852 was closed duplicate).
    filed_hosts: set[str] = set()
    try:
        import re as _re
        for f in json.loads((OUT / "filed.json").read_text()):
            for h in f.get("hosts") or []:
                filed_hosts.add(h.strip().lower().rstrip("."))
            # The earliest filings kept no `hosts` list — only a title and a free-text finding. The
            # hostnames in that prose are still the assets already under a report (`nines.githubapp.com`
            # went out as 4168910 and reappeared in the queue because of this gap).
            for text in (f.get("title") or "", str(f.get("finding") or ""), f.get("cname_target") or ""):
                for h in _re.findall(r"[a-z0-9][a-z0-9.-]*\.[a-z]{2,}", text.lower()):
                    filed_hosts.add(h.rstrip("."))
    except Exception:
        pass
    # Older filings predate `hosts` in filed.json (4168910 records only a title), so the database is the
    # second source — but `findings.report` usually holds a *local draft path*
    # (`engine/reports/...md`), not a platform URL. Only a markdown file state='filed' with an http report
    # means a real filing; treating every draft path as filed emptied the whole queue (54 "already filed",
    # zero report files).
    for r in db.execute("select host from findings where state = 'filed' and report like 'http%'"):
        if r["host"]:
            filed_hosts.add(r["host"].strip().lower().rstrip("."))

    # hold-queue.json holds targets that were already asked about and refused (Spotify answered 403 to the
    # Heroku probe) or deliberately paused (Expedia BBP). Queueing them again manufactures a duplicate,
    # which is the one thing a programme punishes harder than a slow report.
    hold_hosts: set[str] = set()
    hold_targets: set[str] = set()
    try:
        for h in json.loads((OUT / "hold-queue.json").read_text()):
            t = (h.get("target") or "").strip().lower().rstrip(".")
            if t:
                hold_targets.add(t)
            for x in h.get("hosts") or []:
                hold_hosts.add(x.strip().lower().rstrip("."))
    except Exception:
        pass

    groups: dict[tuple[str, str, str], list[tuple[str, str]]] = defaultdict(list)
    skipped = []
    for r in rows:
        host = (r["host"] or "").strip().lower().rstrip(".")
        target = (r["target"] or "").strip().lower().rstrip(".")
        if not host or not target or "." not in target:
            skipped.append((host or "?", "no usable target"))
            continue
        if UUID_LABEL.match(target.split(".", 1)[0]) and target.endswith(".cloudapp.net"):
            skipped.append((host, "GUID-named Azure Cloud Service — the platform never reissues the name, so nothing can be claimed"))
            continue
        if A.is_provider_apex(target):
            # `login-mediaspace.unrealengine.com CNAME azurewebsites.net` — no app label means nobody can
            # claim anything; the record is misconfigured, not taken over, and the report would be false.
            skipped.append((host, "CNAME names the provider zone itself — no app name to claim"))
            continue
        if host in hold_hosts or target in hold_targets:
            skipped.append((host, "on hold-queue.json — already refused or paused; re-filing would be a duplicate"))
            continue
        if host in filed_hosts:
            skipped.append((host, "already filed — see reports/filed.json"))
            continue
        status, answers = dns(target)
        if answers:
            skipped.append((host, f"target answers ({status}, {answers}) — not a takeover"))
            continue
        match = program_for(host, scopes) or program_from_queue(host)
        if match is None:
            skipped.append((host, "no programme scope matches"))
            continue
        platform, handle, asset, bounty = match
        if platform.lower() in ("h1", "hackerone"):
            # The local `scopes` table is good enough to *find* a programme and useless for *filing*: it
            # over-claims, so `dev.customerservice-ccp.priceline.com` matched priceline's apex while none of
            # the programme's 58 live assets contains it. Ask HackerOne itself (cached 24h) before queueing,
            # because an out-of-scope filing is a closed report and a spent bit of the account's credibility.
            try:
                live = H1S.match(handle, host)
            except Exception as exc:  # network/API failure must not silently drop a real finding
                live = {"error": str(exc)[:80]}
            if live is None:
                skipped.append((host, f"live HackerOne scope check: not covered by any eligible {handle} asset"))
                continue
            if "error" not in live and live.get("asset"):
                asset = live["asset"]
            if "error" in live:
                skipped.append((host, f"live scope check failed ({live['error']}) — queued on the local table only"))
                groups[(platform, handle.strip(), A.vendor_of(target))].append((host, target))
                continue
        groups[(platform, handle.strip(), A.vendor_of(target))].append((host, target))

    OUT.mkdir(exist_ok=True)
    index = ["# Filing queue", "", "Generated from `engine/state.db` with every target re-measured.", ""]
    for (platform, handle, vendor), pairs in sorted(groups.items()):
        apex = pairs[0][0].split(".", 1)[1] if pairs[0][0].count(".") > 1 else pairs[0][0]
        md = A.report_md([h for h, _ in pairs], pairs[0][1], apex, pairs=pairs,
                         control=live_control(vendor))
        name = f"{platform}-{handle}-{vendor}-{len(pairs)}hosts.md".replace("/", "_")
        path = OUT / name
        path.write_text(md)
        index.append(f"- **{platform}/{handle}** · {vendor} · {len(pairs)} host(s) → `{name}`")
        print(f"wrote {name} ({len(md)} bytes)")

    live_note = [f"- skip `{h}`: {why}" for h, why in skipped]
    if live_note:
        index += ["", "## Not filed", ""] + live_note
    (OUT / "QUEUE.md").write_text("\n".join(index) + "\n")
    print(f"\n{len(groups)} report file(s); {len(skipped)} skipped. Index: {OUT / 'QUEUE.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
