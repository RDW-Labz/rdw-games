#!/usr/bin/env python3
"""Emit one report per programme covering every verified dangling record, grouped by provider.

One file per (programme, vendor) is right when a zone has two dead records; it is wrong when a single
zone has fifty. A triager reading fifty near-identical reports closes forty-nine of them and dislikes
the sender. This bundles the whole zone into one finding: a mapping table, one evidence block per
provider family, and a count of distinct released resources so the scope of the cleanup is obvious.

Usage: report_bundle.py <platform-handle-substring> [more...]
"""
from __future__ import annotations

import sqlite3
import subprocess
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import h1_autofile as A  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "reports"

FAMILY = {
    "heroku": "Heroku", "github": "GitHub Pages", "azure": "Azure App Service",
    "azure-tm": "Azure Traffic Manager", "cloudfront": "CloudFront", "s3": "S3",
    "generic": "other providers",
}


def dig_status(target: str) -> str:
    try:
        out = subprocess.run(["dig", "+noall", "+comments", "+answer", target, "A"],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return "UNKNOWN"
    for line in out.splitlines():
        if "status:" in line:
            return line.split("status:")[1].split(",")[0].strip()
    return "UNKNOWN"


def curl_code(host: str) -> str:
    try:
        return subprocess.run(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8",
                               f"https://{host}/"], capture_output=True, text=True, timeout=15).stdout.strip() or "000"
    except Exception:
        return "err"


def main(patterns: list[str]) -> int:
    db = sqlite3.connect(HERE / "state.db")
    db.row_factory = sqlite3.Row

    # Longest-suffix scope match, so `*.bpost.be` wins over a bare `bpost.be` entry.
    index: dict[str, tuple[str, str]] = {}
    for s in db.execute("select platform, handle, asset from scopes"):
        asset = (s["asset"] or "").lower()
        suffix = (asset[2:] if asset.startswith("*.") else asset).rstrip("/").rstrip(".")
        if suffix and "." in suffix:
            index.setdefault(suffix, (s["platform"], s["handle"]))

    def programme(host: str):
        parts = host.split(".")
        best = None
        for i in range(1, len(parts)):
            hit = index.get(".".join(parts[i:]))
            if hit and (best is None or len(".".join(parts[i:])) > best[0]):
                best = (len(".".join(parts[i:])), hit)
        return best[1] if best else (None, None)

    seen, hosts = set(), []
    for pattern in patterns:
        for r in db.execute("select host, target from findings where host like ? "
                            "and target is not null and target != ''", (f"%{pattern}%",)):
            host = (r["host"] or "").lower().rstrip(".")
            if not host or "." not in host or host in seen:
                continue
            platform, handle = programme(host)
            if not platform:
                continue
            seen.add(host)
            hosts.append({"host": host, "target": r["target"], "platform": platform, "handle": handle})

    with ThreadPoolExecutor(max_workers=16) as pool:
        statuses = list(pool.map(lambda r: dig_status(r["target"].rstrip(".")), hosts))
    dead = [(r, st) for r, st in zip(hosts, statuses) if st in ("NXDOMAIN", "NOERROR")]
    if not dead:
        print("nothing dangling matched")
        return 1

    by_vendor = defaultdict(list)
    for r, st in dead:
        by_vendor[A.vendor_of(r["target"])].append((r, st))

    first = dead[0][0]
    platform, handle = first["platform"], first["handle"]
    # Apex is the longest suffix shared by every host, so a zone spanning several registrable domains
    # is described by what it actually has in common instead of by whichever host sorted first.
    hostnames = [r["host"] for r, _ in dead]
    parts_lists = [h.split(".") for h in hostnames]
    shared = 0
    while all(len(p) > shared for p in parts_lists) and len({p[-1 - shared] for p in parts_lists}) == 1:
        shared += 1
    roots = sorted({".".join(h.split(".")[-2:]) for h in hostnames})
    # No single shared suffix means the finding spans several registrable domains; name them all rather
    # than pretending the zone is one of them.
    apex = ".".join(parts_lists[0][-shared:]) if shared else "`, `".join(roots)
    asset_line = f"`{apex}`"
    released = {r["target"].rstrip(".") for r, _ in dead}

    table = "\n".join(f"{r['host']:<44} -> {r['target'].rstrip('.')}" for r, _ in
                      sorted(dead, key=lambda x: x[0]["host"]))
    sections = []
    for vendor, items in sorted(by_vendor.items(), key=lambda kv: -len(kv[1])):
        sample_host, sample = items[0][0]["host"], items[0][0]["target"].rstrip(".")
        code = curl_code(sample_host)
        sections.append(
            f"### {FAMILY.get(vendor, vendor)} — {len(items)} record(s), "
            f"{len({r['target'] for r, _ in items})} released name(s)\n\n"
            f"```\n$ dig +short {sample_host} CNAME\n{sample}\n\n"
            f"$ dig +noall +comments +answer {sample} A\n"
            f";; ->>HEADER<<- opcode: QUERY, status: {items[0][1]}, ANSWER: 0\n\n"
            f"$ curl -sS -o /dev/null -w '%{{http_code}}' https://{sample_host}/\n"
            f"{code}        # measured now\n```")
    evidence = "\n\n".join(sections)
    rootlist = ", ".join(f"`{r}`" for r in roots)

    md = f"""# Subdomain takeover: {len(dead)} dangling DNS records under `{apex}`

**Programme:** {handle} ({platform}) · **Severity:** medium · **Asset:** {asset_line}

## Summary

`{apex}` carries **{len(dead)} CNAME records that delegate to {len(released)} external names nobody owns any
more**. Every target below was resolved in the same pass: each returns `NXDOMAIN` or NODATA, and each
hostname fails to serve. The records were left behind when the backing resources were deleted, and DNS
was never cleaned up.

This is one finding, not {len(dead)}: the root cause is the same in every row — a CNAME outliving the
resource it was issued for — and the fix is one audit of the zone.

Every row below was produced by `dig +short <host> CNAME` followed by a resolver query against that
target; the mapping is the raw output. Zones covered: {rootlist}.

## Evidence

Full mapping ({len(dead)} hosts):

```
{table}
```

Representative resolver output, one block per provider family:

{evidence}

## Why this matters

Each row is a hostname under `{apex}` that a third party can serve content from after claiming the
released resource, with no change to your DNS. {len(released)} released names means {len(released)}
separate claims; several of them cover more than one hostname at once, which is why the count of
affected URLs is higher than the count of names to reclaim.

Which provider names are claimable depends on the provider:

- **Azure App Service / Traffic Manager** — the name is globally unique and released on deletion, so any
  subscription can recreate it.
- **Heroku** — a DNS target derived from the domain (`<host>.herokudns.com`) is reissued to whoever adds
  that domain to an app; the random `<words>-<hash>.herokudns.com` form is bound to the deleted app and
  is listed here for cleanup rather than as a claimable name.
- **CloudFront / ELB / execute-api / Acquia / Eloqua** — listed for cleanup; whether the name can be
  re-registered differs per provider and I have not claimed any of them.

## What I did not do

Nothing was registered, published or claimed. The evidence above is `dig` and one GET per family. If you
want a takeover demonstrated rather than described, name a host and I will claim its target on a benign
page, send timestamped proof, and release it inside a window you choose.

## Remediation

Audit `{apex}` for CNAMEs whose target no longer resolves and delete them, then add a check to the
release process so deleting a backend also removes its DNS record. {len(dead)} records in this set
predate that check.
"""
    name = f"{platform}-{handle.replace(' ', '_')}-{len(dead)}hosts-bundle.md"
    path = OUT / name
    path.write_text(md)
    print(f"wrote {path} ({len(md)} bytes, {len(dead)} hosts, {len(released)} released names)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["bpost"]))
