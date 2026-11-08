# Dangling DNS / subdomain takeover: `dev.customerservice-ccp.priceline.com`

**Program / owner:** Priceline
**Channel:** security
**Asset:** `dev.customerservice-ccp.priceline.com` -> `pcln-ccp-blue.us-east-1.elasticbeanstalk.com`
**Namespace:** elasticbeanstalk.com (plain)
**Verdict:** claimable by a third party
**Detected:** 2026-11-02T22:59:53+00:00
**Severity:** Medium (takeover) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)

## Summary

`dev.customerservice-ccp.priceline.com` is a rule in the Priceline DNS zone that points at `pcln-ccp-blue.us-east-1.elasticbeanstalk.com`, which no longer answers:

```
dev.customerservice-ccp.priceline.com. 6334 IN CNAME pcln-ccp-blue.us-east-1.elasticbeanstalk.com.

; pcln-ccp-blue.us-east-1.elasticbeanstalk.com -> status: NOERROR
```

How the name is claimable: AWS docs: terminated environments release the hostname — 'other customers can reuse an available hostname'.

Claim path: `aws elasticbeanstalk create-environment --cname-prefix pcln-ccp-blue (region us-east-1)` (AWS account, free).

## Impact

A stranger holding that hostname serves attacker-controlled content at `https://dev.customerservice-ccp.priceline.com` — with a
certificate issued for the exact name, since DNS validation passes through the record. That buys
phishing inside the Priceline brand, bypass of any `*` allow-list keyed on the domain (CORS,
`redirect_uri`, CSP, proxy rules), and capture of any request — including bearer tokens — still
configured for the dead hostname.

## Remediation

1. Delete the DNS record for `dev.customerservice-ccp.priceline.com`. That alone closes it.
2. Add "delete the DNS records" to the service teardown checklist.
3. Sweep the zone once for any CNAME whose target no longer resolves.

## Testing notes

Passive only: certificate transparency logs plus `dig`. No HTTP requests to the record, no account
created, nothing claimed. I will keep this private for the policy window.

_Auto-drafted by engine/dangling.py — human-edit before sending._
