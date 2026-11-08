# Dangling DNS / subdomain takeover: `ganterdevweb.emakina.at`

**Program / owner:** EPAM Systems Managed Bug Bounty Program [EPAM Systems Managed Bug Bounty Program]
**Channel:** BC program page
**Asset:** `ganterdevweb.emakina.at` -> `lsgganterdev.azurewebsites.net`
**Namespace:** azurewebsites.net
**Verdict:** claimable by a third party
**Detected:** 2026-11-01T22:44:37+00:00
**Severity:** Medium (takeover) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)

## Summary

`ganterdevweb.emakina.at` is a rule in the EPAM Systems Managed Bug Bounty Program [EPAM Systems Managed Bug Bounty Program] DNS zone that points at `lsgganterdev.azurewebsites.net`, which no longer answers:

```
ganterdevweb.emakina.at. 5316	IN	CNAME	lsgganterdev.azurewebsites.net.

; lsgganterdev.azurewebsites.net -> status: NXDOMAIN
```

How the name is claimable: app name is globally claimable once deleted.

Claim path: `create a Web App with the same name` (Azure subscription).

## Impact

A stranger holding that hostname serves attacker-controlled content at `https://ganterdevweb.emakina.at` — with a
certificate issued for the exact name, since DNS validation passes through the record. That buys
phishing inside the EPAM Systems Managed Bug Bounty Program [EPAM Systems Managed Bug Bounty Program] brand, bypass of any `*` allow-list keyed on the domain (CORS,
`redirect_uri`, CSP, proxy rules), and capture of any request — including bearer tokens — still
configured for the dead hostname.

## Remediation

1. Delete the DNS record for `ganterdevweb.emakina.at`. That alone closes it.
2. Add "delete the DNS records" to the service teardown checklist.
3. Sweep the zone once for any CNAME whose target no longer resolves.

## Testing notes

Passive only: certificate transparency logs plus `dig`. No HTTP requests to the record, no account
created, nothing claimed. I will keep this private for the policy window.

_Auto-drafted by engine/dangling.py — human-edit before sending._
