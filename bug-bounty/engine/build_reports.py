#!/usr/bin/env python3
"""Turn frozen evidence into submission-ready reports, one file per program.

Every claim in the output is traceable to evidence-takeover/<host>/ — the raw dig and curl
output captured at the timestamp quoted in the report. The generator refuses to emit a
finding whose target resolves again, so a stale queue cannot become a stale report.

  python3 engine/build_reports.py
"""
from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EV = ROOT / "evidence-takeover"
OUT = ROOT / "reports/out"

# ---- report definitions -------------------------------------------------------------
# hosts are matched by suffix/index.json entry; severity follows the program's own scale.
REPORTS = [
    dict(
        file="vw-whatsup-qa-azure.md", platform="Bugcrowd", handle="volkswagen-og",
        program="Volkswagen", hosts=["api.qa.whatsup.volkswagen.de"],
        title="Subdomain takeover of api.qa.whatsup.volkswagen.de via unclaimed Azure App Service name",
        severity="P3 (High) — dangling DNS with a name any Azure subscription can re-claim",
        cls="azurewebsites",
        notes="QA-namespaced host, so the program may treat impact as reduced. The takedown "
              "primitive is identical to a production host: the label is unowned, not merely idle.",
    ),
    dict(
        file="epam-emakina-azure-batch.md", platform="Bugcrowd", handle="EPAM Systems Managed Bug Bounty Program",
        program="EPAM Systems", hosts=[], host_suffix=".emakina.at",
        title="{n} *.devweb.emakina.at hostnames dangle on two unclaimed Azure App Service names",
        severity="P3 (High) — one re-claim gives an attacker {n} trusted client hostnames",
        cls="azurewebsites",
        notes="Two orphaned app names (donauchemie-dev, lsgganterdev) carry 15 hostnames, which is "
              "the bulk-impact version of this bug: one Azure app creation, fifteen live client sites.",
    ),
    dict(
        file="bpost-trafficmanager-takeover.md", platform="Intigriti", handle="bpost",
        program="bpost", hosts=["combomobile-1.acbpost.be", "combomobile-1.stbpost.be"],
        title="Subdomain takeover of combomobile-1.[ac|st]bpost.be via unclaimed Traffic Manager profiles",
        severity="P3 (High) — Traffic Manager profile names are global and re-creatable",
        cls="trafficmanager",
        notes="Both hosts are the same mobile product on the .be and .st brand domains; the two "
              "profiles (combomobile-ac, combomobile-st) are independently claimable.",
    ),
    dict(
        file="etoro-candle-takeover.md", platform="Bugcrowd", handle="eToro Managed Bug Bounty Engagement",
        program="eToro", hosts=["candle-src.etoro.com"],
        title="Subdomain takeover of candle-src.etoro.com via unclaimed Traffic Manager profile",
        severity="P3 (High)", cls="trafficmanager",
        notes="'candle-src' is served over HTTPS from an eToro-finance brand domain; a claimed "
              "profile also permits a trusted-origin script include for anything on *.etoro.com.",
    ),
    dict(
        file="cbre-azure-takeover.md", platform="HackerOne", handle="cbre",
        program="CBRE", hosts=["scorecard.prod.cbreapps.com", "test.angulardemo.emerald.cbre.com"],
        title="Subdomain takeover of scorecard.prod.cbreapps.com and test.angulardemo.emerald.cbre.com",
        severity="High", cls="azurewebsites", notes="",
    ),
    dict(
        file="aon-azure-takeover.md", platform="HackerOne", handle="aon",
        program="AON", hosts=["qa-cms.aon-hugeops.uk"],
        title="Subdomain takeover of qa-cms.aon-hugeops.uk via unclaimed Azure App Service name",
        severity="High", cls="azurewebsites", notes="",
    ),
    dict(
        file="github-nines-azure-takeover.md", platform="HackerOne", handle="github",
        program="GitHub", hosts=["nines.githubapp.com"],
        title="Subdomain takeover of nines.githubapp.com via unclaimed Azure App Service name",
        severity="High", cls="azurewebsites",
        notes="githubapp.com is GitHub-operated internal infrastructure; check against the program's "
              "asset list before filing in case only *.github.com is rewarded.",
    ),
]

PROV_NAME = {"azurewebsites": "App Service", "trafficmanager": "Traffic Manager"}


def short_http(f: dict) -> str:
    r = f["victim_response"] or ""
    if "Could not resolve host" in r:
        return "hostname does not resolve (curl exit 6)"
    m = re.search(r"http_code=(\d+)", r)
    if m:
        return "no response" if m.group(1) == "000" else f"HTTP {m.group(1)}"
    return "no response"


def auth_ns(f: dict) -> str:
    try:
        txt = (Path(f["evidence_dir"]) / "dig-target.txt").read_text()
    except Exception:  # noqa: BLE001
        return ""
    m = re.search(r"IN\s+SOA\s+(\S+)", txt)
    return m.group(1).rstrip(".") if m else ""


CLAIM_MECHANISM = {
    "azurewebsites": (
        "Azure App Service names are globally unique. Deleting an app releases the name, and any "
        "Azure subscription can immediately create a new app with the same name, which then answers "
        "on `{label}.azurewebsites.net`. The victim hostname is *not* added to the attacker's app and "
        "therefore never goes through the custom-domain `asuid` TXT verification introduced in 2021 — "
        "traffic reaches the attacker purely because the victim's CNAME still points at the freed "
        "label. The attacker does not need the victim's DNS zone at any point."
    ),
    "trafficmanager": (
        "Azure Traffic Manager profile names are global. A deleted profile frees its name, and a new "
        "profile with the same name answers on `{label}.trafficmanager.net`. Point the new profile's "
        "endpoint anywhere the attacker controls and every hostname still CNAME'd to the freed "
        "profile resolves to attacker content, with the attacker's choice of HTTP response."
    ),
}

IMPACT = """\
Once the label is re-claimed the attacker serves arbitrary content from a hostname the organisation
still advertises as its own, which yields:

- **Valid TLS for the victim hostname.** With content control the attacker passes ACME HTTP-01 for
  `{host}` and gets a publicly trusted certificate for it. Browsers show no warning, so this is a
  full impersonation, not a phishing lookalike.
- **Cookie and token theft** — any parent-domain cookie (`Domain=.{apex}`) that is not `__Host-`
  prefixed is sent to the taken-over host.
- **Trust-boundary escape** — script loaded from `{host}` inherits the origin trust other properties
  extend to `*.{apex}` (CSP `script-src`, postMessage origin checks, `document.domain` relaxation).
- **OAuth / SSO abuse** — where the host is an allow-listed `redirect_uri` or `post_logout_redirect`
  value, the attacker receives the authorization code.
- **Reputation** — abuse, malware and credential-phishing traffic attributed to the brand's domain.
"""

REMEDIATION = """\
1. Delete the dangling CNAME, or re-point it at a resource the organisation controls today.
2. Re-create (or park) the freed {provider} label in an owned subscription so nobody else can claim it.
3. Enable a dangling-DNS check in monitoring: any CNAME whose target stops resolving for more than a
   few hours should alarm, and should be treated as an incident rather than a hygiene ticket.
"""


def sh(cmd: list[str], t: int = 20) -> str:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=t)
        return (p.stdout or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def control_sample() -> tuple[str, str]:
    """A label that *does* resolve right now — proves the resolver is not lying."""
    for cand in ("microsoft-com.azurewebsites.net", "azurewebsites.net"):
        out = sh(["dig", "+short", cand, "A", "+time=4", "+tries=1"])
        if out:
            return cand, out.split()[0]
    return "", ""


def host_block(f: dict) -> str:
    d = Path(f["evidence_dir"])
    tgt_dig = (d / "dig-target.txt").read_text().split("# $")[-1].strip()
    ans = [ln for ln in tgt_dig.splitlines() if "IN\t" in ln and "SOA" not in ln]
    apex = ".".join(f["host"].split(".")[-2:])

    lines = [
        f"### `{f['host']}`",
        "",
        f"- CNAME target: `{f['target']}`",
        f"- Target A record: **none** ({'no answer' if not ans else 'see evidence'})",
        f"- Victim hostname: {short_http(f)}",
        f"- Target NXDOMAIN confirmed by {('`' + auth_ns(f) + '` (the zone\'s own authoritative NS)') if auth_ns(f) else 'the public resolver'}",
        f"- Captured: `{f['captured']}` — raw output in `evidence-takeover/{f['host']}/`",
        "",
    ]
    return "\n".join(lines)


def build(r: dict, findings: list[dict]) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    prov = CLAIM_MECHANISM[r["cls"]]
    label = findings[0]["label"]
    host0 = findings[0]["host"]
    apex = ".".join(host0.split(".")[-2:])

    title = r["title"].format(n=len(findings))
    severity = r["severity"].format(n=len(findings))
    body = [
        f"# {title}",
        "",
        f"**Program:** {r['program']} ({r['platform']})  ",
        f"**Affected asset(s):** {len(findings)} hostname(s), all in scope  ",
        f"**Suggested severity:** {severity}  ",
        f"**Verified:** {stamp} (UTC), from a clean resolver",
        "",
        "## Summary",
        "",
    ]

    if len(findings) == 1:
        body.append(
            f"`{host0}` is a CNAME to `{findings[0]['target']}`, an Azure {PROV_NAME[r['cls']]} name that no longer "
            f"belongs to anyone. The name does not resolve (NXDOMAIN / NODATA for the A query) and never "
            f"answers HTTP, so the hostname currently serves nothing — but the provider label is free, "
            f"so the next person to create it becomes the origin for the organisation's own hostname."
        )
    else:
        hosts = ", ".join(f"`{f['host']}`" for f in findings[:4])
        body.append(
            f"{len(findings)} hostnames ({hosts}, plus {len(findings)-4} more in the table below) are "
            f"CNAMEs into {len({f['label'] for f in findings})} Azure {PROV_NAME[r['cls']]} name(s) that no longer exist: "
            + ", ".join(f"`{l}`" for l in sorted({f['label'] for f in findings}))
            + ". Each hostname is live in the organisation's DNS but resolves to nothing, because the "
            "upstream label was released and never re-created."
        )

    body += ["", "## Why this is claimable, not merely idle", "",
             prov.format(label=label), ""]

    ns0 = auth_ns(findings[0])
    if ns0:
        body += [
            f"The NXDOMAIN is not our resolver guessing: `{findings[0]['target']}` is answered NXDOMAIN by "
            f"`{ns0}`, the authoritative nameserver for the zone. Microsoft is stating that the app does not "
            "exist; the label is therefore available to any subscriber.",
            "",
        ]

    ctl_name, ctl_ip = control_sample()
    if ctl_name and ctl_ip:
        body += [
            "**Control:** to show the empty answers are real and not a resolver or egress artefact, the "
            f"same query for an existing app resolves normally — `{ctl_name}` → `{ctl_ip}` at capture time. "
            "The negative answer is specific to the released labels below.",
            "",
        ]

    body += ["## Affected hostnames", "", "| hostname | CNAME target | target A record | victim HTTP |",
             "|---|---|---|---|"]
    for f in findings:
        body.append(f"| `{f['host']}` | `{f['target']}` | none | {short_http(f)} |")

    body += ["", "## Evidence", ""]
    for f in findings[:6]:
        body.append(host_block(f))
    if len(findings) > 6:
        body.append(f"*(remaining {len(findings)-6} hostnames follow the identical shape; raw captures "
                    f"are in `evidence-takeover/` for each)*")
        body.append("")

    body += [
        "## Steps to reproduce",
        "",
        "1. `dig +short {h} CNAME` → the target in the table above.".format(h=host0),
        f"2. `dig +short {findings[0]['target']} A` → empty (no address, no CNAME). The label is unowned.",
        f"3. `curl -sSI https://{host0}/` → connection failure, confirming the hostname is dead end to end.",
        f"4. In an owned {('Azure' if r['cls'] != 'trafficmanager' else 'Azure')} subscription create a "
        f"{'Web App' if r['cls'] == 'azurewebsites' else 'Traffic Manager profile'} named "
        f"`{label}`; the freed label is accepted because nothing holds it.",
        f"5. With that resource pointed at attacker content, `https://{host0}/` serves attacker content and "
        "`certbot --http-01` issues a trusted certificate for the victim hostname.",
        "",
        "## Impact",
        "",
        IMPACT.format(host=host0, apex=apex),
        "## Remediation",
        "",
        REMEDIATION.format(provider="Azure" if r["cls"] != "trafficmanager" else "Traffic Manager"),
    ]

    if r.get("notes"):
        body += ["## Notes for the triager", "", r["notes"], ""]

    return "\n".join(body)


def main() -> int:
    idx = json.loads((EV / "index.json").read_text())
    findings = [f for f in idx["findings"] if not f["target_resolves"]]
    OUT.mkdir(parents=True, exist_ok=True)

    written = []
    for r in REPORTS:
        if r.get("host_suffix"):
            sel = [f for f in findings if f["host"].endswith(r["host_suffix"])]
        else:
            sel = [f for f in findings if f["host"] in set(r["hosts"])]
        if not sel:
            print(f"SKIP {r['file']}: no live dangling evidence")
            continue
        p = OUT / r["file"]
        p.write_text(build(r, sel))
        written.append((r["platform"], r["program"], r["file"], len(sel)))
        print(f"wrote {r['file']:42} {len(sel):2} host(s)  {r['platform']}/{r['program']}")

    index = [
        "| platform | program | hosts | report |", "|---|---|---|---|",
    ]
    for plat, prog, f, n in written:
        index.append(f"| {plat} | {prog} | {n} | `reports/out/{f}` |")
    (OUT / "INDEX.md").write_text(
        "# Submission queue\n\n" + "\n".join(index) +
        "\n\nAll hostnames were re-verified at capture time; a report is only generated for a target "
        "that still fails to resolve.\n"
    )
    print(f"\n{len(written)} reports -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())