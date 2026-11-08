# Dangling DNS / subdomain takeover: `candle-src.etoro.com`

**Program / owner:** eToro Managed Bug Bounty Engagement
**Channel:** security
**Asset:** `candle-src.etoro.com` -> `prod-candle.trafficmanager.net`
**Namespace:** trafficmanager.net
**Verdict:** claimable by a third party
**Detected:** 2026-11-02T03:36:20+00:00
**Severity:** Medium (takeover) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)

## Summary

`candle-src.etoro.com` is a rule in the eToro Managed Bug Bounty Engagement DNS zone that points at `prod-candle.trafficmanager.net`, which no longer answers:

```
candle-src.etoro.com.	7200	IN	CNAME	prod-candle.trafficmanager.net.

; prod-candle.trafficmanager.net -> status: NXDOMAIN
```

How the name is claimable: Microsoft: profile name is reserved after deletion, then reusable by a different tenant.

Claim path: `create a Traffic Manager profile with the same name, add an External endpoint` (Azure subscription).

## Impact

A stranger holding that hostname serves attacker-controlled content at `https://candle-src.etoro.com` — with a
certificate issued for the exact name, since DNS validation passes through the record. That buys
phishing inside the eToro Managed Bug Bounty Engagement brand, bypass of any `*` allow-list keyed on the domain (CORS,
`redirect_uri`, CSP, proxy rules), and capture of any request — including bearer tokens — still
configured for the dead hostname.

## Remediation

1. Delete the DNS record for `candle-src.etoro.com`. That alone closes it.
2. Add "delete the DNS records" to the service teardown checklist.
3. Sweep the zone once for any CNAME whose target no longer resolves.

## Testing notes

Passive only: certificate transparency logs plus `dig`. No HTTP requests to the record, no account
created, nothing claimed. I will keep this private for the policy window.

_Auto-drafted by engine/dangling.py — human-edit before sending._
