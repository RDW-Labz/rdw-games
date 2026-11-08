# Dangling DNS / subdomain takeover: `workstream-consent-preview.unifysquare.com`

**Program / owner:** Unisys Managed Bug Bounty Engagement
**Channel:** security
**Asset:** `workstream-consent-preview.unifysquare.com` -> `workstream-ms-preview.azurewebsites.net`
**Namespace:** azurewebsites.net
**Verdict:** claimable by a third party
**Detected:** 2026-11-02T03:36:20+00:00
**Severity:** Medium (takeover) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)

## Summary

`workstream-consent-preview.unifysquare.com` is a rule in the Unisys Managed Bug Bounty Engagement DNS zone that points at `workstream-ms-preview.azurewebsites.net`, which no longer answers:

```
workstream-consent-preview.unifysquare.com. 1800 IN CNAME workstream-ms-preview.azurewebsites.net.

; workstream-ms-preview.azurewebsites.net -> status: NXDOMAIN
```

How the name is claimable: app name is globally claimable once deleted.

Claim path: `create a Web App with the same name` (Azure subscription).

## Impact

A stranger holding that hostname serves attacker-controlled content at `https://workstream-consent-preview.unifysquare.com` — with a
certificate issued for the exact name, since DNS validation passes through the record. That buys
phishing inside the Unisys Managed Bug Bounty Engagement brand, bypass of any `*` allow-list keyed on the domain (CORS,
`redirect_uri`, CSP, proxy rules), and capture of any request — including bearer tokens — still
configured for the dead hostname.

## Remediation

1. Delete the DNS record for `workstream-consent-preview.unifysquare.com`. That alone closes it.
2. Add "delete the DNS records" to the service teardown checklist.
3. Sweep the zone once for any CNAME whose target no longer resolves.

## Testing notes

Passive only: certificate transparency logs plus `dig`. No HTTP requests to the record, no account
created, nothing claimed. I will keep this private for the policy window.

_Auto-drafted by engine/dangling.py — human-edit before sending._
