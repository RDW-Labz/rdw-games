# Dangling DNS / subdomain takeover: `dig.sim.celemi.com`

**Program / owner:** celemi.com
**Channel:** mailto:security@celemi.com
**Asset:** `dig.sim.celemi.com` -> `mup-env-celemi-prod-app-central.txpey7hhzg.eu-central-1.elasticbeanstalk.com`
**Namespace:** elasticbeanstalk.com (hashed)
**Verdict:** claimable by a third party
**Detected:** 2026-11-01T22:44:37+00:00
**Severity:** Medium (takeover) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)

## Summary

`dig.sim.celemi.com` is a rule in the celemi.com DNS zone that points at `mup-env-celemi-prod-app-central.txpey7hhzg.eu-central-1.elasticbeanstalk.com`, which no longer answers:

```
dig.sim.celemi.com.	3600	IN	CNAME	mup-env-celemi-prod-app-central.txpey7hhzg.eu-central-1.elasticbeanstalk.com.

; mup-env-celemi-prod-app-central.txpey7hhzg.eu-central-1.elasticbeanstalk.com -> status: NXDOMAIN
```

How the name is claimable: hashed EB names are still takeable: a new environment using the id as its DNS name wildcards every nested name under it.

Claim path: `aws elasticbeanstalk create-environment --cname-prefix txpey7hhzg (region eu-central-1) — covers mup-env-celemi-prod-app-central too` (AWS account, free).

## Impact

A stranger holding that hostname serves attacker-controlled content at `https://dig.sim.celemi.com` — with a
certificate issued for the exact name, since DNS validation passes through the record. That buys
phishing inside the celemi.com brand, bypass of any `*` allow-list keyed on the domain (CORS,
`redirect_uri`, CSP, proxy rules), and capture of any request — including bearer tokens — still
configured for the dead hostname.

## Remediation

1. Delete the DNS record for `dig.sim.celemi.com`. That alone closes it.
2. Add "delete the DNS records" to the service teardown checklist.
3. Sweep the zone once for any CNAME whose target no longer resolves.

## Testing notes

Passive only: certificate transparency logs plus `dig`. No HTTP requests to the record, no account
created, nothing claimed. I will keep this private for the policy window.

_Auto-drafted by engine/dangling.py — human-edit before sending._
