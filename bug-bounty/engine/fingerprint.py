#!/usr/bin/env python3
"""Decide whether a CNAME to a hosted-platform name is a takeover or just a private site.

The DNS sweep only catches takeovers where the target stops resolving. Everything else — the majority of
real-world cases — looks like a normal 200/302 from the platform, and the difference between "this site is
gone, anyone can claim it" and "this site exists but is private" is one redirect header away.

So this pass probes the *in-scope hostname* (what an attacker would actually end up serving) and classifies
by the provider's own answer:

    UNCLAIMED      the platform says this name is not provisioned -> a lead worth a report
    PRIVATE-PAGES  the platform says the site exists but needs auth (GitHub Pages access control) -> NOT a
                   takeover; the custom domain is still bound to somebody else's page
    LIVE           200 with real content
    AMBIGUOUS      something answered but we cannot tell; never reported as a finding

Rules obeyed: one GET per host, no fuzzing, no wordlists, no payloads, and only hosts the scope gate
already cleared inside a *paying* programme.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import ssl
import sqlite3
import sys
import urllib.error
import urllib.request
import zlib
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from programs import in_scope  # noqa: E402

DB = Path(__file__).with_name("state.db")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"

# suffix -> (provider, markers of "not provisioned", note)
FINGERPRINTS: dict[str, tuple[str, list[str], str]] = {
    "github.io": ("GitHub Pages", ["there isn't a github pages site here", "site not found"],
                  "account name must be registerable; private pages redirect to /pages/auth"),
    "herokuapp.com": ("Heroku", ["no such app"], "app name free to create"),
    "netlify.app": ("Netlify", ["not found - request id", "site not found"], "site name free to claim"),
    "netlify.com": ("Netlify", ["not found - request id", "site not found"], "site name free to claim"),
    "vercel.app": ("Vercel", ["deployment_not_found", "the deployment could not be found"],
                   "project name free to claim"),
    "fly.dev": ("Fly.io", ["this page could not be found"], "app name free to create"),
    "onrender.com": ("Render", ["service not found"], "service name free to create"),
    "pantheonsite.io": ("Pantheon", ["the gods are angry", "unknown site"], "site name free to claim"),
    "myshopify.com": ("Shopify", ["sorry, this shop is currently unavailable"], "handle re-registerable"),
    "s3.amazonaws.com": ("S3", ["nosuchbucket", "the specified bucket does not exist"], "bucket free"),
    "elasticbeanstalk.com": ("Elastic Beanstalk", ["no such application"], "env name free to create"),
    "wpenginepowered.com": ("WP Engine", ["site not found", "this site is not found"],
                            "install name free to claim"),
    "readme.io": ("ReadMe", ["project not found"], "project name free to claim"),
    "surge.sh": ("Surge", ["project not found"], "domain free to claim"),
    "bitbucket.io": ("Bitbucket", ["repository not found"], "repo name free to create"),
    "ghost.io": ("Ghost", ["site not found"], "site name free to claim"),
    "tumblr.com": ("Tumblr", ["there's nothing here"], "blog name free to claim"),
    "uservoice.com": ("UserVoice", ["page not found"], "subdomain free to claim"),
    "strikingly.com": ("Strikingly", ["site not found"], "site name free to claim"),
    "simplebooklet.com": ("Simplebooklet", ["not found"], "name free to claim"),
    "smartjobboard.com": ("SmartJobBoard", ["not found"], "name free to claim"),
    "announcekit.app": ("AnnounceKit", ["not found"], "name free to claim"),
}

# Deliberately absent: cloudfront.net, fastly.net, azurefd.net, trafficmanager.net, azurewebsites.net.
# Shared/Microsoft-managed edge names either cannot be claimed by a stranger, or are already covered by
# the DNS pass (a deleted App Service returns NXDOMAIN, not a body).
SKIP = ("cloudfront.net", "fastly.net", "azurefd.net", "trafficmanager.net", "azurewebsites.net")

PRIVATE_MARKERS = ("/pages/auth", "pages/auth?")


def db() -> sqlite3.Connection:
    c = sqlite3.connect(DB, timeout=30)
    c.execute("PRAGMA busy_timeout=30000")
    c.execute("""CREATE TABLE IF NOT EXISTS fp_checks(
                   host TEXT, target TEXT, provider TEXT, status INTEGER, verdict TEXT,
                   marker TEXT, note TEXT, checked_at TEXT, PRIMARY KEY(host))""")
    return c


def provider_of(target: str):
    t = (target or "").lower().rstrip(".")
    for suffix, spec in FINGERPRINTS.items():
        if t.endswith("." + suffix) or t == suffix:
            return spec
    return None


def fetch(url_host: str, timeout: int = 10, https_only: bool = True):
    """One GET, redirects NOT followed (the Location header is the evidence). Body capped at 12 KiB."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):  # noqa: D401
            return None

    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ctx))
    schemes = ("https",) if https_only else ("https", "http")
    err = ""
    for scheme in schemes:
        req = urllib.request.Request(f"{scheme}://{url_host}/",
                                     headers={"User-Agent": UA, "Accept": "text/html,*/*"})
        try:
            with opener.open(req, timeout=timeout) as r:
                return r.status, dict(r.headers), r.read(12000).decode("utf-8", "replace").lower()
        except urllib.error.HTTPError as e:
            try:
                body = e.read(12000).decode("utf-8", "replace").lower()
            except Exception:  # noqa: BLE001
                body = ""
            return e.code, dict(e.headers or {}), body
        except Exception as e:  # noqa: BLE001
            err = f"error:{type(e).__name__}"
    return 0, {}, err


def classify(provider: str, status: int, headers: dict, body: str, markers: list[str]):
    loc = headers.get("Location") or headers.get("location") or ""
    if provider == "GitHub Pages" and any(m in loc for m in PRIVATE_MARKERS):
        return "PRIVATE-PAGES", "redirected to Pages access control - domain still bound"
    hit = next((m for m in markers if m in body), None)
    if hit:
        return "UNCLAIMED", hit
    if status == 0:
        return "NO-RESPONSE", body[:60]
    if status == 200:
        return "LIVE", ""
    if any(m in loc for m in PRIVATE_MARKERS):
        return "PRIVATE-PAGES", "access control redirect"
    if status in (301, 302, 307, 308):
        return "REDIRECT", loc[:80]
    if status in (401, 403, 503):
        return "PROVIDER-ERROR", ""
    return "AMBIGUOUS", ""


def cmd_run(a) -> None:
    c = db()
    edges = c.execute("SELECT host, target FROM cnames").fetchall()
    todo: dict[str, dict] = {}
    for host, target in edges:
        spec = provider_of(target)
        if not spec or host in todo:
            continue
        if any((target or "").lower().endswith(s) for s in SKIP):
            continue
        todo[host] = {"host": host, "target": target, "provider": spec[0],
                      "markers": spec[1], "note": spec[2]}

    kept = {}
    for host, row in todo.items():
        sc = [h for h in in_scope(host) if h["pays"]]
        if not sc:
            continue
        row["scope"] = sc[0]
        kept[host] = row

    # Rotation, not repetition: the pool is far larger than one pass, so a tick takes one shard and
    # skips hosts probed recently. Without this every run re-probes the same head of the list forever
    # and the tail is never seen — the same starvation that made the DNS sweep look idle.
    if a.host:
        kept = {h: r for h, r in kept.items() if h == a.host or h.endswith("." + a.host)}
    elif a.skip_days > 0:
        cutoff = f"-{a.skip_days} days"
        fresh = {h for (h,) in c.execute(
            "SELECT host FROM fp_checks WHERE checked_at > datetime('now', ?)", (cutoff,))}
        kept = {h: r for h, r in kept.items() if h not in fresh}
    if a.shard != "1/1" and not a.host:
        i, n = (int(x) for x in a.shard.split("/"))
        kept = {h: r for h, r in kept.items() if zlib.crc32(h.encode()) % n == (i - 1) % n}
    if a.limit:
        kept = dict(list(kept.items())[: a.limit])
    print(f"{len(todo)} provider-shaped hosts, {len(kept)} on paying in-scope hosts; probing the hosts")

    def work(host: str):
        row = kept[host]
        # Probe the *target*, not the host. The name that can be claimed is the platform name; the
        # custom host only proves the DNS edge is still published. Asking the host instead is how
        # www.audiotour.karwei.nl got reported: Netlify answers "not found" on that Host header even
        # though karwei.netlify.app is a live site the owner controls.
        status, headers, body = fetch(row["target"])
        verdict, marker = classify(row["provider"], status, headers, body, row["markers"])
        # A 404 that turns into a 200 is a deploy in progress, not a takeover. One re-check, seconds
        # later, separates the two classes before anything is written to the DB.
        if verdict == "UNCLAIMED":
            s2, h2, b2 = fetch(row["target"])
            v2, _ = classify(row["provider"], s2, h2, b2, row["markers"])
            if v2 != "UNCLAIMED":
                verdict, marker = "UNSTABLE", f"answered {v2} (http {s2}) on re-check — deploy in progress"
        # ...and the host end has to be dead as well. `chordplayer.spotify.net` has a target that
        # answers Netlify's 404 while the host serves a live 200 app, because the domain is bound to a
        # site whose canonical name is something else. One free end does not make a takeover.
        if verdict == "UNCLAIMED":
            hs, _hh, hb = fetch(host)
            body = hb or ""
            if hs == 200 and len(body) > 500 and not any(
                    m.lower() in body.lower() for m in row["markers"]):
                verdict, marker = "LIVE", f"host serves a page itself (http 200, {len(body)} bytes) — bound"
        # A GitHub Pages "no site here" only matters if the *owner* is gone. `github.github.io` is
        # unprovisioned but the `github` account obviously still exists, so nobody can create it — the
        # name is dead, not claimable. One extra request to github.com/<owner> separates the two, and
        # skipping it is how the same false positive gets re-reported for months.
        if verdict == "UNCLAIMED" and row["provider"] == "GitHub Pages":
            owner = (row["target"] or "").split(".")[0]
            try:
                req = urllib.request.Request(f"https://github.com/{owner}", method="GET",
                                             headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=15) as r:
                    owner_status = r.status
            except urllib.error.HTTPError as e:
                owner_status = e.code
            except Exception:
                owner_status = 0
            if owner_status == 200:
                verdict, marker = "NOT-CLAIMABLE", f"github.com/{owner} still exists (200)"
            elif owner_status == 404:
                marker = f"github.com/{owner} free (404) — {marker}"
        return row, status, verdict, marker

    with cf.ThreadPoolExecutor(max_workers=max(1, a.workers)) as ex:
        for row, status, verdict, marker in ex.map(work, list(kept)):
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            c.execute("""INSERT INTO fp_checks(host,target,provider,status,verdict,marker,note,checked_at)
                         VALUES(?,?,?,?,?,?,?,?)
                         ON CONFLICT(host) DO UPDATE SET target=excluded.target, status=excluded.status,
                           verdict=excluded.verdict, marker=excluded.marker, checked_at=excluded.checked_at""",
                      (row["host"], row["target"], row["provider"], status, verdict, marker,
                       row["note"], now))
            c.commit()
            if verdict in ("UNCLAIMED", "PRIVATE-PAGES") or a.verbose:
                print(f"  {verdict:13} {row['host'][:46]:46} -> {row['target'][:38]:38} "
                      f"[{row['provider']}] {row['scope']['platform']}:{row['scope']['handle']} "
                      f"{status} {marker[:30]}", flush=True)
    print(f"{len(kept)} hosts probed")


def cmd_show(a) -> None:
    c = db()
    for verdict in ("UNCLAIMED", "PRIVATE-PAGES", "LIVE", "AMBIGUOUS", "NO-RESPONSE", "REDIRECT"):
        n = c.execute("SELECT count(*) FROM fp_checks WHERE verdict=?", (verdict,)).fetchone()[0]
        print(f"{verdict:14} {n}")
    print()
    for h, t, p, st, m in c.execute("""SELECT host,target,provider,status,marker FROM fp_checks
                                       WHERE verdict='UNCLAIMED' ORDER BY provider"""):
        print(f"  {p:16} {h[:52]:52} -> {t[:38]:38} {st} {m[:30]}")


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.set_defaults(fn=cmd_run)
    r.add_argument("--workers", type=int, default=4)
    r.add_argument("--limit", type=int, default=0)
    r.add_argument("--shard", default="1/1", help="i/N — take one rotation slot of the pool")
    r.add_argument("--skip-days", type=int, default=1, dest="skip_days",
                   help="do not re-probe a host checked within this many days (0 = never skip)")
    r.add_argument("--host", default="", help="probe only this host (ignores shard/skip)")
    r.add_argument("--verbose", action="store_true")
    s = sub.add_parser("show"); s.set_defaults(fn=cmd_show)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
