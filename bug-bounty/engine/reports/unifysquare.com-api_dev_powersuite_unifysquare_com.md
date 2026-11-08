# Dangling DNS / subdomain takeover: `api.dev.powersuite.unifysquare.com`

**Program / owner:** Unisys Managed Bug Bounty Engagement
**Channel:** security
**Asset:** `api.dev.powersuite.unifysquare.com` -> `pstestaksag.eastus.cloudapp.azure.com`
**Namespace:** cloudapp.azure.com
**Verdict:** claimable by a third party
**Detected:** 2026-11-02T03:36:20+00:00
**Severity:** Medium (takeover) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)

## Summary

`api.dev.powersuite.unifysquare.com` is a rule in the Unisys Managed Bug Bounty Engagement DNS zone that points at `pstestaksag.eastus.cloudapp.azure.com`, which no longer answers:

```
api.dev.powersuite.unifysquare.com. 300	IN CNAME pstestaksag.eastus.cloudapp.azure.com.

; pstestaksag.eastus.cloudapp.azure.com -> status: NXDOMAIN
```

How the name is claimable: cloud service name is globally claimable.

Claim path: `create cloud service` (Azure subscription).

## Impact

A stranger holding that hostname serves attacker-controlled content at `https://api.dev.powersuite.unifysquare.com` — with a
certificate issued for the exact name, since DNS validation passes through the record. That buys
phishing inside the Unisys Managed Bug Bounty Engagement brand, bypass of any `*` allow-list keyed on the domain (CORS,
`redirect_uri`, CSP, proxy rules), and capture of any request — including bearer tokens — still
configured for the dead hostname.

## Remediation

1. Delete the DNS record for `api.dev.powersuite.unifysquare.com`. That alone closes it.
2. Add "delete the DNS records" to the service teardown checklist.
3. Sweep the zone once for any CNAME whose target no longer resolves.

## Testing notes

Passive only: certificate transparency logs plus `dig`. No HTTP requests to the record, no account
created, nothing claimed. I will keep this private for the policy window.

_Auto-drafted by engine/dangling.py — human-edit before sending._
