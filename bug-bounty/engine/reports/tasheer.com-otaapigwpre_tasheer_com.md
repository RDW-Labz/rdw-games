# Dangling DNS / subdomain takeover: `otaapigwpre.tasheer.com`

**Program / owner:** VFS Global Bug Bounty Program [VFS Global Bug Bounty Program]
**Channel:** YW program page
**Asset:** `otaapigwpre.tasheer.com` -> `b2c-ota-apigw.azurewebsites.net`
**Namespace:** azurewebsites.net
**Verdict:** claimable by a third party
**Detected:** 2026-11-01T22:44:37+00:00
**Severity:** Medium (takeover) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)

## Summary

`otaapigwpre.tasheer.com` is a rule in the VFS Global Bug Bounty Program [VFS Global Bug Bounty Program] DNS zone that points at `b2c-ota-apigw.azurewebsites.net`, which no longer answers:

```
otaapigwpre.tasheer.com. 600	IN	CNAME	b2c-ota-apigw.azurewebsites.net.

; b2c-ota-apigw.azurewebsites.net -> status: NXDOMAIN
```

How the name is claimable: app name is globally claimable once deleted.

Claim path: `create a Web App with the same name` (Azure subscription).

## Impact

A stranger holding that hostname serves attacker-controlled content at `https://otaapigwpre.tasheer.com` — with a
certificate issued for the exact name, since DNS validation passes through the record. That buys
phishing inside the VFS Global Bug Bounty Program [VFS Global Bug Bounty Program] brand, bypass of any `*` allow-list keyed on the domain (CORS,
`redirect_uri`, CSP, proxy rules), and capture of any request — including bearer tokens — still
configured for the dead hostname.

## Remediation

1. Delete the DNS record for `otaapigwpre.tasheer.com`. That alone closes it.
2. Add "delete the DNS records" to the service teardown checklist.
3. Sweep the zone once for any CNAME whose target no longer resolves.

## Testing notes

Passive only: certificate transparency logs plus `dig`. No HTTP requests to the record, no account
created, nothing claimed. I will keep this private for the policy window.

_Auto-drafted by engine/dangling.py — human-edit before sending._
