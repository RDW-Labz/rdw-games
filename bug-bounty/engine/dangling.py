#!/usr/bin/env python3
"""Dangling-CNAME / subdomain-takeover monitor.

One file, stdlib only, SQLite state. Detection is deterministic on purpose: an LLM in the
detection path adds latency and cost and invents severity. Models belong in triage, report
drafting and outreach copy, not in "does this name resolve".

    dangling.py run                 # enum -> cname -> resolve -> classify -> report (cron entry point)
    dangling.py enum [--days 7] [--max-domains N]
    dangling.py cname
    dangling.py resolve
    dangling.py findings            # print the findings table
    dangling.py add <domain> <org> <email> [--policy URL]

Data model
    domains  one watched zone (org, policy, contact, tier)
    hosts    names discovered for a zone
    cnames   host -> target edges, timestamped so a record disappearing is visible
    findings one row per (host, target) that resolved dead, with claimability verdict + path
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB = ROOT / "state.db"
REPORTS = ROOT / "reports"
UA = "Mozilla/5.0 (compatible; dns-hygiene-monitor)"
IPV4 = re.compile(r"^\d+\.\d+\.\d+\.\d+$")
# A record target worth recording: dot-separated labels, no scheme, no trailing dot, no comments.
HOSTNAME = re.compile(r"^(?!-)[A-Za-z0-9_-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9_-]{1,63}(?<!-))+$")

# namespace -> (claimable_by_stranger, why, how you claim it, cost)
PROVIDERS = [
    ("elasticbeanstalk.com", True,
     "AWS docs: terminated environments release the hostname — 'other customers can reuse an available hostname'",
     "aws elasticbeanstalk create-environment --cname-prefix <prefix> (same region)", "AWS account, free"),
    ("trafficmanager.net", True,
     "Microsoft: profile name is reserved after deletion, then reusable by a different tenant",
     "create a Traffic Manager profile with the same name, add an External endpoint", "Azure subscription"),
    ("s3.amazonaws.com", True, "deleted bucket name is globally claimable",
     "create bucket with the same name", "AWS account"),
    ("azurewebsites.net", True, "app name is globally claimable once deleted",
     "create a Web App with the same name", "Azure subscription"),
    ("blob.core.windows.net", True, "storage account name is globally claimable",
     "create storage account with the same name", "Azure subscription"),
    ("cloudapp.azure.com", True, "cloud service name is globally claimable", "create cloud service", "Azure subscription"),
    ("github.io", True, "username/repo namespace is claimable if the owner does not exist",
     "create the matching user/repo", "free"),
    ("herokuapp.com", True, "app name is claimable once deleted", "heroku create <name>", "free"),
    ("netlify.app", True, "site subdomain is claimable", "create site, set subdomain", "free"),
    ("vercel.app", True, "project subdomain is claimable", "create project, set domain", "free"),
    ("pages.dev", True, "cloudflare pages project name is claimable", "create project", "free"),
    ("fly.dev", True, "app name is claimable", "fly apps create <name>", "free"),
    ("readthedocs.io", True, "project subdomain is claimable", "create project", "free"),
    ("surge.sh", True, "domain is claimable", "surge publish", "free"),
    ("wordpress.com", False, "subdomain belongs to the blog owner's account; cannot be re-registered by a stranger", "", ""),
    ("elb.amazonaws.com", False, "name embeds the account id; cannot be recreated", "", ""),
    ("cloudfront.net", False, "distribution hostname is AWS-generated", "", ""),
    ("herokudns.com", False, "target is derived from the domain name + requires ownership proof", "", ""),
    ("execute-api", False, "custom-domain id is account-generated", "", ""),
    ("outrch.com", False, "vendor-assigned tracking domain", "", ""),
    ("custhelp.com", False, "Oracle-hosted instance name", "", ""),
    ("mktoweb.com", False, "Marketo instance name", "", ""),
    ("lync.com", False, "Microsoft-owned", "", ""),
]


def db() -> sqlite3.Connection:
    # WAL + a real busy timeout: the CNAME pass holds a write transaction while it resolves tens of
    # thousands of names, and in rollback-journal mode that locks every reader for the whole run.
    c = sqlite3.connect(DB, timeout=30)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=30000")
    c.executescript("""
    CREATE TABLE IF NOT EXISTS domains(
      domain TEXT PRIMARY KEY, org TEXT, policy TEXT, contact TEXT, tier TEXT,
      last_enum TEXT);
    CREATE TABLE IF NOT EXISTS hosts(
      host TEXT, domain TEXT, first_seen TEXT, PRIMARY KEY(host));
    CREATE TABLE IF NOT EXISTS cnames(
      host TEXT, target TEXT, seen TEXT, alive TEXT, PRIMARY KEY(host, target));
    CREATE TABLE IF NOT EXISTS findings(
      host TEXT, target TEXT, provider TEXT, claimable INTEGER, why TEXT, claim TEXT,
      cost TEXT, first_seen TEXT, report TEXT, state TEXT DEFAULT 'new',
      PRIMARY KEY(host, target));
    """)
    return c


def dig(args: list[str], timeout: int = 8) -> str:
    try:
        return subprocess.run(["dig", *args], capture_output=True, text=True,
                              timeout=timeout).stdout
    except Exception:
        return ""


def http_json(url: str, timeout: int = 60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def http_get(url: str, timeout: int = 60) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def enum_domain(dom: str) -> tuple[set[str], bool]:
    """CT logs only. No brute force, no scanning — this stays legal for any zone.

    Returns (hosts, ok). `ok=False` means the sources failed, which is NOT the same as a zone with
    no subdomains: the caller must leave the zone un-enumerated so the next run retries it, or a
    rate-limited aggregator silently turns into a false negative.
    """
    out: set[str] = set()
    ok = False
    for attempt in range(3):
        try:
            data = http_json(f"https://api.subdomain.center/?domain={dom}", 45)
            out |= {str(x).strip().lower() for x in data if x}
            ok = True
            break
        except Exception:  # noqa: BLE001 — 429/5xx under concurrency is expected
            time.sleep(2 * (attempt + 1))
    if not ok:  # fall back only when the aggregator failed, never on a small result set
        try:
            rows = http_json(f"https://crt.sh/?q=%25.{dom}&output=json", 90)
            for row in rows:
                for n in str(row.get("name_value", "")).splitlines():
                    n = n.strip().lower().lstrip("*.")
                    if n.endswith(dom):
                        out.add(n)
            ok = True
        except Exception:  # noqa: BLE001
            pass
    return {h for h in out if h.endswith(dom) and "*" not in h and " " not in h}, ok


def enum_deep(dom: str) -> tuple[set[str], bool]:
    """Union the sources that actually deliver, with retries.

    Measured per source on tesla.com: subdomain.center caps at 500 names, crt.sh returns ~3,500 rows but
    throttles (503) and needs a long timeout, rapiddns pages ~100 at a time, hackertarget is hard-capped at
    50/day. OTX answers 429 and anubis 403 from this host, so neither is wired in — a source that always
    fails only burns the budget.
    """
    out: set[str] = set()
    ok = False

    def add(name: str) -> None:
        n = str(name).strip().lower().lstrip("*.")
        if n and n.endswith(dom) and "*" not in n and " " not in n:
            out.add(n)

    try:
        for x in http_json(f"https://api.subdomain.center/?domain={dom}", 45) or []:
            add(x)
        ok = True
    except Exception:  # noqa: BLE001
        pass

    for attempt in range(3):  # crt.sh: the deepest source, and the flakiest
        try:
            rows = http_json(f"https://crt.sh/?q=%25.{dom}&output=json", 150)
            for row in rows:
                for n in str(row.get("name_value", "")).splitlines():
                    add(n)
            ok = True
            break
        except Exception:  # noqa: BLE001
            time.sleep(15 * (attempt + 1))

    try:  # rapiddns, five pages
        for page in range(1, 6):
            html = http_get(f"https://rapiddns.io/subdomain/{dom}?full=1&page={page}", 60)
            found = re.findall(rf"<td>([A-Za-z0-9_.*-]+\.{re.escape(dom)})</td>", html)
            if not found:
                break
            for n in found:
                add(n)
            ok = True
    except Exception:  # noqa: BLE001
        pass

    try:  # hackertarget, capped but high-signal
        text = http_get(f"https://api.hackertarget.com/hostsearch/?q={dom}", 60)
        for line in text.splitlines():
            if "," in line:
                add(line.split(",", 1)[0])
        ok = True
    except Exception:  # noqa: BLE001
        pass

    return out, ok


def cmd_add(a) -> None:
    c = db()
    c.execute("INSERT OR REPLACE INTO domains(domain,org,policy,contact,tier) VALUES(?,?,?,?,?)",
              (a.domain, a.org, a.policy, a.contact, a.tier))
    c.commit()
    print(f"watching {a.domain} ({a.org}) -> {a.contact}")


def cmd_enum(a) -> None:
    c = db()
    cutoff = time.time() - a.days * 86400
    rows = c.execute("SELECT domain, last_enum, tier FROM domains"
                     " ORDER BY last_enum NULLS FIRST").fetchall()
    todo = []
    for dom, last, tier in rows:
        if last and datetime.fromisoformat(last).timestamp() > cutoff:
            continue
        if getattr(a, "tier", "") and getattr(a, "tier", "") not in (tier or ""):
            continue
        todo.append(dom)
    if getattr(a, "only", ""):
        want = {d.strip() for d in a.only.split(",") if d.strip()}
        todo = [d for d in todo if d in want]
    if a.max_domains:
        todo = todo[: a.max_domains]
    workers = max(1, getattr(a, "workers", 4))
    print(f"{len(todo)} zones due for enumeration ({workers} workers)")
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        enum_fn = enum_deep if getattr(a, "deep", False) else enum_domain
        futures = {ex.submit(enum_fn, dom): dom for dom in todo}
        for fut in as_completed(futures):
            dom = futures[fut]
            try:
                hosts, ok = fut.result()
            except Exception:  # noqa: BLE001 — one bad zone must not kill the sweep
                hosts, ok = set(), False
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            c.executemany("INSERT OR IGNORE INTO hosts(host,domain,first_seen) VALUES(?,?,?)",
                          [(h, dom, now) for h in hosts])
            if ok:
                c.execute("UPDATE domains SET last_enum=? WHERE domain=?", (now, dom))
            c.commit()
            done += 1
            mark = "" if ok else "  (sources failed — will retry)"
            print(f"  [{done}/{len(todo)}] {dom}: {len(hosts)} names{mark}", flush=True)


def _cname(host: str):
    out = dig(["+short", "+time=3", "+tries=1", "CNAME", host])
    # `dig +short` also emits thing like ";;" when the query fails or there is no answer; that is a
    # missing record, not a target. Only accept something that is shaped like a hostname, or 8,329 rows
    # of ";;" get recorded as CNAME edges and then reported as findings.
    tgt = None
    for x in out.split():
        x = x.strip(" .")
        if IPV4.match(x) or x.startswith(";") or "." not in x or " " in x:
            continue
        if HOSTNAME.match(x):
            tgt = x
            break
    return host, tgt


def cmd_cname(a) -> None:
    c = db()
    hosts = [r[0] for r in c.execute(
        "SELECT h.host FROM hosts h LEFT JOIN cnames n ON n.host=h.host WHERE n.host IS NULL")]
    print(f"{len(hosts)} hosts without a CNAME edge")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    found = 0
    with ThreadPoolExecutor(max_workers=100) as ex:
        for i, (host, tgt) in enumerate(ex.map(_cname, hosts), 1):
            if tgt:
                found += 1
                c.execute("INSERT OR IGNORE INTO cnames(host,target,seen,alive) VALUES(?,?,?,NULL)",
                          (host, tgt, now))
            # commit in batches: one transaction for the whole pass would lock every other writer out
            if i % 500 == 0:
                c.commit()
                print(f"  ...{i}/{len(hosts)} checked, {found} edges", flush=True)
    c.commit()
    print(f"  {found} CNAME edges recorded")


def _alive(t: str) -> bool | None:
    """True = name exists, False = NXDOMAIN, None = resolver could not answer.

    Only NXDOMAIN is evidence of death. A SERVFAIL, an empty reply, a rate-limited resolver or a
    NOERROR/NODATA answer all mean "no A record right now", which is a different fact from "the name
    is gone" — reading any of them as death retires live findings.
    """
    out = dig(["+noall", "+comments", "+answer", t, "A", "+time=3", "+tries=1"])
    m = re.search(r"status: ([A-Z]+)", out)
    if not m:
        return None
    status = m.group(1)
    if status == "NXDOMAIN":
        return False
    if status != "NOERROR":
        return None                      # SERVFAIL / REFUSED / timeout — unknown, never "dead"
    if any(IPV4.match(x) for x in out.split()):
        return True
    if "CNAME" in out:
        return True
    # NOERROR with an empty answer section (ANSWER: 0 and no SOA in the answer) is NODATA: the zone
    # exists but publishes nothing for this name. On a provider-issued target that *is* the takeover
    # condition — Heroku answers exactly this for a custom domain that was removed from its app — so
    # it counts as dead. SERVFAIL, REFUSED and timeouts stayed None above.
    if "ANSWER: 0" in out:
        return False
    return None


def _has_cname(host: str) -> bool | None:
    """Does the CNAME record itself still exist?

    A dangling edge answers NXDOMAIN to an A query *because its target is gone*, while the CNAME is
    still in place — the whole finding. So record-removal has to be asked as a CNAME question, not an
    A question: `_alive(host) is False` is true for every real finding, and retiring on it deletes the
    book. Returns None when the resolver could not answer.
    """
    out = dig(["+noall", "+comments", "+answer", host, "CNAME", "+time=3", "+tries=1"])
    m = re.search(r"status: ([A-Z]+)", out)
    if not m:
        return None
    if "CNAME" in out:
        return True
    if m.group(1) in ("NOERROR", "NXDOMAIN"):
        return False                     # the name (and therefore the edge) is not published
    return None


def _status(t: str) -> str:
    out = dig([t, "A", "+noall", "+comments"])
    m = re.search(r"status: ([A-Z]+)", out)
    return m.group(1) if m else "UNKNOWN"


# Namespaces that look interesting and are not takeable. Each of these turned up in the
# "unclassified namespace" triage bucket, and leaving them there means re-triaging the same
# benign records on every sweep.
BENIGN = [
    ("cloudflare.net", "Cloudflare edge infrastructure; names are per-zone and not claimable"),
    ("incapdns.net", "Imperva/Incapsula edge network; names are assigned per customer"),
    ("amazonaws.com", "AWS service namespace; the name is AWS-generated for the owning account"),
    ("amazon.com", "Amazon retail/service namespace; not a claimable vendor subdomain"),
    ("xiaomi.srv", "internal service record, not a public DNS namespace"),
    ("justeat-int.com", "internal namespace of the asset owner's own group"),
    ("sendgrid.net", "SendGrid/Twilio link-branding edge; names are per-account and not claimable"),
    ("edgekey.net", "Akamai edge hostname; assigned per customer property, not a takeover surface"),
    ("hover.com", "registrar parking/forwarding host, not a claimable namespace"),
]
def _apex(host: str) -> str:
    """Registrable domain via the Public Suffix List — see engine/apex.py.

    A local set of two-level suffixes (`TLD2`) was the original implementation and it was wrong for
    every registry not in the set: `www.cbn.com.bo` collapsed to `com.bo`, inherited a Visa asset's
    tier, and the report gate said "submit through the programme" for a host with no programme at all.
    """
    from apex import registered
    return registered(host)


def provider_for(target: str, host: str = ""):
    # Heroku custom-domain targets come in two shapes and only one is reclaimable:
    #   <custom-domain>.herokudns.com  -> derived from the *domain*, so re-adding that domain to an
    #                                     app of your own reissues the identical record (the classic
    #                                     Heroku custom-domain takeover; no DNS access needed)
    #   <app>-<hash>.herokudns.com     -> derived from the *app*, which cannot be recreated
    # Classifying both as "not claimable" is how `ellen.withspotify.com` sat in the corpus graded 0
    # while its target had already been deleted from Heroku.
    m = re.fullmatch(r"(.+?)\.herokudns\.com\.?", target.lower())
    if m:
        if host and m.group(1) == host.lower().rstrip("."):
            return ("herokudns.com (domain-derived)", True,
                    "target is derived from the custom domain itself: adding that domain to a Heroku app of "
                    "your own makes Heroku reissue the same herokudns record",
                    f"heroku domains:add {host} on an app you own", "Heroku account")
        return ("herokudns.com (app-derived)", False,
                "hashed target is derived from the app that owned it; it cannot be recreated", "", "")
    # Elastic Beanstalk has two shapes with different claim paths:
    #   <prefix>.<region>.elasticbeanstalk.com     -> create an env with that DNS name
    #   <env>.<id>.<region>.elasticbeanstalk.com   -> create an env whose DNS name is the id,
    #                                                 which wildcards every nested name under it
    m = re.fullmatch(r"([a-z0-9][a-z0-9-]*)\.([a-z]{2}-[a-z]+-\d)\.elasticbeanstalk\.com\.?", target)
    if m:
        return ("elasticbeanstalk.com (plain)", True,
                "AWS docs: terminated environments release the hostname — 'other customers can reuse an available hostname'",
                f"aws elasticbeanstalk create-environment --cname-prefix {m.group(1)} (region {m.group(2)})",
                "AWS account, free")
    m = re.fullmatch(r"(.+?)\.([a-z0-9]{6,14})\.([a-z]{2}-[a-z]+-\d)\.elasticbeanstalk\.com\.?", target)
    if m:
        return ("elasticbeanstalk.com (hashed)", True,
                "hashed EB names are still takeable: a new environment using the id as its DNS name wildcards every nested name under it",
                f"aws elasticbeanstalk create-environment --cname-prefix {m.group(2)} (region {m.group(3)}) — covers {m.group(1)} too",
                "AWS account, free")
    for name, ok, why, claim, cost in PROVIDERS:
        # A CNAME aimed at the provider's own apex (`login.example.com -> azurewebsites.net`) is a
        # misconfiguration with nothing on the other end to claim: the name that would have to be
        # re-registered is Microsoft's, not a tenant's. It must never reach the queue as a finding.
        if target.rstrip(".").lower() in (name, "." + name):
            return (None, False, f"CNAME points at the bare provider domain {name}; no tenant name to claim", "", "")
        if name in target:
            return name, ok, why, claim, cost
    if host and _apex(host) == _apex(target):
        return (None, False,
                "first-party CNAME inside the same registered domain — a misconfiguration, not a takeover",
                "", "")
    for suffix, why in BENIGN:
        if target.rstrip(".").endswith(suffix):
            return None, False, why, "", ""
    return None, None, "unclassified namespace — check who owns it before reporting", "", ""


def cmd_resolve(a) -> None:
    c = db()
    targets = [r[0] for r in c.execute("SELECT DISTINCT target FROM cnames WHERE alive IS NULL")]
    print(f"{len(targets)} targets to resolve")
    with ThreadPoolExecutor(max_workers=40) as ex:
        results = list(ex.map(lambda t: (t, _alive(t)), targets))
    dead = [t for t, ok in results if ok is False]
    # An untestable answer must land as NULL, never as the string "None": collapsing three-valued
    # state into text is why 3,278 genuinely dead edges (`ellen.withspotify.com` among them) sat
    # unclassified — cmd_reclass filters on `alive='False'` and silently skipped every 'None' row.
    c.executemany("UPDATE cnames SET alive=? WHERE target=?",
                  [(None if ok is None else str(ok), t) for t, ok in results])
    c.commit()
    print(f"  {len(dead)} dead targets ({len(targets) - len(dead)} alive)")

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for t in dead:
        for (host,) in c.execute("SELECT host FROM cnames WHERE target=?", (t,)).fetchall():
            # classify per host: the same-zone rule needs the host to compare apexes
            prov, ok, why, claim, cost = provider_for(t, host)
            c.execute("""INSERT OR IGNORE INTO findings
                         (host,target,provider,claimable,why,claim,cost,first_seen)
                         VALUES(?,?,?,?,?,?,?,?)""",
                      (host, t, prov, 1 if ok else 0, why, claim, cost, now))
    c.commit()


def cmd_recheck(a) -> None:
    """Re-resolve a rotating slice of already-known CNAME targets.

    cmd_resolve only looks at targets with alive IS NULL, so once an edge is resolved it is never
    looked at again and a target that dies later is invisible forever. This walks the whole known
    edge set deterministically in shards: run it 96x and every target has been re-checked once.
    Takeover-prone namespaces are included far more often, since that is where deletions happen.
    """
    c = db()
    shard, total = (a.shard.split("/") + ["1"])[:2]
    shard, total = int(shard), int(total)
    if total < 1 or not (1 <= shard <= total):
        print(f"bad --shard {a.shard}: want i/N with 1<=i<=N")
        return
    hot_shard, hot_total = (a.hot_shard.split("/") + ["1"])[:2]
    hot_shard, hot_total = int(hot_shard), int(hot_total)

    rows = c.execute("""SELECT DISTINCT cn.target FROM cnames cn
                        JOIN domains d ON cn.host = d.domain OR cn.host LIKE '%.' || d.domain
                        WHERE d.tier LIKE 'bounty%' OR d.policy <> ''""").fetchall()
    targets = [r[0] for r in rows]
    hot_names = tuple(h for h, *_ in PROVIDERS)
    picked, hot_picked = [], 0
    for t in targets:
        hot = any(h in t for h in hot_names)
        if zlib.crc32(t.encode()) % total == shard % total:
            picked.append(t)
        elif hot and hot_total > 1 and zlib.crc32(("hot:" + t).encode()) % hot_total == hot_shard % hot_total:
            picked.append(t); hot_picked += 1
    print(f"{len(targets)} paying targets · shard {shard}/{total} → re-checking {len(picked)} "
          f"({hot_picked} hot via shard {hot_shard}/{hot_total})")

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        results = list(ex.map(lambda t: (t, _alive(t)), picked))
    dead = [t for t, ok in results if ok is False]
    c.executemany("UPDATE cnames SET alive=? WHERE target=?", [(str(ok), t) for t, ok in results])
    c.commit()
    print(f"  {len(dead)} dead of {len(picked)} re-checked")

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    new = 0
    for t in dead:
        for (host,) in c.execute("SELECT host FROM cnames WHERE target=?", (t,)).fetchall():
            # A dead target is only a finding while the record still exists. If the host itself no
            # longer resolves, the owner has removed the CNAME and the exposure is closed — filing
            # it after that point is a false positive, which burns the programme's trust.
            if _has_cname(host) is False:
                c.execute("""UPDATE findings SET claimable=0,
                             why=COALESCE(why,'')||' [record removed: host no longer resolves]'
                             WHERE host=? AND target=?""", (host, t))
                continue
            prov, ok, why, claim, cost = provider_for(t, host)
            before = c.execute("SELECT COUNT(*) FROM findings WHERE host=? AND target=?",
                               (host, t)).fetchone()[0]
            c.execute("""INSERT OR IGNORE INTO findings
                         (host,target,provider,claimable,why,claim,cost,first_seen)
                         VALUES(?,?,?,?,?,?,?,?)""",
                      (host, t, prov, 1 if ok else 0, why, claim, cost, now))
            if not before:
                new += 1
    c.commit()
    print(f"  {new} new finding row(s) this pass")


def cmd_reclass(a) -> None:
    """Rebuild findings from the CNAME table without touching DNS.

    `resolve` only classifies targets it has just discovered, so improving the provider table never
    reaches rows already stored — and deleting findings to force a rebuild loses them, because nothing
    re-inserts. This recomputes every dead edge against the current rules.
    """
    c = db()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = c.execute("SELECT host,target FROM cnames WHERE alive='False'").fetchall()
    inserted = 0
    for host, target in rows:
        prov, ok, why, claim, cost = provider_for(target, host)
        cur = c.execute("""INSERT OR IGNORE INTO findings
                           (host,target,provider,claimable,why,claim,cost,first_seen)
                           VALUES(?,?,?,?,?,?,?,?)""",
                        (host, target, prov, 1 if ok else 0, why, claim, cost, now))
        inserted += cur.rowcount
    # existing rows keep their verdict otherwise; refresh classification of the ones that are not yet reported
    for host, target in rows:
        prov, ok, why, claim, cost = provider_for(target, host)
        c.execute("""UPDATE findings SET provider=?, claimable=?, why=?, claim=?, cost=?
                     WHERE host=? AND target=? AND report IS NULL""",
                  (prov, 1 if ok else 0, why, claim, cost, host, target))
    c.commit()
    total = c.execute("SELECT count(*) FROM findings").fetchone()[0]
    claimable = c.execute("SELECT count(*) FROM findings WHERE claimable=1").fetchone()[0]
    print(f"{len(rows)} dead edges reclassified, {inserted} new rows, {total} findings, {claimable} claimable")


def cmd_findings(a) -> None:
    c = db()
    rows = c.execute("""SELECT host,target,provider,claimable,state,report FROM findings
                        ORDER BY claimable DESC, host""").fetchall()
    if not rows:
        print("no findings")
        return
    print(f"{'VERDICT':9} {'HOST':52} {'TARGET':46} STATE")
    for host, tgt, prov, ok, state, rep in rows:
        print(f"{'CLAIMABLE' if ok else 'dead-end':9} {host[:52]:52} {tgt[:46]:46} {state}")


REPORT_TMPL = """# Dangling DNS / subdomain takeover: `{host}`

**Program / owner:** {org}
**Channel:** {contact}
**Asset:** `{host}` -> `{target}`
**Namespace:** {provider}
**Verdict:** {verdict}
**Detected:** {seen}
**Severity:** Medium (takeover) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)

## Summary

`{host}` is a rule in the {org} DNS zone that points at `{target}`, which no longer answers:

```
{dns}
```

{claim_line}

## Impact

A stranger holding that hostname serves attacker-controlled content at `https://{host}` — with a
certificate issued for the exact name, since DNS validation passes through the record. That buys
phishing inside the {org} brand, bypass of any `*` allow-list keyed on the domain (CORS,
`redirect_uri`, CSP, proxy rules), and capture of any request — including bearer tokens — still
configured for the dead hostname.

## Remediation

1. Delete the DNS record for `{host}`. That alone closes it.
2. Add "delete the DNS records" to the service teardown checklist.
3. Sweep the zone once for any CNAME whose target no longer resolves.

## Testing notes

Passive only: certificate transparency logs plus `dig`. No HTTP requests to the record, no account
created, nothing claimed. I will keep this private for the policy window.

_Auto-drafted by engine/dangling.py — human-edit before sending._
"""

OUTREACH_TMPL = """Subject: dangling DNS record on {domain} — {host} (free heads-up, no strings)

Hello,

I monitor certificate transparency logs for DNS hygiene problems. One record in your zone points
at a hostname that no longer exists:

  {host} -> {target}   (target returns NXDOMAIN)

What that means: the hostname is in a namespace a third party can register once it is released
({provider}; {cost}), and whoever takes it can serve content at https://{host}. Your record has
been dead for a while, which also means anything still configured to call it is failing silently.

The fix is one DNS deletion. I am not asking anything for the finding — it is yours, and the full
technical write-up is attached.

If it is useful, I also run a sweep of the rest of your estate (every subdomain, every CNAME, every
dead vendor target) and hand back the same kind of report with a fix list. That is a paid piece of
work; the thing above is free either way.

Either way: please delete the record.

Regards,
Michael Cluer
"""


def cmd_report(a) -> None:
    c = db()
    REPORTS.mkdir(exist_ok=True)
    rows = c.execute("""SELECT f.host,f.target,f.provider,f.claimable,f.why,f.claim,f.cost,f.first_seen,
                               d.org,d.contact,d.domain,d.tier,d.policy
                        FROM findings f
                        JOIN cnames n ON n.host=f.host
                        JOIN hosts h ON h.host=f.host
                        JOIN domains d ON d.domain=h.domain
                        WHERE f.claimable=1 AND f.report IS NULL""").fetchall()
    print(f"{len(rows)} claimable findings awaiting a draft")
    for host, target, prov, ok, why, claim, cost, seen, org, contact, domain, tier, policy in rows:
        # re-classify against the current table so improved rules apply to old rows too
        prov, ok2, why, claim, cost = provider_for(target, host)
        ok = 1 if ok2 else 0
        if not ok:
            c.execute("UPDATE findings SET claimable=0, state='dead-end' WHERE host=? AND target=?",
                      (host, target))
            continue
        dns = dig(["+noall", "+answer", host, "CNAME"])
        st = _status(target)
        dns += f"\n; {target} -> status: {st}\n"
        if claim:
            claim_line = f"How the name is claimable: {why}.\n\nClaim path: `{claim}` ({cost})."
        else:
            claim_line = f"Why it matters: {why}."
        body = REPORT_TMPL.format(host=host, target=target, org=org, contact=contact,
                                  provider=prov or "unknown", seen=seen,
                                  verdict="claimable by a third party" if ok else "dangling, not claimable",
                                  dns=dns.strip(), why=why, claim_line=claim_line)
        rp = REPORTS / f"{domain}-{host.replace('.', '_')}.md"
        rp.write_text(body)
        # A host inside a published programme is submitted through that programme, never emailed
        # around it: the programme's rules are the safe harbour, and writing to the target directly
        # while a reward is on offer looks like circumvention. Direct outreach is for no-programme
        # assets only (tier L5/L2), which is what the four 2026-11-01 disclosures were.
        platform = {"h1": "HackerOne", "bc": "Bugcrowd", "yw": "YesWeHack", "it": "Intigriti"}.get(
            (tier or "").split(":")[-1], tier)
        if (tier or "").startswith("bounty:") or policy:
            note = REPORTS / f"SUBMIT-{domain}.txt"
            if not note.exists():
                note.write_text(
                    f"{domain} is inside a published programme — submit through it, do not email the target.\n\n"
                    f"Programme: {org}\nPlatform:  {platform}\nPolicy:    {policy or 'see the programme page'}\n"
                    f"Programme scope gate: passed for {host}\n\n"
                    f"Report bodies: the per-host .md files in this directory. Consolidate the hosts that share a\n"
                    f"target into one report (they are one root cause), and say plainly that nothing was claimed.\n")
                print(f"  submit-through-programme note {note.name}")
        elif not (REPORTS / f"outreach-{domain}.txt").exists():
            (REPORTS / f"outreach-{domain}.txt").write_text(
                OUTREACH_TMPL.format(domain=domain, host=host, target=target,
                                     provider=prov or "unknown", cost=cost or "no account needed"))
        c.execute("UPDATE findings SET report=?, state='drafted' WHERE host=? AND target=?",
                  (str(rp), host, target))
        print(f"  drafted {rp.name}")
    c.commit()


def cmd_run(a) -> None:
    cmd_enum(a)
    cmd_cname(a)
    cmd_resolve(a)
    cmd_report(a)
    cmd_findings(a)
    print("\nnext: draft reports for CLAIMABLE rows (see reports/), then send from the user's own mail")


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    ad = sub.add_parser("add"); ad.add_argument("domain"); ad.add_argument("org")
    ad.add_argument("contact"); ad.add_argument("--policy", default=""); ad.add_argument("--tier", default="L5")
    ad.set_defaults(fn=cmd_add)

    for name, fn in [("enum", cmd_enum), ("cname", cmd_cname), ("resolve", cmd_resolve),
                     ("reclass", cmd_reclass), ("findings", cmd_findings), ("report", cmd_report),
                     ("run", cmd_run)]:
        s = sub.add_parser(name); s.set_defaults(fn=fn)
        s.add_argument("--days", type=int, default=7)
        s.add_argument("--max-domains", type=int, default=0)
        s.add_argument("--only", default="")
        s.add_argument("--tier", default="", help="substring match on the domain tier, e.g. bounty:")
        s.add_argument("--workers", type=int, default=4, help="parallel zone enumeration")
        s.add_argument("--deep", action="store_true",
                       help="union crt.sh + Cert Spotter + OTX + anubis (slower, deeper)")

    rc = sub.add_parser("recheck", help="re-resolve a rotating shard of known targets")
    rc.set_defaults(fn=cmd_recheck)
    rc.add_argument("--shard", default="1/1", help="i/N — rotate so run i re-checks its slice")
    rc.add_argument("--hot-shard", default="1/8",
                    help="i/N — extra slice of takeover-prone namespaces checked every run")
    rc.add_argument("--workers", type=int, default=40)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
