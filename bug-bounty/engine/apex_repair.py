#!/usr/bin/env python3
"""Re-derive every `domain`/`apex` in the store with the Public Suffix List.

The sweep grew up on "last two labels are the domain". That is correct for `example.com` and wrong
for every second-level registry: `www.cbn.com.bo` was filed under a domain called `com.bo`, which had
inherited the tier and policy of an unrelated Visa/MercadoLibre asset, so the gate said "in scope,
submit through the programme" for a host no programme covers. The same collapse put 2,212 hosts under
`com.hr`, 1,502 under `co.cr`, 500 under `vercel.app` and 325 under `github.io` — those are suffixes,
not companies, so the tier they carried was fiction and the ones that outranked real prospects in the
queue were outranking them on that fiction.

Repairs are structural, not cosmetic:

  hosts.domain     -> registered(host)
  scopes.apex      -> registered(asset host)
  domains          -> rebuilt from scopes; a domain only keeps a programme if a scope's apex is that
                      exact domain; rows with no hosts left are dropped

  python3 engine/apex_repair.py --dry-run
  python3 engine/apex_repair.py
"""
from __future__ import annotations

import argparse
import sqlite3
import urllib.parse
from collections import Counter, defaultdict
from pathlib import Path

from apex import registered, is_public_suffix

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "engine" / "state.db"


def host_of(asset: str) -> str:
    a = (asset or "").strip().lower()
    if "://" in a:
        try:
            a = urllib.parse.urlsplit(a).hostname or ""
        except ValueError:
            return ""
    else:
        a = a.split("/")[0].split(":")[0]
    return a.rstrip(".")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    c = sqlite3.connect(str(DB), timeout=30)
    c.execute("PRAGMA journal_mode=WAL")

    # ---- 1. scopes: real apex per asset -------------------------------------------------
    scope_rows = c.execute("SELECT platform, handle, asset, apex FROM scopes").fetchall()
    scope_fix = []
    for platform, handle, asset, old in scope_rows:
        new = registered(host_of(asset))
        if new != (old or ""):
            scope_fix.append((new, platform, handle, asset))
    print(f"scopes: {len(scope_fix)} of {len(scope_rows)} apex values change")

    # ---- 2. hosts: real registrable domain ----------------------------------------------
    host_rows = c.execute("SELECT host, domain FROM hosts").fetchall()
    host_fix = [(registered(h), h) for h, d in host_rows if registered(h) != (d or "")]
    print(f"hosts : {len(host_fix)} of {len(host_rows)} domain values change")

    # ---- 3. domains: one programme per real apex, from scopes ---------------------------
    old_domains = {r[0]: r for r in c.execute(
        "SELECT domain, org, contact, tier, policy FROM domains").fetchall()}
    best: dict[str, tuple] = {}
    for platform, handle, asset, apex in c.execute("SELECT platform, handle, asset, apex FROM scopes"):
        if not apex:
            continue
        bounty = c.execute("SELECT bounty FROM scopes WHERE platform=? AND handle=? AND asset=?",
                           (platform, handle, asset)).fetchone()
        is_b = bool(bounty and bounty[0])
        rank = (1 if is_b else 0, 1 if platform == "h1" else 0)
        if apex not in best or rank > best[apex][0]:
            best[apex] = (rank, platform, handle, is_b)

    names = {(p, h): n for p, h, n in c.execute("SELECT platform, handle, name FROM programs")}

    if a.dry_run:
        sample = sorted({f[0] for f in host_fix})[:12]
        print("sample new apexes:", ", ".join(sample))
        print("would drop (public-suffix rows with no scopes):",
              sum(1 for d in old_domains if is_public_suffix(d)))
        return

    with c:
        c.executemany("UPDATE scopes SET apex=? WHERE platform=? AND handle=? AND asset=?", scope_fix)
        c.executemany("UPDATE hosts SET domain=? WHERE host=?", host_fix)

        # rebuild domains from what hosts now say
        live = defaultdict(int)
        for domain, n in c.execute("SELECT domain, count(*) FROM hosts GROUP BY domain"):
            live[domain] = n
        for domain in list(old_domains):
            if domain not in live:
                c.execute("DELETE FROM domains WHERE domain=?", (domain,))
        for domain, n in live.items():
            if domain in old_domains:
                # keep hand-curated contact/policy, but the tier must follow real coverage
                if domain in best:
                    _, platform, handle, is_b = best[domain]
                    tier = f"bounty:{platform}" if is_b else f"vdp:{platform}"
                    c.execute("UPDATE domains SET tier=?, org=?, policy=COALESCE(policy,?) WHERE domain=?",
                              (tier, names.get((platform, handle), handle),
                               f"{platform}:{handle}", domain))
                else:
                    c.execute("UPDATE domains SET tier=NULL, org=NULL WHERE domain=? AND tier LIKE 'bounty:%'",
                              (domain,))
            else:
                if domain in best:
                    _, platform, handle, is_b = best[domain]
                    tier = f"bounty:{platform}" if is_b else f"vdp:{platform}"
                    c.execute("""INSERT OR REPLACE INTO domains
                                 (domain, org, contact, tier, policy) VALUES (?,?,?,?,?)""",
                              (domain, names.get((platform, handle), handle), None, tier,
                               f"{platform}:{handle}"))
                else:
                    c.execute("INSERT OR REPLACE INTO domains (domain, org, contact, tier, policy) VALUES (?,?,?,?,?)",
                              (domain, None, None, None, None))

    print("repaired.")
    for d in ("com.bo", "com.co", "com.hr", "co.cr", "github.io", "vercel.app", "cbn.com.bo"):
        row = c.execute("SELECT domain, org, tier FROM domains WHERE domain=?", (d,)).fetchone()
        n = c.execute("SELECT count(*) FROM hosts WHERE domain=?", (d,)).fetchone()[0]
        print(f"  {d:16} hosts={n:<6} -> {row or '(row gone)'}")
    print("tier histogram:", dict(c.execute(
        "SELECT COALESCE(tier,'none'), count(*) FROM domains GROUP BY 1 ORDER BY 2 DESC").fetchall()))


if __name__ == "__main__":
    main()
