# Dangling DNS / subdomain takeover: `bas-facility-layout-tool-api-staging.differential.com`

**Program / owner:** Differential
**Channel:** security@differential.com
**Asset:** `bas-facility-layout-tool-api-staging.differential.com` -> `bas-facility-layout-tool-api-staging.us-east-2.elasticbeanstalk.com`
**Namespace:** elasticbeanstalk.com (plain)
**Verdict:** claimable by a third party
**Detected:** 2026-11-01T22:44:37+00:00
**Severity:** Medium (takeover) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)

## Summary

`bas-facility-layout-tool-api-staging.differential.com` is a rule in the Differential DNS zone that points at `bas-facility-layout-tool-api-staging.us-east-2.elasticbeanstalk.com`, which no longer answers:

```
bas-facility-layout-tool-api-staging.differential.com. 3600 IN CNAME bas-facility-layout-tool-api-staging.us-east-2.elasticbeanstalk.com.

; bas-facility-layout-tool-api-staging.us-east-2.elasticbeanstalk.com -> status: NXDOMAIN
```

How the name is claimable: AWS docs: terminated environments release the hostname — 'other customers can reuse an available hostname'.

Claim path: `aws elasticbeanstalk create-environment --cname-prefix bas-facility-layout-tool-api-staging (region us-east-2)` (AWS account, free).

## Impact

A stranger holding that hostname serves attacker-controlled content at `https://bas-facility-layout-tool-api-staging.differential.com` — with a
certificate issued for the exact name, since DNS validation passes through the record. That buys
phishing inside the Differential brand, bypass of any `*` allow-list keyed on the domain (CORS,
`redirect_uri`, CSP, proxy rules), and capture of any request — including bearer tokens — still
configured for the dead hostname.

## Remediation

1. Delete the DNS record for `bas-facility-layout-tool-api-staging.differential.com`. That alone closes it.
2. Add "delete the DNS records" to the service teardown checklist.
3. Sweep the zone once for any CNAME whose target no longer resolves.

## Testing notes

Passive only: certificate transparency logs plus `dig`. No HTTP requests to the record, no account
created, nothing claimed. I will keep this private for the policy window.

_Auto-drafted by engine/dangling.py — human-edit before sending._
