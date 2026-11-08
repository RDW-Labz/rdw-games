# Dangling DNS / subdomain takeover: `account-link.chipotle.com`

**Program / owner:** Chipotle Managed Bug Bounty Engagement
**Channel:** security
**Asset:** `account-link.chipotle.com` -> `production.dgmrc8pcyp.us-east-1.elasticbeanstalk.com`
**Namespace:** elasticbeanstalk.com (hashed)
**Verdict:** claimable by a third party
**Detected:** 2026-11-02T03:36:20+00:00
**Severity:** Medium (takeover) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)

## Summary

`account-link.chipotle.com` is a rule in the Chipotle Managed Bug Bounty Engagement DNS zone that points at `production.dgmrc8pcyp.us-east-1.elasticbeanstalk.com`, which no longer answers:

```
account-link.chipotle.com. 14400 IN	CNAME	production.dgmrc8pcyp.us-east-1.elasticbeanstalk.com.

; production.dgmrc8pcyp.us-east-1.elasticbeanstalk.com -> status: NXDOMAIN
```

How the name is claimable: hashed EB names are still takeable: a new environment using the id as its DNS name wildcards every nested name under it.

Claim path: `aws elasticbeanstalk create-environment --cname-prefix dgmrc8pcyp (region us-east-1) — covers production too` (AWS account, free).

## Impact

A stranger holding that hostname serves attacker-controlled content at `https://account-link.chipotle.com` — with a
certificate issued for the exact name, since DNS validation passes through the record. That buys
phishing inside the Chipotle Managed Bug Bounty Engagement brand, bypass of any `*` allow-list keyed on the domain (CORS,
`redirect_uri`, CSP, proxy rules), and capture of any request — including bearer tokens — still
configured for the dead hostname.

## Remediation

1. Delete the DNS record for `account-link.chipotle.com`. That alone closes it.
2. Add "delete the DNS records" to the service teardown checklist.
3. Sweep the zone once for any CNAME whose target no longer resolves.

## Testing notes

Passive only: certificate transparency logs plus `dig`. No HTTP requests to the record, no account
created, nothing claimed. I will keep this private for the policy window.

_Auto-drafted by engine/dangling.py — human-edit before sending._
