#!/usr/bin/env python3
"""Turn verified cross-platform matches into one submission-ready report per programme.

Reads either match file — YesWeHack's `reports/ywh-matches.json` or the four-platform
`reports/scope-matches-all.json` — groups by platform+programme, re-verifies every host at draft time,
and writes one report per programme. A draft is only ever built from records that still pointed at a
dead target at the moment of writing, because a stale file is exactly how a false positive reaches a
programme's inbox.

  python3 engine/ywh_draft.py                                          # YWH matches (default)
  python3 engine/ywh_draft.py --source reports/scope-matches-all.json --platform it
  python3 engine/ywh_draft.py --slug teamviewer-bounty-program
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from verify_finding import check  # noqa: E402

OUTDIR = ROOT / "reports"
DEFAULT_SOURCE = ROOT / "reports" / "ywh-matches.json"

PLATFORM_URL = {
    "h1": "https://hackerone.com/{h}",
    "bc": "https://bugcrowd.com/{h}",
    "it": "https://app.intigriti.com/programs/{h}/detail",
    "yw": "https://yeswehack.com/programs/{h}",
}
PLATFORM_NAME = {"h1": "HackerOne", "bc": "Bugcrowd", "it": "Intigriti", "yw": "YesWeHack"}

HEADER = """# {title} — dangling CNAME takeover ({n} host{n_s})

**Platform:** {platform_name} · `{handle}`
**Programme page:** {url}
**Reward grid:** {grid}
**Severity:** Medium — CVSS 3.1 `6.1` `AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N`
**Records verified live:** {ts}
**Researcher:** Michael Cluer (RDW Labz) · security@rdwlabz.com

## Summary

{n} hostnames in `{scope}` still carry CNAME records pointing at Azure resources that no longer
exist. Azure app names and Traffic Manager profile names are globally unique and are released when
the resource is deleted, so any Azure account can register the same name and answer for those
hostnames — over HTTPS, with a valid certificate for the exact name, because the DNS-01 challenge
is served by the record that still exists.

This is a subdomain takeover. The practical severity comes from where these names sit: an attacker
hosting content on `{example}` inherits the trust of the parent domain for phishing, and captures
any credential, cookie or bearer token still addressed to the hostname.

| Host | CNAME target | Target state |
|---|---|---|
{rows}

## Reproduction

```
{dig}
```

Each target returns NXDOMAIN across independent resolvers while the CNAME itself is still published,
which is the signature of a deleted resource behind a live record.

## Proof of claimability (safe, no claim made)

The name to register is the leftmost label of each target (`{claim_example}`), registered as an
Azure Web App for `azurewebsites.net` targets or a Traffic Manager profile for `trafficmanager.net`
targets. I have not registered any of them and will not — the point of this report is the fix, not
the claim.

## Impact

- Attacker-controlled content served on a trusted `{scope}` hostname, with a trusted certificate.
- Phishing that survives domain scrutiny; bypass of allow-lists keyed on the parent domain
  (CORS origins, `redirect_uri` values, CSP entries, proxy trust rules).
- Capture of credentials or tokens still configured for the dead hostname — including any client
  that resolves it before the record is removed.
- For `dev-*` and `*-mobile-*` style hosts: staging and customer-facing tooling that trusts the
  parent domain.

## Remediation

1. Delete the CNAME record for each host listed above. This alone closes the exposure.
2. Add "remove DNS records for a resource" to the decommission checklist for Azure resources —
   deleting the app but leaving the record is the root cause here.
3. Audit the zone for CNAME targets that no longer resolve (`dig +short <target>` returns nothing)
   and treat the result as a recurring hygiene task, not a one-off.
4. If a hostname must be retired but kept, point it at a controlled sink (an owned app or a static
   "not in use" page) instead of leaving a dangling record.

## Notes on testing

Detection was fully passive: certificate transparency logs, public DNS, and CNAME resolution. No
HTTP request was made to the dangling hostnames, no account was created on any of them, and nothing
was claimed. If you would like a live takeover PoC, I am happy to coordinate a controlled test with
you first — I will not claim a production name without written authorisation.
"""


def load(source: Path) -> list[dict]:
    if not source.exists():
        print(f"no {source} — run the matcher first (bb match)")
        return []
    rows = json.loads(source.read_text())
    # scope-matches-all.json carries only host/platform/handle — the CNAME target lives in state.db.
    if any("target" not in r for r in rows):
        import sqlite3
        db = sqlite3.connect(f"file:{HERE / 'state.db'}?mode=ro", uri=True)
        tgt = {h: t for h, t in db.execute(
            "SELECT host, target FROM findings WHERE claimable=1 GROUP BY host")}
        for r in rows:
            r.setdefault("target", tgt.get(r["host"], ""))
    out = []
    for raw in rows:
        m = dict(raw)
        if not m.get("target"):
            print(f"  skip {m['host']}: no CNAME target on record")
            continue
        m.setdefault("platform", "yw")                       # ywh-matches.json predates platform keys
        m["handle"] = m.get("handle") or m.get("program") or "unknown"
        m["title"] = m.get("title") or m["handle"]
        if m.get("grid_min") is None:
            m["grid"] = "bounty-eligible" if m.get("bounty") else "no bounty advertised"
        else:
            m["grid"] = f"{m['grid_min']}–{m['grid_max']}"
        m["url"] = PLATFORM_URL.get(m["platform"], "{h}").format(h=m["handle"])
        m["scope"] = m.get("asset") or ".".join(m["host"].split(".")[-2:])
        out.append(m)
    return out


def main() -> int:
    argv = sys.argv[1:]
    source = Path(argv[argv.index("--source") + 1]) if "--source" in argv else DEFAULT_SOURCE
    only_platform = argv[argv.index("--platform") + 1] if "--platform" in argv else None
    want = argv[argv.index("--slug") + 1] if "--slug" in argv else None

    matches = load(source)
    if not matches:
        return 1

    groups: dict[tuple[str, str], list[dict]] = {}
    for m in matches:
        if only_platform and m["platform"] != only_platform:
            continue
        groups.setdefault((m["platform"], m["handle"]), []).append(m)

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    written = 0
    for (platform, handle), group in groups.items():
        if want and handle != want:
            continue
        # Refuse to draft for a programme that is not accepting submissions. Writing the report first
        # and discovering `paused` from a bare 403 at POST time wastes the scarcest thing here.
        from program_state import is_open
        if platform == "h1" and is_open(handle) is False:
            print(f"  {platform}:{handle} is PAUSED on the platform — draft skipped")
            continue
        # Re-verify at draft time; a host whose record was cleaned up drops out of the report.
        live = []
        for m in group:
            rc, msg = check(m["host"], m["target"])
            print(f"  {'OK ' if rc == 0 else 'DROP'} {m['host']}  {msg if rc else ''}")
            if rc == 0:
                live.append(m)
        if not live:
            print(f"  {platform}:{handle} — nothing live, no draft written")
            continue

        hosts = [m["host"] for m in live]
        rows = "\n".join(f"| `{m['host']}` | `{m['target']}` | NXDOMAIN |" for m in live)
        digs = "\n".join(
            f"dig +short CNAME {m['host']}     # -> {m['target']}\n"
            f"dig +short A     {m['target']}   # -> (empty) NXDOMAIN" for m in live)

        body = HEADER.format(
            title=live[0]["title"], n=len(live), n_s="" if len(live) == 1 else "s",
            platform_name=PLATFORM_NAME.get(platform, platform), handle=handle,
            url=live[0]["url"], grid=live[0]["grid"], ts=ts, scope=live[0]["scope"],
            rows=rows, dig=digs, claim_example=live[0]["target"].split(".")[0], example=hosts[0],
        )
        safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in handle).strip("-")
        path = OUTDIR / f"{platform}-{safe}-dangling-cname.md"
        path.write_text(body)
        print(f"  wrote {path}  ({len(live)} verified record{'' if len(live) == 1 else 's'})")
        written += 1
    print(f"{written} draft(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
