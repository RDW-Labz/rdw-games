#!/usr/bin/env python3
"""Dead CNAME targets on providers a stranger can claim for $0 (no card, no trial call).

The paid-PoC problem: azurewebsites / trafficmanager / elasticbeanstalk / s3 all need a
funded cloud account before you can prove control. The providers below can be claimed with
a free account and, crucially, the claim is *name-based*: the attacker re-creates the exact
label in the provider's namespace and the victim's CNAME starts resolving to them. Providers
that gate binding behind a TXT challenge (heroku custom domains, azure custom domain asuid,
github pages custom domains) are deliberately excluded even when they appear in DNS.

  python3 engine/free_claim_sweep.py --json reports/free-claim-candidates.json
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

# provider -> (regex on the CNAME target, the label the claimer must own, free claim?)
PROVIDERS = [
    ("github.io",     re.compile(r"^(?P<label>[a-z0-9-]+)\.github\.io$"),                      "free"),
    ("netlify.app",   re.compile(r"^(?P<label>[a-z0-9-]+)\.netlify\.app$"),                    "free"),
    ("netlify",       re.compile(r"^(?P<label>[a-z0-9-]+)\.netlify\.com$"),                    "free"),
    ("vercel.app",    re.compile(r"^(?P<label>[a-z0-9-]+)\.vercel\.app$"),                     "free"),
    ("now.sh",        re.compile(r"^(?P<label>[a-z0-9-]+)\.now\.sh$"),                         "free"),
    ("surge.sh",      re.compile(r"^(?P<label>[a-z0-9-]+)\.surge\.sh$"),                       "free"),
    ("statuspage",    re.compile(r"^(?P<label>[a-z0-9-]+)\.statuspage\.io$"),                  "free"),
    ("zendesk",       re.compile(r"^(?P<label>[a-z0-9-]+)\.zendesk\.com$"),                    "trial"),
    ("readme.io",     re.compile(r"^(?P<label>[a-z0-9-]+)\.readme\.io$"),                      "free"),
    ("readmessl",     re.compile(r"^(?P<label>[a-z0-9-]+)\.readmessl\.com$"),                  "free"),
    ("freshdesk",     re.compile(r"^(?P<label>[a-z0-9-]+)\.freshdesk\.com$"),                  "trial"),
    ("unbounce",      re.compile(r"^(?P<label>[a-z0-9-]+)\.unbouncepages\.com$"),              "trial"),
    ("cargo.site",    re.compile(r"^(?P<label>[a-z0-9-]+)\.cargo\.site$"),                     "free"),
    ("wordpress",     re.compile(r"^(?P<label>[a-z0-9-]+)\.wordpress\.com$"),                  "free"),
    ("helpscout",     re.compile(r"^(?P<label>[a-z0-9-]+)\.helpscoutdocs\.com$"),              "trial"),
    ("tilda",         re.compile(r"^(?P<label>[a-z0-9-]+)\.tilda\.ws$"),                       "free"),
    ("gitbook",       re.compile(r"^(?P<label>[a-z0-9-]+)\.gitbook\.io$"),                     "free"),
    ("webflow",       re.compile(r"^(?P<label>[a-z0-9-]+)\.webflow\.io$"),                     "free"),
    ("bubble",        re.compile(r"^(?P<label>[a-z0-9-]+)\.bubbleapps\.io$"),                  "free"),
    ("pantheonsite",  re.compile(r"^(?P<label>[a-z0-9-]+)\.pantheonsite\.io$"),                "gated"),
    ("myshopify",     re.compile(r"^(?P<label>[a-z0-9-]+)\.myshopify\.com$"),                  "gated"),
    ("herokudns",     re.compile(r"^(?P<label>[a-z0-9.-]+)\.herokudns\.com$"),                 "gated"),
    ("herokuapp",     re.compile(r"^(?P<label>[a-z0-9-]+)\.herokuapp\.com$"),                  "gated"),
    ("azurewebsites", re.compile(r"^(?P<label>[a-z0-9-]+)\.azurewebsites\.net$"),              "paid"),
    ("trafficmanager",re.compile(r"^(?P<label>[a-z0-9-]+)\.trafficmanager\.net$"),             "paid"),
    ("beanstalk",     re.compile(r"^(?P<label>[a-z0-9-]+)\.[a-z0-9-]+\.elasticbeanstalk\.com$"),"paid"),
    ("s3",            re.compile(r"^(?P<label>[a-z0-9.-]+)\.s3[.-][a-z0-9-]*\.?amazonaws\.com$"),"paid"),
]


def classify(target: str):
    t = (target or "").lower().rstrip(".")
    for name, rx, claim in PROVIDERS:
        m = rx.match(t)
        if m:
            return name, m.group("label"), claim
    return None, None, None


def dig(name: str) -> str:
    try:
        p = subprocess.run(["dig", "+short", "+time=4", "+tries=1", name, "A"],
                           capture_output=True, text=True, timeout=12)
        return " ".join(p.stdout.split())[:200]
    except Exception:
        return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="reports/free-claim-candidates.json")
    ap.add_argument("--workers", type=int, default=32)
    a = ap.parse_args()

    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    edges = set(db.execute("select host, target from cnames").fetchall())
    edges |= set(db.execute("select apex, cname from apex_dns where cname != ''").fetchall())

    cand = []
    for host, target in edges:
        name, label, claim = classify(target)
        if name:
            cand.append({"host": host, "target": target.lower().rstrip("."),
                         "provider": name, "label": label, "claim": claim})
    print(f"edges into a known provider namespace: {len(cand)}  "
          f"by provider {dict(Counter(c['provider'] for c in cand))}")

    targets = sorted({c["target"] for c in cand})
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        res = dict(ex.map(lambda t: (t, dig(t)), targets))
    dead = {t for t, r in res.items() if not r}
    print(f"distinct targets {len(targets)}  dead now {len(dead)}")

    sys.path.insert(0, str(ROOT / "engine"))
    from scope_cover import covers
    scopes = db.execute("select platform, handle, asset from scopes").fetchall()

    rows = []
    for c in cand:
        if c["target"] not in dead:
            continue
        hit = next(((p, h, at) for p, h, at in scopes if covers(at, c["host"])), None)
        c["in_scope"] = f"{hit[0]}:{hit[1]} via {hit[2]}" if hit else None
        rows.append(c)

    rows.sort(key=lambda r: ({"free": 0, "trial": 1, "paid": 2, "gated": 3}[r["claim"]],
                             r["provider"], r["host"]))
    print(f"dead now: {len(rows)}   free-claimable: {sum(1 for r in rows if r['claim']=='free')}"
          f"   in scope: {sum(1 for r in rows if r['in_scope'])}")
    print(f"{'claim':6} {'provider':13} {'host':44} scope")
    for r in rows[:60]:
        print(f"{r['claim']:6} {r['provider']:13} {r['host'][:44]:44} {(r['in_scope'] or '-')[:44]}")
    Path(ROOT / a.json).write_text(json.dumps(rows, indent=1))
    print("wrote", a.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
