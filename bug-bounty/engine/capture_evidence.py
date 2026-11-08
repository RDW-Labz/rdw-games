#!/usr/bin/env python3
"""Freeze reproducible evidence for every dead, in-scope CNAME in the claim series.

Each finding gets its own directory under evidence-takeover/<slug>/ holding the raw
command output (timestamped, unedited) plus a summary.json a triager can diff against
their own resolver. Nothing here assumes the finding is valid: if a target starts
resolving again, the run records that and drops the finding.

  python3 engine/capture_evidence.py --queue reports/free-claim-candidates.json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "evidence-takeover"


def run(cmd: list[str], timeout: int = 25) -> str:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (p.stdout or "") + (("\n[stderr] " + p.stderr) if p.stderr.strip() else "")
    except Exception as e:  # noqa: BLE001
        return f"[error] {type(e).__name__}: {e}"


def slug(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-." else "_" for c in s)


def capture(f: dict, stamp: str) -> dict:
    host, target = f["host"], f["target"]
    d = OUT / slug(host)
    d.mkdir(parents=True, exist_ok=True)

    chain = run(["dig", "+noall", "+comments", "+answer", "+authority", host, "A"])
    tgt = run(["dig", "+noall", "+comments", "+answer", "+authority", target, "A"])
    tgt_public = run(["dig", "@1.1.1.1", "+noall", "+comments", "+answer", "+authority", target, "A"])
    header = run(["curl", "-sS", "-I", "-m", "15", "--max-time", "15", f"https://{host}/"])
    body = run(["curl", "-sS", "-m", "15", "-o", "/dev/null", "-w",
                "http_code=%{http_code} ip=%{remote_ip} err=%{errormsg}", f"https://{host}/"])

    for name, text in (("dig-chain.txt", chain), ("dig-target.txt", tgt),
                       ("dig-target-1.1.1.1.txt", tgt_public),
                       ("curl-headers.txt", header), ("curl-result.txt", body)):
        (d / name).write_text(f"# captured {stamp}\n# $ {name}\n{text}\n")

    resolves = bool([ln for ln in tgt.splitlines() if "\tIN\tA" in ln or "\tIN\tCNAME" in ln])
    summary = {
        "host": host, "target": target, "provider": f["provider"], "label": f["label"],
        "claim_class": f["claim"], "in_scope": f.get("in_scope"),
        "captured": stamp, "target_resolves": resolves,
        "victim_response": body.strip(), "evidence_dir": str(d),
    }
    (d / "summary.json").write_text(json.dumps(summary, indent=1))
    return summary


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", default="reports/free-claim-candidates.json")
    ap.add_argument("--only", help="substring filter on host")
    a = ap.parse_args()

    rows = json.loads((ROOT / a.queue).read_text())
    rows = [r for r in rows if r["claim"] != "gated" and r.get("in_scope")]
    if a.only:
        rows = [r for r in rows if a.only in r["host"]]

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = []
    for r in rows:
        s = capture(r, stamp)
        flag = "LIVE AGAIN (skip)" if s["target_resolves"] else "dangling"
        print(f"{flag:16} {s['host'][:46]:46} -> {s['target'][:40]:40} {s['victim_response'][:22]}")
        out.append(s)

    (OUT / "index.json").write_text(json.dumps({"captured": stamp, "findings": out}, indent=1))
    print(f"\n{sum(1 for s in out if not s['target_resolves'])} dangling of {len(out)} captured -> {OUT}/index.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
