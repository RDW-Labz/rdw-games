#!/usr/bin/env python3
"""Gate every draft through a live re-check immediately before it is sent.

A dangling record is a moving target: the owner can delete the CNAME at any moment, and once they do
the exposure is closed and the report becomes a false positive. Detection output is therefore never
enough on its own — the only question that matters at filing time is "does the host still point at a
target that no longer exists, right now?"

Usage:
  python3 engine/verify_finding.py host.example.com target.example.net
  python3 engine/verify_finding.py --queue          # every host in reports/FILE-NOW.md
Exit code 0 = still valid, 1 = dead/stale, 2 = inconclusive.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _dig(name: str, rtype: str) -> tuple[str, list[str]]:
    p = subprocess.run(["dig", "+noall", "+comments", "+answer", name, rtype],
                       capture_output=True, text=True, timeout=25)
    status = (re.search(r"status: ([A-Z]+)", p.stdout) or [None, "?"])[1]
    answers = [ln.split()[-1] for ln in p.stdout.splitlines()
               if ln and not ln.startswith(";") and len(ln.split()) >= 5]
    return status, answers


def check(host: str, target: str) -> tuple[int, str]:
    host, target = host.rstrip(".").lower(), target.rstrip(".").lower()
    h_status, h_ans = _dig(host, "CNAME")
    h_ans = [a.rstrip(".").lower() for a in h_ans]
    if h_status == "NXDOMAIN":
        return 1, f"DEAD — {host} itself is NXDOMAIN; record already removed, do not file"
    if target not in h_ans and h_ans:
        return 1, f"STALE — {host} no longer points at {target} (now: {', '.join(h_ans)[:90]})"
    if not h_ans:
        # No CNAME answer can also mean the record was flattened to an A record.
        a_status, a_ans = _dig(host, "A")
        if a_status == "NXDOMAIN":
            return 1, f"DEAD — {host} is NXDOMAIN; record already removed, do not file"
        if a_ans:
            return 1, f"STALE — {host} resolves to {a_ans[0]}; no CNAME to {target} any more"
        return 2, f"INCONCLUSIVE — {host} gave no CNAME and no A ({a_status})"

    t_status, t_ans = _dig(target, "A")
    t_c_status, t_c_ans = _dig(target, "CNAME")
    if t_status == "NXDOMAIN":
        return 0, f"VALID — {host} -> {target}, target NXDOMAIN (claimable)"
    if t_ans or t_c_ans:
        return 1, f"STALE — target {target} is alive again ({t_status}); owner restored it"
    if t_status == "NOERROR" and target.endswith("elasticbeanstalk.com"):
        # Elastic Beanstalk answers NODATA (NOERROR, zero answers) for a hostname nobody owns — that
        # is the available-name signature, and it is the *strongest* form of a dangling EB CNAME: the
        # name is free to register right now, not merely absent. NXDOMAIN there would mean the whole
        # zone had dropped it, which is a different (and weaker) situation.
        return 0, f"VALID — {host} -> {target}, target NOERROR/NODATA (EB hostname unclaimed, available)"
    return 2, f"INCONCLUSIVE — target {target} {t_status}, no A/CNAME answer"


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--queue":
        text = (ROOT / "reports" / "FILE-NOW.md").read_text()
        pairs = re.findall(r"`?([a-z0-9.-]+\.(?:com|net|org|io|at|br|co|ai|dev|app))`?\s*(?:->|→)\s*`?([a-z0-9.-]+)`?",
                           text, re.I)
        if not pairs:
            print("no host -> target pairs found in reports/FILE-NOW.md")
            return 2
    elif len(args) == 2:
        pairs = [(args[0], args[1])]
    else:
        print(__doc__)
        return 2

    worst = 0
    for host, target in pairs:
        rc, msg = check(host, target)
        print(f"[{ 'OK ' if rc == 0 else 'STOP' if rc == 1 else ' ???'}] {msg}")
        worst = max(worst, rc)
    return worst


if __name__ == "__main__":
    sys.exit(main())
