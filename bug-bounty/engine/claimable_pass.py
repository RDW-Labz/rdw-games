#!/usr/bin/env python3
"""Second-generation claimability pass: only namespaces where a stranger can type the whole label.

The first pass queued 103 "dead public ELBs" and that queue is zero, because an Application Load
Balancer's DNS name is `<chosen-name>-<aws-generated-id>` — re-create the name and AWS mints a
different id, so the FQDN can never match the dangling target. The lesson generalises: the gate is
**name reproducibility**, i.e. can a customer type the entire label left of the provider's zone?

That leaves four namespaces where the answer is yes:

  <env>.<region>.elasticbeanstalk.com   the environment name is chosen; region is chosen
  <bucket>.s3.amazonaws.com             (and the regional/s3-website spellings) bucket name is chosen
  <app>.azurewebsites.net               the app name is chosen
  <name>.trafficmanager.net             the profile's relativeName is chosen — but a disabled
                                        profile still owns the name, so creation must be attempted

Everything here is measured, never assumed: the target has to answer nothing right now, the victim
hostname has to sit inside a published scope, and the row records which namespace it belongs to so the
claim step knows what it can actually create.

  python3 engine/claimable_pass.py --json reports/claimable-queue.json
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine/state.db"

REGIONS = ("us-east-1|us-east-2|us-west-1|us-west-2|ca-central-1|sa-east-1|eu-west-1|eu-west-2|"
           "eu-west-3|eu-central-1|eu-north-1|eu-south-1|ap-south-1|ap-southeast-1|ap-southeast-2|"
           "ap-northeast-1|ap-northeast-2|ap-northeast-3|ap-east-1|af-south-1|me-south-1|"
           "il-central-1|ap-southeast-3|ap-south-2|eu-central-2|eu-south-2|ap-southeast-4")

PATTERNS = [
    ("eb", re.compile(r"^(?P<label>[a-z0-9][a-z0-9-]{0,38}[a-z0-9])\."
                      rf"(?P<region>{REGIONS})\.elasticbeanstalk\.com$")),
    ("s3", re.compile(r"^(?P<label>[a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\."
                      r"(?:s3\.amazonaws\.com|s3[.-][a-z0-9-]+\.amazonaws\.com)$")),
    ("azureweb", re.compile(r"^(?P<label>[a-z0-9][a-z0-9-]{0,59})\.azurewebsites\.net$")),
    ("cloudapp", re.compile(r"^(?P<label>[a-z0-9][a-z0-9-]{0,59})\.cloudapp\.net$")),
    ("tm", re.compile(r"^(?P<label>[a-z0-9][a-z0-9-]{0,62})\.trafficmanager\.net$")),
]


# Azure classic Cloud Services got a GUID at deploy time and the platform never reissues one, so nobody —
# us or anyone else — can register `1ab06bbd-….cloudapp.net` again. It is a dead delegation, not a takeover,
# and five bpost hosts sat in the queue on exactly this. Treat a GUID label as unclaimable.
UUID_LABEL = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def classify(target: str):
    t = (target or "").lower().rstrip(".")
    for kind, rx in PATTERNS:
        m = rx.match(t)
        if m:
            if kind == "cloudapp" and UUID_LABEL.match(m.group("label")):
                return None, None
            return kind, m.group("label")
    return None, None


def dig(name: str) -> str:
    try:
        p = subprocess.run(["dig", "+short", "+time=4", "+tries=2", name],
                           capture_output=True, text=True, timeout=12)
        return " ".join(p.stdout.split())[:200]
    except Exception:
        return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="reports/claimable-queue.json")
    ap.add_argument("--workers", type=int, default=32)
    a = ap.parse_args()

    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    edges = set(db.execute("select host, target from cnames").fetchall())
    edges |= set(db.execute("select apex, cname from apex_dns where cname != ''").fetchall())

    cand = []
    for host, target in edges:
        kind, label = classify(target)
        if kind:
            cand.append({"host": host, "target": target.lower().rstrip("."), "kind": kind, "label": label})
    print(f"CNAME edges into a label-reproducible namespace: {len(cand)}  "
          f"(by kind {dict(Counter(c['kind'] for c in cand))})")

    targets = sorted({c["target"] for c in cand})
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        res = dict(ex.map(lambda t: (t, dig(t)), targets))
    dead = {t for t, r in res.items() if not r}
    print(f"distinct targets {len(targets)}  dead {len(dead)}")

    sys.path.insert(0, str(ROOT / "engine"))
    from scope_cover import covers
    scopes = db.execute("select platform, handle, asset from scopes").fetchall()
    queue = []
    for c in cand:
        if c["target"] not in dead:
            continue
        hit = next(((p, h, at) for p, h, at in scopes if covers(at, c["host"])), None)
        if not hit:
            continue
        c["scope"] = f"{hit[0]}:{hit[1]} via {hit[2]}"
        queue.append(c)

    queue.sort(key=lambda r: (r["kind"], r["scope"]))
    print(f"dead AND in a published scope: {len(queue)}")
    for kind, n in Counter(r["kind"] for r in queue).most_common():
        print(f"  {kind:9} {n}")
    for r in queue[:30]:
        print(f"  {r['kind']:9} {r['host'][:42]:42} -> {r['label'][:34]:34} [{r['scope'][:38]}]")
    Path(ROOT / a.json).write_text(json.dumps(queue, indent=1))
    print("wrote", a.json)

    # Persist, or the pass is a cul-de-sac: `filing_queue.py`, the board's QUEUE line and every filing rail
    # read `findings`, and a candidate that only ever exists in a JSON file is invisible to all of them.
    # Claimable=1 means "dead target inside a published scope", nothing stronger — the report generators
    # still re-measure DNS and re-check scope before they write anything.
    w = sqlite3.connect(DB)
    added = 0
    for r in queue:
        cur = w.execute(
            """insert into findings (host, target, provider, claimable, why, state)
               values (?,?,?,1,'dead target inside a published scope', 'new')
               on conflict(host, target) do update set
                 claimable = 1,
                 why = excluded.why,
                 state = case when findings.state in ('new','queued') then 'new' else findings.state end""",
            (r["host"], r["target"], r["target"].split(".", 1)[1] if "." in r["target"] else r["target"]))
        added += cur.rowcount if cur.rowcount > 0 else 0
    w.commit()
    w.close()
    print(f"findings upserted: {added}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
