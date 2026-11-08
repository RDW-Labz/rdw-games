#!/usr/bin/env python3
"""Find free-tier takeover candidates by HTTP signature, not by DNS.

The Azure/Traffic-Manager findings can be proved with `dig`, because a deleted profile leaves an
NXDOMAIN. The free hosts cannot: `*.netlify.app`, `*.github.io`, `*.vercel.app`, `*.herokuapp.com` and
friends are wildcard zones, so every name resolves whether or not it is taken. DNS says nothing, and
the only question that matters is the one the provider answers over HTTP: *is anything deployed here?*

So this walks the CNAME corpus for targets under those namespaces and asks each provider directly,
classifying the answer as AVAILABLE (nothing is deployed — the name can be claimed on a free plan),
OCCUPIED (a site answers), or UNKNOWN (an unhelpful answer; never treated as claimable). Only
AVAILABLE counts, and only after the owning host has been matched to a published scope.

  python3 engine/freeclaim.py                 # probe every free-tier target in cnames
  python3 engine/freeclaim.py --ns netlify.app --limit 20
  python3 engine/freeclaim.py --json reports/freeclaim.json
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine/state.db"

# namespace -> (regex that only ever appears on a provider's "nothing here" page, human note)
SIGNATURES = {
    "netlify.app": (r"Site not found|Not Found - Request ID|site is not deployed",
                    "Netlify answers 404 'Site not found' for a subdomain with no site attached"),
    "github.io": (r"Site not found|404", "github.io is a wildcard zone; the gate is the owner account"),
    "herokuapp.com": (r"No such app|There's nothing here", "Heroku answers 'No such app' for a free name"),
    "vercel.app": (r"DEPLOYMENT_NOT_FOUND|The deployment could not be found|404: NOT_FOUND",
                   "Vercel answers DEPLOYMENT_NOT_FOUND for an unused project subdomain"),
    "pages.dev": (r"Could not find|not found|404", "Cloudflare Pages 404 for an unused project name"),
    "fly.dev": (r"This app is not deployed|not found|404", "Fly answers 'app is not deployed'"),
    "web.app": (r"Site Not Found|404", "Firebase Hosting answers 'Site Not Found'"),
    "firebaseapp.com": (r"Site Not Found|404", "Firebase Hosting answers 'Site Not Found'"),
    "onrender.com": (r"Not Found|404", "Render answers 404 for an unused service name"),
    "azurestaticapps.net": (r"404|not found|does not exist", "Static Web Apps 404 for an unused app"),
    "surge.sh": (r"project not found|404", "Surge answers 'project not found'"),
    "readthedocs.io": (r"404|not found", "ReadTheDocs 404 for an unused project"),
}

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/141.0 Safari/537.36")


def targets(ns_filter: str | None, limit: int | None) -> list[tuple[str, str]]:
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    like = " OR ".join(f"target LIKE '%.{ns}'" for ns in (SIGNATURES if not ns_filter else [ns_filter]))
    rows = c.execute(f"SELECT DISTINCT host, target FROM cnames WHERE {like}").fetchall()
    return rows[:limit] if limit else rows


class _Resp:
    """Just enough of a response object to keep the classification readable."""

    def __init__(self, status: int, text: str):
        self.status_code, self.text = status, text


def fetch(url: str) -> _Resp:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            return _Resp(r.status, r.read(6000).decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return _Resp(e.code, e.read(6000).decode("utf-8", "replace"))


def probe(target: str, sess=None) -> dict:
    ns = next((n for n in SIGNATURES if target.endswith("." + n)), None)
    if not ns:
        return {"target": target, "ns": None, "verdict": "UNKNOWN", "why": "no signature for namespace"}
    pat, note = SIGNATURES[ns]
    url = f"https://{target.rstrip('.')}/"
    try:
        r = fetch(url)
    except Exception as e:  # noqa: BLE001 - any transport failure means "do not claim"
        return {"target": target, "ns": ns, "verdict": "UNKNOWN", "why": f"request failed: {type(e).__name__}",
                "url": url}
    body = r.text[:4000]
    if ns == "github.io":
        # the repo/user namespace is the claim, so the account decides, not the page
        owner = target.split(".")[0]
        try:
            u = fetch(f"https://api.github.com/users/{owner}")
            owner_missing = u.status_code == 404
        except Exception:
            owner_missing = None
        if owner_missing is True:
            return {"target": target, "ns": ns, "verdict": "AVAILABLE",
                    "why": f"github.com/{owner} is a 404 — the owner namespace is unclaimed", "url": url,
                    "status": r.status_code}
        if r.status_code == 404 and re.search(pat, body, re.I) and owner_missing is False:
            return {"target": target, "ns": ns, "verdict": "OCCUPIED",
                    "why": f"owner {owner} exists but has no site here — repo-level claim only", "url": url,
                    "status": r.status_code}
        return {"target": target, "ns": ns, "verdict": "UNKNOWN", "why": "owner check inconclusive",
                "url": url, "status": r.status_code}
    hit = bool(re.search(pat, body, re.I))
    if r.status_code == 404 and hit:
        return {"target": target, "ns": ns, "verdict": "AVAILABLE", "why": note, "url": url,
                "status": r.status_code}
    if r.status_code == 200:
        title = re.search(r"<title[^>]*>(.*?)</title>", body, re.I | re.S)
        return {"target": target, "ns": ns, "verdict": "OCCUPIED",
                "why": "a site answers" + (f": {(title.group(1).strip()[:60])}" if title else ""),
                "url": url, "status": r.status_code}
    return {"target": target, "ns": ns, "verdict": "UNKNOWN",
            "why": f"HTTP {r.status_code}, body did not match the 'nothing deployed' signature",
            "url": url, "status": r.status_code}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ns")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--json")
    a = ap.parse_args()

    rows = targets(a.ns, a.limit)
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        res = list(ex.map(lambda t: probe(t), [t for _, t in rows]))
    by_t = {r["target"]: r for r in res}
    for host, t in rows:
        hl = by_t[t].setdefault("hosts", [])
        if host not in hl:
            hl.append(host)

    order = {"AVAILABLE": 0, "UNKNOWN": 1, "OCCUPIED": 2}
    res.sort(key=lambda r: (order[r["verdict"]], r["target"]))
    counts = {v: sum(1 for r in res if r["verdict"] == v) for v in order}
    print(f"probed {len(res)} targets across {len({r['ns'] for r in res})} namespaces: "
          + ", ".join(f"{k.lower()} {v}" for k, v in counts.items()))
    for r in res:
        if r["verdict"] != "AVAILABLE" and not a.json:
            continue
        hosts = ", ".join(r.get("hosts", [])[:4])
        print(f"  {r['verdict']:<9} {r['target']:<52} <- {hosts[:70]}")
        if r["verdict"] == "AVAILABLE":
            print(f"            {r['why']}")
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1))
        print(f"wrote {a.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
