#!/usr/bin/env python3
"""Gate for anything the cron is about to call a lead.

Two false leads in one day, both from the same mistake — trusting a single cheap observation.

  HARMAN   `heosdiagnostics.denon.com` was announced with "programme: HARMAN International" because
           the *brand* domain resolves to a programme. Harman's published scope is 67 named hosts on
           harmanaudio.com / harmankardon.com and **zero** denon.com entries, so the record is real
           and unpaid. Attaching a programme name to it invites someone to file out of scope.

  Karwei   `www.audiotour.karwei.nl` was announced as claimable because karwei.netlify.app answered
           404 once. It answers 200 with the site's own title on the next look: Netlify was between
           deploys. One sample cannot tell "deleted by the owner" from "owner is redeploying".

So this module answers exactly two yes/no questions, and the cron is only allowed to shout when both
are yes:

  covered(host)   is there a *paying scope asset* that actually covers this hostname, and which
                  platform + handle do I file it under?
  unclaimed(...)  does the platform still say "nothing here" on three samples spaced over seconds?

Read-only. Three GETs per confirmation, no payloads.
"""
from __future__ import annotations

import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jsscan import DB, build_scope_index, covering_scope  # noqa: E402
from fingerprint import classify, fetch, provider_of  # noqa: E402


def nxdomain(name: str) -> bool:
    """True when the name does not exist at all — the DNS form of "released by the platform"."""
    try:
        import dns.resolver  # type: ignore
        import dns.exception  # type: ignore
        try:
            dns.resolver.resolve(name, "A", lifetime=6)
            return False
        except dns.resolver.NXDOMAIN:
            return True
        except (dns.resolver.NoAnswer, dns.resolver.NoNameservers, dns.exception.Timeout):
            return False
    except ImportError:
        import subprocess
        r = subprocess.run(["dig", "+short", "+tries=2", "+time=4", name, "A"],
                           capture_output=True, text=True, timeout=20)
        return not r.stdout.strip()


def covered(host: str, paying_only: bool = True) -> dict | None:
    """The paying scope asset that covers this host, or None.

    covering_scope() matches the scope *asset* (wildcard or URL) against the hostname; unlike the
    old brand-domain join it cannot attribute a denon.com host to a programme that never listed one.
    """
    db = sqlite3.connect(str(DB))
    exact, wild = build_scope_index(db, paying_only)
    base, rows = covering_scope(host, exact, wild)
    if not base or not rows:
        return None
    return {"scope": base, "platform": rows[0][0], "handle": rows[0][1]}


def github_owner(name: str) -> bool:
    """True when github.com/<name> resolves to a real account.

    A GitHub Pages "no site here" only matters if the *owner* is gone. `github.github.io` serves the
    same 404 as an unregistered name, but the `github` account obviously exists, so nobody can create
    it — dead, not claimable. Playtika is the opposite case: github.com/playtika and
    api.github.com/users/playtika both 404, so the name is available.
    """
    import urllib.error
    import urllib.request
    req = urllib.request.Request(f"https://api.github.com/users/{name}",
                                 headers={"User-Agent": "rdw-recon/1.0", "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status == 200
    except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
        return e.code != 404
    except Exception:
        return True  # unknown → assume alive, which suppresses rather than over-claims


def serves_content(host: str, provider: str, markers) -> tuple[bool, str]:
    """Does the *host* still serve a real page? If it does, the record is not dangling.

    The mirror of the Karwei bug, found on `chordplayer.spotify.net`: its CNAME target
    `chordplayer.netlify.com` answers Netlify's 404 while the host itself returns 200 with a live
    React app — the domain is bound to a site that exists, and the .netlify.com alias is simply not
    that site's canonical name. Both ends have to be dead before a record is claimable.
    """
    status, _headers, body = fetch(host)
    if status != 200:
        return False, ""
    text = (body or "").lower()
    if any(m.lower() in text for m in markers):
        return False, ""
    if len(text) < 500:
        return False, ""
    return True, (f"{host} itself serves a live page (http 200, {len(text)} bytes) — the domain is "
                  f"bound; nothing to claim")


def unclaimed(host: str, target: str, samples: int = 3, gap: float = 1.5) -> tuple[bool, str]:
    """Confirm the platform still considers the *name* free, on `samples` spaced passes.

    Claimability lives at the platform name, not at the custom host. karwei.netlify.app serves a
    live site while www.audiotour.karwei.nl answers Netlify's "not found" page — the site name is
    owned, the custom domain was simply never attached. Probing the host alone would call that a
    takeover; probing the target gets it right.

    Every pass must agree. A 404 that becomes a 200 is a deploy, not a takeover, and saying so costs
    three GETs; saying the opposite burns the programme's trust.
    """
    spec = provider_of(target)
    if not spec:
        # No HTTP fingerprint for this platform: an NXDOMAIN target is the stronger signal anyway —
        # for Azure and Traffic Manager the name is released the moment the resource is deleted.
        seen = []
        for i in range(samples):
            if i:
                time.sleep(gap)
            seen.append(nxdomain(target))
        if all(seen):
            return True, f"{target} NXDOMAIN {samples}/{samples} (name released by the platform)"
        return False, f"{target} has DNS answers — resource still exists"
    provider, markers, _ = spec
    verdicts = []
    for i in range(samples):
        if i:
            time.sleep(gap)
        status, headers, body = fetch(target)
        if status == 0:
            verdicts.append("NO-RESPONSE")
            continue
        v, _marker = classify(provider, status, headers, body, markers)
        verdicts.append(v)
        if v != "UNCLAIMED":
            return False, (f"target sample {i + 1}/{samples} answered {v} (http {status}) — "
                           f"the site name is owned")
    if provider == "GitHub Pages":
        owner = target.split(".")[0]
        if github_owner(owner):
            return False, f"github.com/{owner} still exists — the site name is taken"
        live, why = serves_content(host, provider, markers)
        if live:
            return False, why
        return True, (f"{provider} 'no site here' {samples}/{samples}, github.com/{owner} is "
                      f"unregistered, and {host} serves nothing — the name is available")
    if all(v == "UNCLAIMED" for v in verdicts):
        live, why = serves_content(host, provider, markers)
        if live:
            return False, why
        return True, (f"{provider} returned its 'no site here' page {samples}/{samples} times and "
                      f"{host} serves nothing")
    return False, f"inconsistent verdicts: {', '.join(verdicts)}"


def verdict(host: str, target: str, samples: int = 3) -> dict:
    scope = covered(host)
    ok, evidence = unclaimed(host, target, samples=samples) if scope else (False, "no paying scope")
    return {"host": host, "target": target, "scope": scope, "claimable": ok, "evidence": evidence,
            "file": bool(scope and ok)}


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        return
    host = sys.argv[1]
    target = sys.argv[2] if len(sys.argv) > 2 else ""
    v = verdict(host, target)
    print(f"{v['host']}")
    print(f"  scope:     {v['scope'] or 'NONE — no paying asset covers this host'}")
    print(f"  claimable: {v['claimable']} ({v['evidence']})")
    print(f"  action:    {'FILE on ' + v['scope']['platform'] + ':' + v['scope']['handle'] if v['file'] else 'do not file'}")


if __name__ == "__main__":
    main()
