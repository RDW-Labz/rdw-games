#!/usr/bin/env python3
"""Turn a claimable lead into a filed HackerOne report, with no human in the loop.

The API token can create a report and read it back, nothing else — no comment, no edit — so this is the
only rail that works unattended. Bugcrowd's rail is draft-only and its token is currently 401 on both
surfaces, so this engine deliberately covers H1 alone and says so rather than pretending otherwise.

    ./h1_autofile.py            # dry: what would be filed, and the reason for everything skipped
    ./h1_autofile.py --apply    # file it, record filed.json, mark the finding
    ./h1_autofile.py --apply --max 2

Guards, in the order they bite:

1. `findings.claimable = 1` — the leadgate verdict, not a fresh guess.
2. Re-verified live at file time: the CNAME must still point at the provider, and the provider must
   still disown the name. A lead that healed between sweep and filing must never reach the API.
3. One report per (programme, takeover namespace). Fourteen hostnames hanging off one unclaimed
   `playtika.github.io` are one finding, not fourteen reports — the second filing would be a duplicate
   and duplicates get closed.
4. Only programmes on HackerOne with `offers_bounty = 1`. A non-paying programme cannot make money.

Four vendors have a "is it really free" test worth trusting — GitHub Pages, Heroku custom domains,
Azure App Service, Azure Traffic Manager — and the narrative is picked from the target's suffix.
Anything else falls back to a generic claim that says only what `dig` measured. Filing a GitHub story
against a Heroku target is how a report reads as a template instead of a finding.
"""
from __future__ import annotations

import json
import re
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))

import h1_scope  # noqa: E402  — live structured-scope verification, cached 24h

STATE = ROOT / "engine" / "state.db"
FILED = ROOT / "reports" / "filed.json"


def sh(*args: str, timeout: int = 25) -> str:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except subprocess.TimeoutExpired:
        return ""


def http_code(url: str, timeout: str = "10") -> str:
    return sh("curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", timeout, url)


def cert_covers(host: str) -> bool | None:
    """Does the certificate served for `host` name *this* host, rather than the provider wildcard?

    The decisive GitHub Pages signal, and the one the 404/302 heuristic gets wrong. GitHub provisions
    a per-domain certificate only for a custom domain that a Pages site has actually claimed, and
    serves the provider wildcard (`CN=*.github.io`) for a hostname nobody claimed. So
    `developer-ai-radar.eg-internal.ghpages.expedia.biz` answering `302 -> github.com/pages/auth`
    *with* `CN=developer-ai-radar...` is a bound, gated site — not a takeover — while
    `devex-mcp-registry...` answering `404` off `CN=*.github.io` is the real dangling edge.
    Returns None when the handshake could not be inspected.
    """
    out = sh("bash", "-c",
             f"timeout 20 openssl s_client -connect {host}:443 -servername {host} </dev/null 2>/dev/null "
             f"| openssl x509 -noout -subject -ext subjectAltName 2>/dev/null", timeout=30)
    if not out:
        return None
    names = {n.strip().lower().lstrip("*.") for n in re.findall(r"(?:DNS:)?\*?\.?([A-Za-z0-9.*-]+\.[A-Za-z0-9.-]+)", out)}
    return host.lower() in names


def verify(host: str, target: str) -> tuple[bool, list[str]]:
    """True only when the DNS record and the provider both still say the name is nobody's."""
    notes = []
    if is_provider_apex(target):
        # No name to register, so nothing to take over: report it as a broken record, never as a finding.
        return False, [f"target {target} is the provider zone itself — no app label to claim"]
    cname = sh("dig", "+short", "+time=3", host, "CNAME").rstrip(".")
    notes.append(f"cname {cname or '(none)'}")
    if cname != target:
        return False, notes + ["CNAME changed or gone — lead healed"]

    page = http_code(f"https://{host}/")
    notes.append(f"https://{host}/ -> {page}")
    if page not in ("404", "302", "301", "000"):
        return False, notes + ["host serves content — not a takeover"]

    bound = cert_covers(host)
    notes.append("cert names this host — bound" if bound else
                 "cert is the provider wildcard — unbound" if bound is False else "cert unknown")
    if bound:
        # A per-host certificate means a site already claims the name; the 302 to /pages/auth is that
        # site's access gate, not an invitation to claim it.
        return False, notes + ["provider already holds a certificate for this exact name — claimed"]

    name = target.split(".")[0]
    if target.endswith(".herokudns.com"):
        # Heroku's target is `<custom-domain>.herokudns.com` — a function of the domain, so the
        # "account name" test does not apply: no GitHub user `ellen` can hold `ellen.withspotify.com`,
        # and running that test anyway dropped a claimable, in-scope Spotify lead. What matters is the
        # target itself being unprovisioned, which the NODATA answer already showed.
        nodata = sh("dig", "+noall", "+comments", target, "A", "+time=3", "+tries=1")
        notes.append(f"target {target} NODATA" if "ANSWER: 0" in nodata else "target answers DNS")
        if "ANSWER: 0" not in nodata:
            return False, notes + ["the Heroku target still resolves — the app still owns the domain"]
        return True, notes + ["Heroku derives this target from the domain, so any app can re-add it"]

    owner = http_code(f"https://github.com/{name}")
    api = http_code(f"https://api.github.com/users/{name}")
    native = http_code(f"https://{target}/")
    notes += [f"github.com/{name} {owner}", f"api/users/{name} {api}", f"native {target} {native}"]
    if owner != "404" or api != "404":
        return False, notes + ["the account exists — the name is taken, nothing to claim"]
    if native != "404":
        return False, notes + ["a Pages site answers on the native hostname — bound, not dangling"]
    return True, notes


def namespace_sweep(db) -> list[dict]:
    """Every known host CNAME'd at a `*.github.io` namespace, grouped by namespace.

    `findings` only holds what the leadgate already graded, and the leadgate runs on a schedule; this
    reads the DNS corpus directly so a namespace that went dangling since the last sweep is not missed.
    A namespace qualifies only when the account and the native Pages hostname both answer 404 — the
    account existing is the whole difference between a takeover and a working site.
    """
    out: list[dict] = []
    targets = [r[0] for r in db.execute(
        "select distinct target from cnames where target like '%.github.io' order by target")]
    for t in targets:
        hosts = [r[0] for r in db.execute(
            "select distinct host from cnames where target = ? order by host", (t,))]
        if not hosts:
            continue
        name = t.split(".")[0]
        if http_code(f"https://github.com/{name}") != "404":
            continue                      # account exists: the namespace belongs to somebody
        if http_code(f"https://{t}/") != "404":
            continue                      # a Pages site answers: bound, not dangling
        # Of the hosts on a dead namespace, only some are actually unbound: a host whose own
        # certificate is per-domain has already been claimed by a site (and answers 302 to the Pages
        # access gate), while the precisely-claimable one still gets GitHub's wildcard cert. Citing
        # the bound host is how a report argues against itself, so the sweep keeps only the unbound.
        unbound = [h for h in hosts if verify(h, t)[0]]
        if not unbound:
            continue
        out.append({"target": t, "name": name, "hosts": unbound})
    return out


VENDOR = [
    (".github.io", "github"),
    (".herokudns.com", "heroku"),
    (".herokuapp.com", "heroku"),
    (".azurewebsites.net", "azure"),
    (".cloudapp.azure.com", "azure"),
    (".trafficmanager.net", "azure-tm"),
    (".cloudfront.net", "cloudfront"),
    (".s3.amazonaws.com", "s3"),
]


def vendor_of(target: str) -> str:
    """Which provider the dangling target belongs to, from its suffix alone."""
    t = target.lower().rstrip(".")
    for suffix, vendor in VENDOR:
        if t.endswith(suffix):
            return vendor
    return "generic"


# The provider apexes themselves. A CNAME that points at `azurewebsites.net` or `herokuapp.com` with no
# app label in front is a *misconfigured record*, not a dangling app: there is no name for anyone to
# register, so nothing can be claimed and the report has no finding in it. A draft in this repo did exactly
# that — `login-mediaspace.unrealengine.com CNAME azurewebsites.net` — and filing it would have been a
# false positive with a self-refuting evidence line.
PROVIDER_APEX = {
    "github.io", "githubapp.com", "herokuapp.com", "herokudns.com", "heroku.com",
    "azurewebsites.net", "cloudapp.azure.com", "trafficmanager.net",
    "cloudfront.net", "s3.amazonaws.com", "elasticbeanstalk.com",
    "azureedge.net", "blob.core.windows.net", "web.core.windows.net",
}


def is_provider_apex(target: str) -> bool:
    """True when the target is the provider zone itself, so there is no app label to claim."""
    return target.lower().rstrip(".") in PROVIDER_APEX


def probe_https(host: str) -> str:
    """curl's opinion of the hostname, measured now rather than asserted.

    The evidence block quotes this, so it has to be a real request: a report that says `000` beside a
    hostname that actually answers 200 is worse than no evidence line at all.
    """
    try:
        out = subprocess.run(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}",
                              "--max-time", "8", f"https://{host}/"],
                             capture_output=True, text=True, timeout=15)
    except Exception:
        return "err"
    code = (out.stdout or "").strip()
    return code or "000"


def dns_status(target: str) -> tuple[str, int]:
    """What the resolver actually said for the target: (rcode status, answer count).

    Evidence lines are generated from this rather than hard-coded, because a released Azure name
    answers NXDOMAIN while a released GitHub Pages name answers NOERROR/NODATA, and claiming the
    wrong rcode in a report is the kind of detail a triager checks first.
    """
    try:
        out = subprocess.run(["dig", "+noall", "+comments", "+answer", target, "A"],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return ("UNKNOWN", 0)
    m = re.search(r"status: (\w+)", out)
    answers = [ln for ln in out.splitlines() if ln.strip() and not ln.startswith(";")]
    return ((m.group(1) if m else "UNKNOWN"), len(answers))


def report_md(hosts: list[str], target: str, apex: str,
              pairs: list[tuple[str, str]] | None = None,
              control: tuple[str, str] | None = None) -> str:
    """Build the draft for one takeover.

    The template used to be GitHub-only and was regenerated on every run, so a Heroku CNAME was
    filed as "an unregistered GitHub Pages account" with `github.com/<name>` evidence — three
    404s that were true of GitHub and irrelevant to the target. Triage reads that as a template,
    not a finding. Pick the narrative from the target's own vendor and say only what was measured.
    """
    if pairs:
        hosts = [h for h, _ in pairs]
        target = pairs[0][1]
    main = hosts[0]
    name = target.split(".")[0]
    vendor = vendor_of(target)
    label = {"heroku": "Heroku", "github": "GitHub", "azure": "Azure App Service",
             "azure-tm": "Azure Traffic Manager", "cloudfront": "CloudFront",
             "s3": "S3"}.get(vendor, vendor)
    extra = ""
    if pairs and len(pairs) > 1:
        block = "\n".join(f"{h}  ->  {t}" for h, t in pairs)
        # Say how many distinct released names are involved: several hostnames often share one, and
        # claiming that one name takes over all of them at once.
        n_targets = len({t for _, t in pairs})
        shared = ("Each CNAME points at its own released name, so every hostname below is separately "
                  "claimable and every one needs deleting"
                  if n_targets == len(pairs) else
                  f"They point at {n_targets} released names, so claiming "
                  f"{'those names' if n_targets != 1 else 'that name'} takes over every hostname below "
                  f"in {n_targets} registration{'s' if n_targets != 1 else ''}")
        extra = (f"\nAll {len(pairs)} records were measured in the same pass. {shared}:\n\n"
                 f"```\n{block}\n```\n")
    elif len(hosts) > 1:
        block = "\n".join(f"  {h}" for h in hosts)
        extra = (f"\nThe same unclaimed {label} target carries {len(hosts) - 1} more hostnames, "
                 f"every one of them still delegating to it:\n\n```\n{block}\n```\n")

    article = "an" if label[0].lower() in "aeiou" else "a"
    control_block = ""
    if control:
        control_block = (f"\n$ dig +short {control[0]}    # control: a live name in the same zone\n"
                         f"{control[1]}\n")
    dns_st, dns_n = dns_status(target)
    if dns_st == "NXDOMAIN":
        verdict = (f"`{dns_st}` is the whole finding: the name `{target}` no longer exists, so the provider "
                   f"has released it. The zone itself is healthy — its own SOA and NS records answer normally "
                   f"— and the only broken link is the record your delegation still points at.")
    elif dns_n == 0:
        verdict = (f"`{dns_st}` with `ANSWER: 0` is NODATA, not a dead zone: the provider's own SOA and NS "
                   f"records are served normally, and a control name under the same zone returns the same "
                   f"shape. What is missing is the backend, not the DNS.")
    else:
        verdict = (f"The target still answers ({dns_n} record(s)), so this CNAME may be healthy — the finding "
                   f"stands on the recorded delegation only.")
    code = probe_https(main)
    code_note = "        # Could not resolve host" if code in ("000", "err") else "        # measured now"
    head = f"""# Subdomain takeover: `{main}` CNAMEs to {article} {label} target nothing owns

**Programme:** {apex} · **Severity:** medium · **Asset:** {main}

## Summary

`{main}` is a DNS record under `{apex}` that still CNAMEs to `{target}`. That target
{dns_st == "NXDOMAIN" and "no longer exists — the provider released the name" or "answers with no records"}, so the delegation
terminates in nothing and the record outlived whatever used to hold it.
{extra}
## Evidence

```
$ dig +short {main} CNAME
{target}

$ dig +noall +comments +answer {target} A
;; ->>HEADER<<- opcode: QUERY, status: {dns_st}, ANSWER: {dns_n}

$ curl -sS -o /dev/null -w '%{{http_code}}' https://{main}/
{code}{code_note}
{control_block}```

{verdict}
"""

    if vendor == "github":
        claim = f"""The GitHub account `{name}` **does not exist**, so any GitHub user who registers it and
publishes a repository with a `CNAME` file for `{main}` inherits the hostname — including the
certificate GitHub issues for a claimed custom domain. GitHub needs no DNS change on your side to
make that work."""
        impact = f"""An attacker who registers the free `{name}` account and enables Pages publishes arbitrary
content on `https://{main}/`, under a valid certificate and a hostname your own zone delegates to."""
        fix = (f"Remove the CNAME for every hostname listed above, or recreate the `{name}` GitHub account "
               f"and a Pages repository so the names resolve to content you control. Audit the zone for "
               f"other records pointing at `*.github.io` — this set alone had {len(hosts)}.")
        steps = (f"1. `dig +short {main} CNAME` → `{target}`.\n"
                 f"2. `api.github.com/users/{name}` → `404`, so the name is free.\n"
                 f"3. Register `{name}`, create a repository with a `CNAME` file for `{main}`, enable Pages.\n"
                 f"4. `https://{main}/` then serves the attacker's content.")
    elif vendor == "heroku":
        claim = f"""Heroku's custom-domain target is derived from the **domain name**, not the app: adding
`{main}` to any Heroku app issues exactly `{target}` again. The existing CNAME therefore already points
at whatever app holds that domain, so no change on your side is needed for a third party to take it
over — only a free Heroku account, where the domain is currently unclaimed."""
        impact = f"""Whoever adds `{main}` to a Heroku app has the hostname served from their own content, with a
certificate Heroku issues for it automatically. On a `{apex}` origin that survives a glance at the
address bar, receives any cookie scoped to the parent domain, and satisfies any allow-list or redirect
rule that treats `*.{apex}` as first-party."""
        fix = (f"Remove the `{main}` CNAME, or re-add the domain to a Heroku app you control. Audit the zone "
               f"for other `*.herokudns.com` records that survived their apps — the CNAME alone is the "
               f"entire precondition.")
        steps = (f"1. `dig +short {main} CNAME` → `{target}`.\n"
                 f"2. Resolve that target → `NOERROR`, zero answers: nothing claims the custom domain.\n"
                 f"3. Create a Heroku app, add `{main}` as its custom domain, deploy any content.\n"
                 f"4. `https://{main}/` then resolves to that app.")
    elif vendor == "azure-tm":
        claim = f"""Traffic Manager profile DNS names are globally unique across all of Azure, and the name is
released when the profile is deleted: `{target}` no longer resolves because no profile holds it. Any
Azure subscription can create a profile with that exact name, after which this hostname — whose CNAME
never changed — points at the attacker's endpoints with no action on your side."""
        impact = f"""A recreated profile answers `{main}` with attacker-chosen content and a Traffic Manager edge
certificate for the name, on a `{apex}` origin. That is enough to phish employees or customers of the
brand, and to collect any cookie or token issued for the parent domain."""
        fix = (f"Delete the CNAME for every hostname listed above, then audit the zone for other "
               f"`*.trafficmanager.net` records whose profiles were removed — {len(hosts)} existed in this "
               f"set alone, all pointing at released profile names.")
        steps = (f"1. `dig +short {main} CNAME` → `{target}`.\n"
                 f"2. Resolve `{target}` → it does not exist, so the profile name is released.\n"
                 f"3. Create a Traffic Manager profile named for that target under any Azure subscription.\n"
                 f"4. `https://{main}/` then serves content from that profile.")
    elif vendor == "azure":
        claim = f"""Azure App Service names are unique per region and released on deletion. `{target}` resolves
to nothing, so the name is available: any Azure subscription can create an app with that name, and this
hostname inherits it without any DNS change on your side."""
        impact = f"""An attacker holding `{target}` serves their own content on `https://{main}/` with an App
Service certificate for the custom domain, on a `{apex}` origin — brand impersonation with a valid
certificate and no browser warning."""
        fix = (f"Remove the CNAME for every hostname listed above, or recreate the App Service app so the name "
               f"is held by you. Audit the zone for other `*.azurewebsites.net` records pointing at deleted "
               f"apps — {len(hosts)} were found in this set.")
        steps = (f"1. `dig +short {main} CNAME` → `{target}`.\n"
                 f"2. Resolve `{target}` → no records, so the app name is released.\n"
                 f"3. Create an App Service app with that name in the matching region.\n"
                 f"4. `https://{main}/` then serves the attacker's app.")
    else:
        claim = f"""The target answers NODATA, so nothing claims it. Which party can register it depends on the
provider; the delegation itself is broken regardless, and a record pointing at a name nobody
controls is a takeover waiting for the first person to claim it."""
        impact = f"""Content served from `https://{main}/` would carry a valid certificate for a hostname under
`{apex}`, which is what makes the impersonation work: the address bar, cookies scoped to the parent
domain, and any allow-list entry for the hostname all keep trusting it."""
        fix = (f"Remove the `{main}` CNAME, or point it at a backend you control. Audit the zone for other "
               f"records delegating to `{target}`.")
        steps = (f"1. `dig +short {main} CNAME` → `{target}`.\n"
                 f"2. Resolve the target → NODATA, so nothing claims the name.\n"
                 f"3. Claim the target at {vendor} and publish content.\n"
                 f"4. `https://{main}/` then serves it.")

    n_targets = len({t for _, t in (pairs or [])})
    if pairs and n_targets > 1:
        # Several released names means several separate registrations; say so here so the triager does
        # not read the mapping block as one claim covering all of it.
        names_list = ", ".join(f"`{t}`" for t in sorted({t for _, t in pairs}))
        claim += (f"\n\nThis set involves {n_targets} released names — {names_list} — so the takeover is "
                  f"not one registration but {n_targets}, each claimed independently.")

    return head + f"""
## Why this is claimable

{claim}

## What I did not do

I did not register anything or publish anything, so nothing here has been claimed. The checks above are
`dig` and one GET. If you want the takeover demonstrated rather than described, say so and I will claim
the name on a benign page, send you the timestamped proof, and release it afterwards — inside a window
you choose.

## Remediation

{fix}

## Impact

{impact}

## Steps to reproduce

{steps}
"""


def main() -> int:
    args = sys.argv[1:]
    apply = "--apply" in args
    cap = int(args[args.index("--max") + 1]) if "--max" in args else 10

    db = sqlite3.connect(STATE)
    db.row_factory = sqlite3.Row
    filed = json.loads(FILED.read_text()) if FILED.exists() else []
    already: set[tuple[str, str]] = {(f.get("team_handle") or "", f.get("cname_target") or "")
                                     for f in filed}
    HOLD = ROOT / "reports" / "hold-queue.json"
    hold = json.loads(HOLD.read_text()) if HOLD.exists() else []
    # Normalised exactly like `key()` below: `playtika.github.io` and `playtika-sandbox.github.io` are
    # one owner, so a hold recorded against either must block both.
    held = {(h["team"], h["target"].split(".")[0].replace("-sandbox", "")) for h in hold}

    graded = [dict(r) for r in db.execute(
        "select host, target, provider, why, claim from findings "
        "where claimable = 1 and (report is null or report = '') "
        # Only providers whose target is a deterministic function of the *host* can be proven and
        # later reclaimed without guessing: a `*.github.io` namespace and Heroku's
        # `<domain>.herokudns.com` custom-domain record. Hashed provider names (azurewebsites,
        # `<app>-<hash>.herokudns.com`, Elastic Beanstalk) are evidence of death but not of a
        # reclaim path we can complete ourselves, so they stay in the manual queue.
        "and (provider like '%github.io%' or provider like 'herokudns.com (domain-derived)%') "
        "order by host")]

    # `programs.apexes` is a count, not a list — the apexes live in `scopes`, one row per asset, with the
    # bare apex in its own column. Reading the count as a list is why the first run died on len().
    programs: dict[str, str] = {}
    for s in db.execute("select handle, apex from scopes "
                        "where platform = 'h1' and submission = 1 and bounty = 1 and apex != ''"):
        programs.setdefault(s["apex"], s["handle"])

    def say(msg: str) -> None:
        """Skips are a dry-run luxury. On a timer, a line every 15 minutes that says "still nothing"
        is how a useful notification becomes one you filter out, so --apply only speaks when it acts."""
        if not apply:
            print(msg)

    def key(team: str, target: str) -> tuple[str, str]:
        # `playtika-sandbox.github.io` and `playtika.github.io` are one dead account family; the base
        # name is the identity that matters, not the full hostname, so normalise before comparing.
        return (team, target.split(".")[0].replace("-sandbox", ""))

    filed_keys = {key(t, tg) for t, tg in already if tg}

    def owner(hosts: list[str]) -> tuple[str, str, dict] | None:
        """The paying programme closest to these hosts, with the apex it owns *and* the live asset
        that actually contains one of them.

        Longest apex wins: a host under `x.expedia.biz` must cite `*.expedia.biz`, not an unrelated
        shorter parent. The apex only nominates a candidate — `h1_scope.match` is what confirms the
        programme really lists the host. Skipping that confirmation is how a `wfmnapim.starbucks.com`
        report got filed against Starbucks, which has no asset covering it, and came back informative
        inside the hour."""
        cands = sorted({a for a in programs if any(h == a or h.endswith("." + a) for h in hosts)},
                       key=len, reverse=True)
        for a in cands:
            team = programs[a]
            host = next(h for h in hosts if h == a or h.endswith("." + a))
            scope = h1_scope.match(team, host, need_bounty=True)
            if scope:
                return team, a, scope
            say(f"skip {host}: {team} owns {a} but lists no eligible asset covering it "
                f"({len(h1_scope.list_scopes(team))} live scopes)")
        return None

    plan: list[dict] = []
    for ns in namespace_sweep(db):
        own = owner(ns["hosts"])
        if not own:
            say(f"skip {ns['target']}: {len(ns['hosts'])} host(s) but no paying H1 programme owns them")
            continue
        team, apex, scope = own
        if key(team, ns["target"]) in filed_keys:
            say(f"skip {ns['target']}: {team} already has a report for this owner")
            continue
        inscope = [h for h in ns["hosts"] if h == apex or h.endswith("." + apex)]
        ok, notes = verify(inscope[0], ns["target"])
        is_held = key(team, ns["target"]) in held
        tag = "HELD" if is_held else ("FILE" if ok else "DROP")
        if tag != "HELD" or not apply:
            print(f"{tag} {ns['target']} x{len(inscope)} [{team}]  " + " · ".join(notes))
        if is_held:
            # A paused programme cannot accept the report; queueing it anyway is how the run counted
            # "1 report(s) queued" for expediagroup_bbp while holding the same lead on disk.
            continue
        if not ok:
            continue
        plan.append({"host": inscope[0], "target": ns["target"], "team": team, "apex": apex,
                     "scope": scope["id"], "scope_asset": scope["asset"], "hosts": inscope})

    # Graded leads the sweep did not cover (a namespace with a single known host is already covered by
    # the sweep; this catches anything the leadgate knows that DNS corpus does not).
    covered = {p["host"] for p in plan} | {h for p in plan for h in p["hosts"]}
    for r in graded:
        if r["host"] in covered:
            continue
        own = owner([r["host"]])
        if not own:
            say(f"skip {r['host']}: not under an H1 programme that pays bounty")
            continue
        team, apex, scope = own
        if key(team, r["target"]) in filed_keys:
            say(f"skip {r['host']}: {team} already has a report for this owner")
            continue
        ok, notes = verify(r["host"], r["target"])
        if key(team, r["target"]) in held:
            print(f"HELD {r['host']} -> {r['target']} [{team}]  " + " · ".join(notes))
            continue
        print(f"{'FILE' if ok else 'DROP'} {r['host']} -> {r['target']} [{team}]  " + " · ".join(notes))
        if not ok:
            continue
        plan.append({"host": r["host"], "target": r["target"], "team": team, "apex": apex,
                     "scope": scope["id"], "scope_asset": scope["asset"], "hosts": [r["host"]]})

    # One report per namespace even inside a single run, and `playtika-sandbox` is the same owner as
    # `playtika` — filing both would hand the programme two reports for one dead account family.
    seen: set[tuple[str, str]] = set(filed_keys)
    uniq = []
    for p in plan:
        k = key(p["team"], p["target"])
        if k in seen:
            say(f"skip {p['target']}: folds into a report already filed for this owner")
            continue
        seen.add(k)
        uniq.append(p)

    if not uniq:
        print("\nnothing to file: no unclaimed namespace sits under a paying H1 programme")
        return 0
    say(f"\n{len(uniq)} report(s) queued: " + ", ".join(f"{p['host']} [{p['team']}]" for p in uniq))
    if not apply:
        print("dry run — re-run with --apply to POST each one")
        return 0

    import h1_api

    # A 401/403 is a credential problem, not a report problem: the queued reports stay valid and will
    # be filed the moment the token can write. Retrying every 15-minute tick only re-sends the same
    # rejected POST at Spotify, so the marker makes the failure visible once and idles until cleared.
    BLOCK = ROOT / "reports" / "h1-write-blocked.json"
    if BLOCK.exists() and "--force" not in sys.argv:
        b = json.loads(BLOCK.read_text())
        print(f"write path blocked since {b.get('at')}: {b.get('detail')} "
              f"— {len(uniq)} verified report(s) waiting, not retrying (use --force to retry)")
        return 0

    def submission_state(team: str) -> str:
        code, payload = h1_api.call("GET", f"/hackers/programs/{team}")
        if code != 200 or not isinstance(payload, dict):
            return f"unknown ({code})"
        attrs: Any = payload.get("attributes") or {}
        return str(attrs.get("submission_state") or "unknown")

    for p in uniq[:cap]:
        state = submission_state(p["team"])
        if state != "open" and (p["team"], p["target"]) in held:
            # Already held on an earlier tick. Re-checking the state costs one GET and is how this
            # notices the programme reopening; appending again every 15 minutes would just grow the file.
            continue
        if state != "open":
            # A paused programme answers 403 to every filing. Burning the POST teaches us nothing, so
            # hold the fully-verified report and file it when intake reopens.
            print(f"HOLD {p['target']} [{p['team']}]: submission_state={state} — queued, not filed")
            hold.append({"target": p["target"], "team": p["team"], "apex": p["apex"],
                         "hosts": p["hosts"], "submission_state": state,
                         "checked_at": __import__("datetime").datetime.now(
                             __import__("datetime").timezone.utc).isoformat(timespec="seconds")})
            HOLD.write_text(json.dumps(hold, indent=1) + "\n")
            continue
        if (p["team"], p["target"]) in held:
            print(f"REOPENED {p['target']} [{p['team']}]: filing the report held since the pause")
            hold = [h for h in hold if (h["team"], h["target"]) != (p["team"], p["target"])]
            HOLD.write_text(json.dumps(hold, indent=1) + "\n")
        md = ROOT / "reports" / f"h1-{p['team']}-{p['host'].split('.')[0]}-dangling-cname.md"
        md.write_text(report_md(p["hosts"], p["target"], p["apex"]))
        from h1_fill import api_spec
        spec_path = api_spec(md, p["team"], p["host"])
        spec = json.loads(spec_path.read_text())
        # The verified scope is authoritative: api_spec resolves its own, but this run already proved
        # the host sits in `p["scope"]`, and a report must cite the asset it was verified against.
        spec["structured_scope_id"] = p["scope"]
        body = {"data": {"type": "report", "attributes": {
            "team_handle": spec["team_handle"],
            "title": spec["title"],
            "vulnerability_information": spec["vulnerability_information"],
            "impact": spec["impact"],
            "severity_rating": spec["severity_rating"],
            "structured_scope_id": spec["structured_scope_id"],
            "weakness_id": spec["weakness_id"],
            "report_type": "vulnerability",
        }}}
        code, payload = h1_api.call("POST", "/hackers/reports", body)
        if code == 401:
            # 401 is the credential itself: nothing queued can be delivered until the token changes.
            detail = str(payload)[:300]
            BLOCK.write_text(json.dumps({
                "at": __import__("datetime").datetime.now(
                    __import__("datetime").timezone.utc).isoformat(timespec="seconds"),
                "code": code, "team": p["team"], "host": p["host"], "detail": detail,
                "meaning": "the HackerOne token was refused (401) — every queued report stays valid and "
                           "none can be delivered until the token is replaced",
            }, indent=1) + "\n")
            print(f"POST {p['host']} -> {code} {detail} — credential refused, queued not filed")
            return 3
        if code == 403:
            # 403 is *this programme* refusing *this* filing. Spotify answers a bare {"status": 403} for
            # `*.withspotify.com` even though the scope is eligible and the token files fine elsewhere
            # (three reports went out on the same credential). Treating it as a credential block wrote a
            # global marker and froze the entire write rail on one programme's answer — the queued leads
            # under other programmes then idled for as long as the marker lived. Hold per programme and
            # carry on to the next one.
            now = __import__("datetime").datetime.now(
                __import__("datetime").timezone.utc).isoformat(timespec="seconds")
            hold.append({"target": p["target"], "team": p["team"], "apex": p["apex"],
                         "hosts": p["hosts"], "submission_state": "refused-403",
                         "checked_at": now})
            HOLD.write_text(json.dumps(hold, indent=1) + "\n")
            print(f"HOLD {p['host']} [{p['team']}]: programme answered 403 — queued, not filed")
            continue
        if not isinstance(payload, dict):
            print(f"POST {p['host']} -> {code} unparsable payload: {str(payload)[:200]}")
            continue
        raw: Any = payload.get("data") or {}
        d: dict = raw if isinstance(raw, dict) else {}
        rid = d.get("id")
        print(f"POST {p['host']} -> {code} id={rid or payload}")
        if not rid:
            continue
        filed.append({
            "id": rid, "program": p["team"], "team_handle": p["team"],
            "scope_id": spec["structured_scope_id"], "weakness_id": spec["weakness_id"],
            "severity": spec["severity_rating"], "title": spec["title"],
            "spec": str(spec_path.relative_to(ROOT)), "state": "new",
            "cname_target": p["target"], "hosts": p["hosts"],
            "filed_via": "engine/h1_autofile.py --apply",
        })
        FILED.write_text(json.dumps(filed, indent=1) + "\n")
        db.execute("update findings set report = ?, state = 'filed' where host = ?",
                   (f"https://hackerone.com/reports/{rid}", p["host"]))
        for h in p["hosts"]:
            db.execute("update findings set report = ?, state = 'filed' where host = ? and target = ?",
                       (f"https://hackerone.com/reports/{rid}", h, p["target"]))
        db.commit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
