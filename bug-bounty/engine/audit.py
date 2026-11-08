#!/usr/bin/env python3
"""Client-ready audit report for a set of zones. The paid deliverable (PLAN.md stream 2).

    audit.py celemi.com differential.com --client "Celemi" --out audits/celemi.md

Reuses the monitor's database: run `dangling.py run --only <zones>` first so the data is fresh.
Emits markdown (pandoc/PDF ready) plus a CSV of every record examined.
"""
from __future__ import annotations

import argparse
import csv
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from dangling import DB, dig, provider_for, _status  # noqa: E402

ROOT = Path(__file__).resolve().parent


def rows_for(c, zones: list[str]):
    q = ",".join("?" * len(zones))
    return c.execute(f"""
        SELECT d.domain, h.host, n.target, n.alive
        FROM hosts h
        JOIN domains d ON d.domain = h.domain
        LEFT JOIN cnames n ON n.host = h.host
        WHERE d.domain IN ({q})
        ORDER BY d.domain, h.host""", zones).fetchall()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("zones", nargs="+")
    ap.add_argument("--client", default="")
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    c = sqlite3.connect(DB)
    rows = rows_for(c, a.zones)
    if not rows:
        raise SystemExit("no data for those zones — run dangling.py enum --only <zones> first")

    dangling = []           # (zone, host, target, provider, claimable, why, claim, cost, status)
    for zone, host, target, alive in rows:
        if not target:
            continue
        status = _status(target)
        if status == "NXDOMAIN":
            prov, ok, why, claim, cost = provider_for(target)
            dangling.append((zone, host, target, prov, ok, why, claim, cost, status))

    by_zone: dict[str, int] = {}
    for zone, *_ in rows:
        by_zone[zone] = by_zone.get(zone, 0) + 1
    claimable = [d for d in dangling if d[4]]
    outdir = ROOT / "audits"
    outdir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    md = Path(a.out) if a.out else outdir / f"audit-{'_'.join(a.zones[:3])}-{stamp}.md"

    L: list[str] = []
    L.append(f"# DNS estate sweep — {a.client or ', '.join(a.zones)}")
    L.append("")
    L.append(f"**Prepared:** {stamp}  **By:** Michael Cluer")
    L.append("")
    L.append("## Executive summary")
    L.append("")
    L.append(f"- Zones examined: **{len(by_zone)}** ({', '.join(sorted(by_zone))})")
    L.append(f"- Hostnames enumerated: **{len(rows)}**")
    L.append(f"- Hostnames with a CNAME: **{sum(1 for r in rows if r[2])}**")
    L.append(f"- CNAMEs pointing at a target that no longer resolves: **{len(dangling)}**")
    L.append(f"- Of those, in a namespace a third party can register: **{len(claimable)}**")
    L.append("")
    if claimable:
        L.append("**Act on these first.** Each is one DNS deletion away from being closed, and each "
                 "is usable by a stranger today.")
        L.append("")
        L.append("| Zone | Record | Dead target | Provider | Fix |")
        L.append("|---|---|---|---|---|")
        for zone, host, target, prov, ok, why, claim, cost, status in claimable:
            L.append(f"| {zone} | `{host}` | `{target}` | {prov} | Delete the record |")
        L.append("")
    else:
        L.append("No dangling record was found in a claimable namespace. "
                 "Dead records, where present, sit in namespaces no outsider can register.")
        L.append("")
    if dangling:
        L.append("## All records pointing at a dead target")
        L.append("")
        L.append("| Record | Target | Status | Claimable | Note |")
        L.append("|---|---|---|---|---|")
        for zone, host, target, prov, ok, why, claim, cost, status in dangling:
            L.append(f"| `{host}` | `{target}` | {status} | {'yes' if ok else 'no'} | "
                     f"{(why or '')[:90]} |")
        L.append("")
    L.append("## Remediation checklist")
    L.append("")
    L.append("1. Delete every record in the claimable list above (one DNS edit each).")
    L.append("2. Re-run this sweep after the changes to confirm nothing is left.")
    L.append("3. Add `delete the DNS records` to the teardown runbook for every hosted environment.")
    L.append("4. Repeat the sweep quarterly, or monthly if the estate changes often.")
    L.append("")
    L.append("## Method and limits")
    L.append("")
    L.append("Names come from certificate transparency logs — no brute-forcing, no wordlists. Each "
             "CNAME target is resolved and classified against a table of provider reuse behaviour "
             "built from the providers' own documentation. No request is sent to any host belonging "
             "to the client: this examines public DNS only. Ports, applications, APIs and cloud "
             "accounts are out of scope and were not tested.")
    L.append("")
    L.append("A record that resolves is not proof of safety — it can still point at a service the "
             "client no longer controls. The reverse holds too: a dead record inside a namespace "
             "nobody can register is hygiene, not exposure. Both are reported above, labelled.")
    L.append("")
    md.write_text("\n".join(L))

    csv_path = md.with_suffix(".csv")
    with csv_path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["zone", "host", "cname_target", "target_status", "claimable", "provider"])
        for zone, host, target, alive in rows:
            if target:
                prov = provider_for(target)[0] or ""
                w.writerow([zone, host, target, _status(target),
                            "yes" if ("NXDOMAIN" == _status(target) and provider_for(target)[1]) else "no",
                            prov])

    print(f"{md}  ({len(rows)} hosts, {len(dangling)} dead, {len(claimable)} claimable)")
    print(f"{csv_path}")


if __name__ == "__main__":
    main()
