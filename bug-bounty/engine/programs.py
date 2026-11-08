#!/usr/bin/env python3
"""Point the dangling-DNS engine at programs that actually pay.

The disclose.io corpus is full of VDPs — great for a free disclosure, worthless for revenue.
The paying pool lives on the bounty platforms, and their scope lists are published daily by
bounty-targets-data. This module pulls that data into the same state.db the sweep uses, so
`dangling.py run` finally runs against assets with a payout attached.

    programs.py sync                      # refresh scope data into state.db
    programs.py stats                     # how many paying programs / domains exist
    programs.py seed --limit 60           # watch N apex domains from paying programs
    programs.py lookup ind-dev.stewart.com   # which program owns this? does it pay?
    programs.py plan --limit 60           # what a sweep of that slice will cost in time

Scope data: https://github.com/arkadiyt/bounty-targets-data (public, refreshed daily).
Detection stays in dangling.py; nothing here talks to a target.
"""
from __future__ import annotations

import argparse
import json
import random
import re
from functools import lru_cache
import sqlite3
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import dangling as D  # noqa: E402  (same directory, shared state.db)

DATA = HERE / "data"
SRC = "https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/{p}_data.json"
PLATFORMS = {"hackerone": "h1", "bugcrowd": "bc", "intigriti": "it", "yeswehack": "yw"}
UA = "rdw-scope-sync/1.0"

TWO_LEVEL = {"co.uk", "com.au", "co.jp", "com.br", "co.in", "com.tr", "com.cn", "co.za",
             "co.nz", "com.mx", "com.ar", "co.kr", "com.sg", "com.hk", "com.tw", "co.il",
             "com.pl", "co.id", "com.my", "com.ph", "com.vn", "co.th", "com.ua", "co.at",
             # registry-level second levels that are themselves public suffixes
             "bet.br", "app.br", "dev.br", "net.br", "org.br", "edu.br", "art.br", "blog.br"}
# Country registries use a fixed set of second-level labels under the ccTLD (`visa.com.ni`,
# `banco.com.ve`, `x.co.cr`). Any of these as the second-to-last label means the apex is three
# labels, and getting it wrong enumerates an entire national registry instead of one company.
GENERIC_SLD = {"co", "com", "net", "org", "gob", "go", "gov", "edu", "ac", "or", "ne", "mil",
               "gen", "web", "art", "info", "biz", "name", "pro", "nic", "nom"}
HOSTRE = re.compile(r"^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$")
# Programmes list their app-store and marketplace listings as scope; those hosts belong to Apple
# and Google, not to the programme, and enumerating them produces `apple.com` as a "target zone".
NOT_OWNED = ("apps.apple.com", "itunes.apple.com", "play.google.com", "chrome.google.com",
             "addons.mozilla.org", "apps.microsoft.com", "marketplace.visualstudio.com",
             "github.com", "gitlab.com", "youtube.com", "twitter.com", "x.com", "facebook.com")
# Asset types that actually imply the programme controls DNS
DNS_TYPES = {"WILDCARD", "DOMAIN", "URL", "WEBSITE", "API", "api", "website", "url", "domain",
             "wildcard", "web-application"}


def amount(x) -> float:
    """Platforms disagree on how they publish a bounty cap: bare int, string, or {'value','currency'}."""
    if isinstance(x, dict):
        x = x.get("value")
    try:
        return float(x or 0)
    except (TypeError, ValueError):
        return 0.0


def apex(asset: str | None) -> str | None:
    """Normalise a scope entry ('https://x.example.com/path', '*.example.com') to its registrable apex."""
    a = (asset or "").strip().lower()
    a = re.sub(r"^\*+\.", "", a)
    a = re.sub(r"^[a-z][a-z0-9+.-]*://", "", a)
    a = a.split("/")[0].split("?")[0].split(":")[0].strip(".")
    if any(a == h or a.endswith("." + h) for h in NOT_OWNED):
        return None
    if not HOSTRE.match(a):
        return None
    from apex import registered
    return registered(a) or None


def db() -> sqlite3.Connection:
    c = D.db()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS programs(
      platform TEXT, handle TEXT, name TEXT, url TEXT, offers_bounty INTEGER,
      max_bounty TEXT, safe_harbor TEXT, apexes INTEGER, updated TEXT,
      PRIMARY KEY(platform, handle));
    CREATE TABLE IF NOT EXISTS scopes(
      platform TEXT, handle TEXT, asset TEXT, asset_type TEXT, bounty INTEGER,
      submission INTEGER, apex TEXT, PRIMARY KEY(platform, handle, asset));
    """)
    return c


def fetch(platform: str) -> list:
    DATA.mkdir(parents=True, exist_ok=True)
    p = DATA / f"{platform}.json"
    req = urllib.request.Request(SRC.format(p=platform), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        blob = r.read()
    p.write_bytes(blob)
    return json.loads(blob)


def parse(platform: str, raw: list):
    """Yield (program_row, [scope_rows]) for one platform's payload."""
    tag = PLATFORMS[platform]
    for p in raw:
        url = p.get("url") or ""
        name = p.get("name") or p.get("handle") or ""
        if platform == "intigriti":
            # `handle` here is the page slug ("website"); company_handle is the programme name
            handle = p.get("company_handle") or p.get("handle") or name
        else:
            handle = p.get("handle") or p.get("company_handle") or name
        scopes, apexes = [], set()
        if platform == "hackerone":
            pays = bool(p.get("offers_bounties"))
            maxb = ""
            for a in (p.get("targets") or {}).get("in_scope", []):
                if (a.get("asset_type") or "").upper() not in {"WILDCARD", "DOMAIN", "URL", "WEBSITE", "API"}:
                    continue
                ap = apex(a.get("asset_identifier"))
                rows = (tag, handle, a.get("asset_identifier") or "", a.get("asset_type") or "",
                        1 if a.get("eligible_for_bounty") else 0,
                        1 if a.get("eligible_for_submission") else 0, ap)
                scopes.append(rows)
                if ap and a.get("eligible_for_bounty"):
                    apexes.add(ap)
            safe = ""
        elif platform == "bugcrowd":
            maxb = f"{amount(p.get('max_payout')):.0f}"
            pays = amount(p.get("max_payout")) > 0
            safe = str(p.get("safe_harbor") or "")
            for a in (p.get("targets") or {}).get("in_scope", []):
                if (a.get("type") or "").lower() not in {"website", "api", "url", "domain", "wildcard",
                                                         "web-application"}:
                    continue
                item = a.get("target") or a.get("uri") or ""
                ap = apex(item)
                scopes.append((tag, handle, item, a.get("type") or "", 1 if pays else 0, 1, ap))
                if ap and pays:
                    apexes.add(ap)
        elif platform == "intigriti":
            maxb = f"{amount(p.get('max_bounty')):.0f}"
            pays = amount(p.get("max_bounty")) > 0
            safe = ""
            for a in (p.get("targets") or {}).get("in_scope", []):
                if (a.get("type") or "").lower() not in {"website", "api", "url", "domain", "wildcard",
                                                         "web-application"}:
                    continue
                item = a.get("endpoint") or a.get("target") or ""
                ap = apex(item)
                scopes.append((tag, handle, item, a.get("type") or "", 1 if pays else 0, 1, ap))
                if ap and pays:
                    apexes.add(ap)
        else:  # yeswehack
            maxb = f"{amount(p.get('max_bounty')):.0f}"
            pays = amount(p.get("max_bounty")) > 0 or amount(p.get("min_bounty")) > 0
            safe = ""
            for a in (p.get("targets") or {}).get("in_scope", []):
                if (a.get("type") or "").lower() not in {"website", "api", "url", "domain", "wildcard",
                                                         "web-application"}:
                    continue
                item = a.get("target") or ""
                ap = apex(item)
                scopes.append((tag, handle, item, a.get("type") or "", 1 if pays else 0, 1, ap))
                if ap and pays:
                    apexes.add(ap)
        yield ((tag, handle, name, url, 1 if pays else 0, maxb, safe, len(apexes),
                datetime.now(timezone.utc).strftime("%Y-%m-%d")), scopes)


def cmd_sync(a) -> None:
    c = db()
    c.execute("DELETE FROM programs")
    c.execute("DELETE FROM scopes")
    for platform in PLATFORMS:
        raw = fetch(platform)
        n = 0
        for prows, scopes in parse(platform, raw):
            c.execute("INSERT OR REPLACE INTO programs VALUES(?,?,?,?,?,?,?,?,?)", prows)
            c.executemany("INSERT OR IGNORE INTO scopes VALUES(?,?,?,?,?,?,?)", scopes)
            n += 1
        print(f"  {platform:10s} {n:4d} programs")
    c.commit()
    paying = c.execute("SELECT COUNT(*) FROM programs WHERE offers_bounty=1").fetchone()[0]
    domains = c.execute("SELECT COUNT(DISTINCT apex) FROM scopes WHERE bounty=1 AND apex IS NOT NULL").fetchone()[0]
    print(f"paying programs: {paying}   bounty-eligible apex domains: {domains}")


def cmd_stats(a) -> None:
    c = db()
    try:
        rows = c.execute("""SELECT platform, COUNT(*), SUM(offers_bounty) FROM programs
                            GROUP BY platform ORDER BY platform""").fetchall()
    except sqlite3.OperationalError:
        print("no scope data yet — run: programs.py sync")
        return
    if not rows:
        print("no scope data yet — run: programs.py sync")
        return
    print(f"{'PLATFORM':10} {'PROGRAMS':>9} {'PAYING':>7} {'DOMAINS':>8}")
    for plat, n, pay in rows:
        dom = c.execute("SELECT COUNT(DISTINCT apex) FROM scopes WHERE platform=? AND bounty=1"
                        " AND apex IS NOT NULL", (plat,)).fetchone()[0]
        print(f"{plat:10} {n:9d} {pay or 0:7d} {dom:8d}")
    watched = c.execute("SELECT COUNT(*) FROM domains WHERE tier LIKE 'bounty:%'").fetchone()[0]
    print(f"\nwatched by the sweep: {watched}")
    top = c.execute("SELECT COUNT(DISTINCT apex) FROM scopes WHERE bounty=1 AND apex IS NOT NULL").fetchone()[0]
    print(f"total bounty-eligible domains in pool: {top}")


def zone_alive(ap: str) -> bool:
    """A scope entry is only worth enumerating if the zone exists: Amazon VRP lists pseudo-domains
    like `amazon.kindle`, and DNS will never answer for those."""
    out = D.dig(["+short", "+time=3", "+tries=1", "NS", ap])
    if not out.strip():
        out = D.dig(["+short", "+time=3", "+tries=1", "A", ap])
    return bool(out.strip())


def pick(c, limit: int, platforms: list[str], shuffle: bool, order: str = "alpha",
         per_program: int = 5) -> list[tuple]:
    q = ("SELECT DISTINCT s.apex, s.platform, s.handle, p.name, p.url, p.apexes"
         " FROM scopes s JOIN programs p USING(platform, handle)"
         " WHERE s.bounty=1 AND s.apex IS NOT NULL")
    args: list = []
    if platforms:
        q += f" AND s.platform IN ({','.join('?' * len(platforms))})"
        args += platforms
    # 'big' = estates that publish the most apex domains; messier DNS, larger payout programmes
    q += " ORDER BY p.apexes DESC, s.apex" if order == "big" else " ORDER BY s.apex"
    rows = c.execute(q, args).fetchall()
    have = {r[0] for r in c.execute("SELECT domain FROM domains")}
    rows = [r[:5] for r in rows if r[0] not in have]
    # one apex can be in several programmes' scope (same company, two listings) — enumerate once
    seen_apex: set[str] = set()
    uniq = []
    for r in rows:
        if r[0] in seen_apex:
            continue
        seen_apex.add(r[0])
        uniq.append(r)
    rows = uniq
    if shuffle:
        random.Random(7).shuffle(rows)
    # one giant programme must not eat the whole slice
    seen: dict[str, int] = {}
    capped, dropped = [], 0
    for r in rows:
        key = (r[1], r[2])
        if seen.get(key, 0) >= per_program:
            dropped += 1
            continue
        seen[key] = seen.get(key, 0) + 1
        capped.append(r)
    out: list[tuple] = []
    # resolve namespaces in parallel, keep only zones that exist
    with ThreadPoolExecutor(max_workers=40) as ex:
        for row, ok in zip(capped, ex.map(lambda r: zone_alive(r[0]), capped)):
            if ok:
                out.append(row)
                if len(out) >= limit:
                    break
    if dropped:
        print(f"  (capped {dropped} extra apexes from single programmes at {per_program} each)")
    return out


def cmd_seed(a) -> None:
    c = db()
    plats = [p.strip() for p in a.platform.split(",") if p.strip()] if a.platform else []
    rows = pick(c, a.limit, plats, a.shuffle, a.order, a.per_program)
    if not rows:
        print("nothing to seed (empty pool or all already watched)")
        return
    for ap, plat, handle, name, url in rows:
        c.execute("INSERT OR REPLACE INTO domains(domain,org,policy,contact,tier) VALUES(?,?,?,?,?)",
                  (ap, f"{name} [{handle}]", url, f"{plat.upper()} program page", f"bounty:{plat}"))
    c.commit()
    print(f"seeded {len(rows)} domains from paying programs:")
    for ap, plat, handle, *_ in rows:
        print(f"  {ap:34} {plat:3} {handle}")
    print(f"\nnext: python3 engine/dangling.py enum --max-domains {len(rows)}")


def cmd_plan(a) -> None:
    c = db()
    due = c.execute("SELECT COUNT(*) FROM domains WHERE tier LIKE 'bounty:%'").fetchone()[0]
    per_domain = 7.0   # measured: aggregator call + fallback, seconds per zone
    print(f"bounty-program zones watched : {due}")
    print(f"estimated enum wall clock   : {due * per_domain / 60:.1f} min at {per_domain:.0f}s/zone")
    print("run it in the background and read progress from engine/state.db, not from a wait loop")


def cmd_lookup(a) -> None:
    c = db()
    need = a.host.lower().strip().strip(".")
    hits = []
    for depth in range(1, 4):
        cand = ".".join(need.split(".")[-depth:])
        for row in c.execute("""SELECT s.platform, s.handle, p.name, p.url, p.offers_bounty, p.max_bounty
                                FROM scopes s JOIN programs p USING(platform, handle)
                                WHERE s.apex=? """, (cand,)).fetchall():
            hits.append((cand, *row))
        if hits:
            break
    if not hits:
        print(f"{a.host}: no paying program claims this domain")
        return
    for cand, plat, handle, name, url, pays, maxb in hits:
        print(f"{cand:30} {plat:4} {handle:24} pays={'yes' if pays else 'no ':3} "
              f"max={maxb or '?':>8}  {url}")
        print(f"{'':30} {name}")


@lru_cache(maxsize=1)
def _scope_rows() -> tuple:
    """Scope rows joined to their programme, loaded once.

    in_scope() is called per host by the probes; re-reading 43k rows for each host made a 600-host
    pass take minutes and starved the DB. The scope dump only changes when `ingest` runs.
    """
    c = db()
    return tuple(c.execute("""SELECT s.platform, s.handle, p.name, p.url, p.offers_bounty,
                                     s.asset, s.asset_type, p.max_bounty
                              FROM scopes s JOIN programs p USING(platform, handle)""").fetchall())


def _reset_scope_cache() -> None:
    _scope_rows.cache_clear()


def in_scope(host: str) -> list[dict]:
    """Programmes whose published scope covers this exact host.

    An apex match is not authorisation: a programme listing `superbet.bet.br` does not cover
    `blog.luva.bet.br` just because they share a registry. A host is covered only if a wildcard
    (`*.X`) covers it, a scope entry names it exactly, or a scope URL is served from it.
    """
    host = (host or "").lower().strip().strip(".")
    rows = _scope_rows()
    hits = []
    for plat, handle, name, url, pays, asset, atype, maxb in rows:
        a_ = (asset or "").strip().lower()
        # Normalise the entry to its host part first. Platforms publish scope as URLs far more
        # often than as bare hostnames — `https://*.etoro.com`, `http://unifysquare.com/` — and the
        # old code only reached the wildcard branch when `apex()` had already understood the entry,
        # which it does not for URLs. Every wildcard published in URL form was silently dropped.
        base = re.sub(r"^[a-z][a-z0-9+.-]*://", "", a_).split("/")[0].split("?")[0].split(":")[0]
        base = base.strip().strip(".")
        covered = False
        if not base:
            continue
        if base.startswith("*."):
            root = base[2:]
            covered = bool(root) and (host == root or host.endswith("." + root))
        elif host == base:
            covered = True
        elif host == "www." + base:
            covered = True
        if covered:
            hits.append(dict(platform=plat, handle=handle, name=name, url=url,
                             pays=bool(pays), asset=asset, asset_type=atype, max_bounty=maxb))
    return hits


def cmd_check(a) -> None:
    """Is this exact host inside a published scope? An apex match is NOT authorisation: a programme
    listing `superbet.bet.br` does not cover `blog.luva.bet.br` just because they share a registry.

    A host is in scope only if a wildcard covers it (`*.X` and host endswith `.X`), a scope entry
    names the host exactly, or a scope URL is served from that host.
    """
    host = a.host.lower().strip().strip(".")
    hits = [(h["platform"], h["handle"], h["name"], h["url"], h["pays"], h["asset"], h["asset_type"])
            for h in in_scope(host)]
    if not hits:
        print(f"{host}: NOT in any published scope — do not touch it, report through a VDP or not at all")
        return
    for plat, handle, name, url, pays, asset, atype in hits:
        print(f"IN SCOPE  {plat:4} {handle:22} pays={'yes' if pays else 'no ':3} via {atype}:{asset}")
        print(f"          {name}  {url}")


def cmd_top(a) -> None:
    c = db()
    rows = c.execute("""SELECT platform, handle, name, max_bounty, apexes, url FROM programs
                        WHERE offers_bounty=1 AND apexes>0
                        ORDER BY (max_bounty='') ASC, apexes DESC LIMIT ?""", (a.limit,)).fetchall()
    print(f"{'PLAT':5} {'P/GMT':9} {'APEXES':>6}  {'MAX':>9}  HANDLE / NAME")
    for plat, handle, name, maxb, apx, url in rows:
        print(f"{plat:5} {str(handle)[:9]:9} {apx:6d}  {str(maxb)[:9]:>9}  {handle} — {name[:34]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("sync").set_defaults(fn=cmd_sync)
    sp.add_parser("stats").set_defaults(fn=cmd_stats)
    s = sp.add_parser("seed"); s.add_argument("--limit", type=int, default=50)
    s.add_argument("--platform", default=""); s.add_argument("--shuffle", action="store_true")
    s.add_argument("--order", default="alpha", choices=["alpha", "big"])
    s.add_argument("--per-program", type=int, default=5, dest="per_program")
    s.set_defaults(fn=cmd_seed)
    sp.add_parser("plan").set_defaults(fn=cmd_plan)
    s = sp.add_parser("lookup"); s.add_argument("host"); s.set_defaults(fn=cmd_lookup)
    s = sp.add_parser("check"); s.add_argument("host"); s.set_defaults(fn=cmd_check)
    s = sp.add_parser("top"); s.add_argument("--limit", type=int, default=25); s.set_defaults(fn=cmd_top)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
