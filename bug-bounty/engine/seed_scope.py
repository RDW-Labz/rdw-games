#!/usr/bin/env python3
"""Seed the enumeration queue with every paying-scope apex that is not yet in `domains`.

The sweep was running on 823 zones while the scope table already carried 2,236 distinct paying
apexes — 1,640 paying zones had never been looked at. That is the binding constraint: takeover
density is ~1 per 800 zones, so the queue matters far more than how deep any single zone is walked.

Filters out the things scope tables contain that are not hostnames (CIDR ranges, regex artefacts,
`(com|co.uk|ca)` alternation, entries with spaces) so enumeration is not wasted on garbage.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

DB = Path(__file__).with_name("state.db")
HOSTNAME = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
# Public suffixes are not zones. Scope tables list entries like `co.uk` and `com.mx` when a programme
# writes its asset as `*.co.uk`; enumerating them queries a registry, returns nothing and wastes a slot.
PUBLIC_SUFFIX = {
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
    "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "ad.jp", "ed.jp", "gr.jp", "lg.jp",
    "com.br", "net.br", "org.br", "gov.br", "edu.br",
    "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
    "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "ac.in", "edu.in", "res.in", "gov.in",
    "com.mx", "net.mx", "org.mx", "edu.mx", "gob.mx",
    "com.tr", "net.tr", "org.tr", "edu.tr", "gov.tr", "av.tr", "bel.tr", "biz.tr", "info.tr",
    "co.za", "net.za", "org.za", "gov.za", "ac.za", "web.za",
    "com.sg", "net.sg", "org.sg", "edu.sg", "gov.sg", "per.sg",
    "co.il", "org.il", "net.il", "ac.il", "gov.il", "muni.il",
    "com.ar", "net.ar", "org.ar", "edu.ar", "gob.ar",
    "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn",
    "com.tw", "net.tw", "org.tw", "edu.tw", "gov.tw", "idv.tw",
    "co.kr", "or.kr", "ne.kr", "re.kr", "go.kr", "ac.kr", "pe.kr",
    "com.hk", "net.hk", "org.hk", "edu.hk", "gov.hk", "idv.hk",
    "co.id", "net.id", "or.id", "web.id", "ac.id", "go.id", "sch.id", "mil.id", "my.id", "biz.id",
    "com.my", "net.my", "org.my", "edu.my", "gov.my",
    "com.ph", "net.ph", "org.ph", "edu.ph", "gov.ph",
    "com.vn", "net.vn", "org.vn", "edu.vn", "gov.vn", "biz.vn", "info.vn",
    "com.pk", "net.pk", "org.pk", "edu.pk", "gov.pk", "web.pk",
    "com.ua", "net.ua", "org.ua", "edu.ua", "gov.ua", "kiev.ua",
    "co.th", "in.th", "or.th", "ac.th", "go.th", "net.th",
    "com.eg", "net.eg", "org.eg", "edu.eg", "gov.eg",
    "com.sa", "net.sa", "org.sa", "edu.sa", "gov.sa", "med.sa", "pub.sa",
    "com.ng", "net.ng", "org.ng", "edu.ng", "gov.ng",
    "com.co", "net.co", "org.co", "edu.co", "gov.co", "nom.co",
    "com.pe", "net.pe", "org.pe", "edu.pe", "gob.pe", "nom.pe",
    "com.ec", "net.ec", "org.ec", "edu.ec", "gob.ec",
    "com.uy", "net.uy", "org.uy", "edu.uy", "gub.uy",
    "com.ve", "net.ve", "org.ve", "edu.ve", "gob.ve",
    "com.py", "net.py", "org.py", "edu.py", "gov.py",
    "com.bo", "net.bo", "org.bo", "edu.bo", "gob.bo",
    "com.do", "net.do", "org.do", "edu.do", "gob.do",
    "com.gt", "net.gt", "org.gt", "edu.gt", "gob.gt",
    "com.sv", "net.sv", "org.sv", "edu.sv", "gob.sv",
    "com.hn", "net.hn", "org.hn", "edu.hn", "gob.hn",
    "com.ni", "net.ni", "org.ni", "edu.ni", "gob.ni",
    "com.pa", "net.pa", "org.pa", "edu.pa", "gob.pa",
    "com.cy", "net.cy", "org.cy", "ac.cy", "gov.cy",
    "com.mt", "net.mt", "org.mt", "edu.mt", "gov.mt",
    "com.gr", "net.gr", "org.gr", "edu.gr", "gov.gr",
    "com.pl", "net.pl", "org.pl", "edu.pl", "gov.pl", "waw.pl",
    "co.at", "or.at", "ac.at", "gv.at",
    "com.ru", "net.ru", "org.ru", "msk.ru", "spb.ru",
    "com.es", "nom.es", "org.es", "gob.es", "edu.es",
    "com.pt", "org.pt", "edu.pt", "gov.pt",
    "com.fr", "asso.fr", "nom.fr", "gouv.fr",
    "co.it", "gov.it", "edu.it",
    "co.no", "priv.no",
    "com.se", "org.se", "pp.se",
    "com.dk", "org.dk",
    "com.fi", "org.fi",
    "com.az", "net.az", "org.az", "edu.az", "gov.az",
    "com.kz", "net.kz", "org.kz", "edu.kz", "gov.kz",
    "com.uz", "org.uz", "net.uz",
    "com.ge", "net.ge", "org.ge", "edu.ge", "gov.ge",
    "com.am", "net.am", "org.am",
    "com.bd", "net.bd", "org.bd", "edu.bd", "gov.bd",
    "com.lk", "net.lk", "org.lk", "edu.lk", "gov.lk",
    "com.np", "org.np", "edu.np", "gov.np",
    "com.mm", "net.mm", "org.mm", "edu.mm", "gov.mm",
    "com.kh", "net.kh", "org.kh", "edu.kh", "gov.kh",
    "com.la", "net.la", "org.la", "edu.la", "gov.la",
    "com.bn", "net.bn", "org.bn", "edu.bn", "gov.bn",
    "com.mo", "net.mo", "org.mo", "edu.mo", "gov.mo",
    "com.mv", "net.mv", "org.mv", "edu.mv", "gov.mv",
    "com.af", "net.af", "org.af", "edu.af", "gov.af",
    "com.iq", "net.iq", "org.iq", "edu.iq", "gov.iq",
    "com.ir", "net.ir", "org.ir", "ac.ir", "gov.ir",
    "com.sy", "net.sy", "org.sy", "edu.sy", "gov.sy",
    "com.jo", "net.jo", "org.jo", "edu.jo", "gov.jo",
    "com.lb", "net.lb", "org.lb", "edu.lb", "gov.lb",
    "com.om", "net.om", "org.om", "edu.om", "gov.om",
    "com.qa", "net.qa", "org.qa", "edu.qa", "gov.qa",
    "com.bh", "net.bh", "org.bh", "edu.bh", "gov.bh",
    "com.kw", "net.kw", "org.kw", "edu.kw", "gov.kw",
    "com.ae", "net.ae", "org.ae", "ac.ae", "gov.ae", "sch.ae",
}

JUNK = re.compile(r"[()|\\*\s,/]|^\d+\.\d+$")


def to_apex(asset: str) -> str:
    a = (asset or "").strip().lower().rstrip(".")
    a = re.sub(r"^https?://", "", a).split("/")[0].split(":")[0]
    a = a.lstrip("*.")
    if not a or JUNK.search(a):
        return ""
    if not HOSTNAME.match(a):
        return ""
    labels = a.split(".")
    if labels[-1].isdigit():          # bare IPv4
        return ""
    if len(labels) < 2:
        return ""
    base = ".".join(labels[-2:])
    if base in PUBLIC_SUFFIX:
        # `vivo.com.br` is a zone, `com.br` is a registry: keep the third label when there is one,
        # otherwise the asset really was the public suffix and there is nothing to enumerate.
        if len(labels) < 3:
            return ""
        base = ".".join(labels[-3:])
        if base in PUBLIC_SUFFIX:
            return ""
    return base


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--apply", action="store_true", help="write rows (default: dry run)")
    a = p.parse_args()

    c = sqlite3.connect(DB, timeout=30)
    c.execute("PRAGMA busy_timeout=30000")
    have = {r[0] for r in c.execute("SELECT domain FROM domains")}
    rows = c.execute("""SELECT s.platform, s.asset, p.name, p.url
                        FROM scopes s JOIN programs p USING(platform, handle)
                        WHERE s.bounty = 1 AND s.asset IS NOT NULL""").fetchall()

    seen: dict[str, tuple[str, str, str]] = {}
    junk = 0
    for platform, asset, name, url in rows:
        ap = to_apex(asset)
        if not ap:
            junk += 1
            continue
        seen.setdefault(ap, (platform, name, url))

    fresh = {d: v for d, v in seen.items() if d not in have}
    by_tier: dict[str, int] = {}
    for d, (platform, _, _) in fresh.items():
        by_tier["bounty:" + platform] = by_tier.get("bounty:" + platform, 0) + 1

    print(f"scope rows {len(rows)} → usable apexes {len(seen)} → not yet enumerated {len(fresh)}")
    print(f"rejected as non-hostname: {junk}")
    for t, n in sorted(by_tier.items(), key=lambda kv: -kv[1]):
        print(f"  {t:14} {n}")

    if a.apply:
        before = c.total_changes
        for d, (platform, name, url) in fresh.items():
            c.execute("""INSERT OR IGNORE INTO domains(domain, org, policy, contact, tier)
                         VALUES(?,?,?,?,?)""", (d, name or "", url or "", "security",
                                                 "bounty:" + platform))
        c.commit()
        print(f"inserted {c.total_changes - before} domain rows")
    else:
        print("dry run — pass --apply to write")


if __name__ == "__main__":
    main()
