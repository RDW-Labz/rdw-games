# Subdomain takeover: `qa-cms.aon-hugeops.uk` CNAMEs to an Azure App Service target nothing owns

**Programme:** aon-hugeops.uk · **Severity:** medium · **Asset:** qa-cms.aon-hugeops.uk

## Summary

`qa-cms.aon-hugeops.uk` is a DNS record under `aon-hugeops.uk` that still CNAMEs to `aon-sitecore-qa-xp-scaled-176730-cm.azurewebsites.net`. That target
no longer exists — the provider released the name, so the delegation
terminates in nothing and the record outlived whatever used to hold it.

## Evidence

```
$ dig +short qa-cms.aon-hugeops.uk CNAME
aon-sitecore-qa-xp-scaled-176730-cm.azurewebsites.net

$ dig +noall +comments +answer aon-sitecore-qa-xp-scaled-176730-cm.azurewebsites.net A
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, ANSWER: 0

$ curl -sS -o /dev/null -w '%{http_code}' https://qa-cms.aon-hugeops.uk/
000        # Could not resolve host
```

`NXDOMAIN` is the whole finding: the name `aon-sitecore-qa-xp-scaled-176730-cm.azurewebsites.net` no longer exists, so the provider has released it. The zone itself is healthy — its own SOA and NS records answer normally — and the only broken link is the record your delegation still points at.

## Why this is claimable

Azure App Service names are unique per region and released on deletion. `aon-sitecore-qa-xp-scaled-176730-cm.azurewebsites.net` resolves
to nothing, so the name is available: any Azure subscription can create an app with that name, and this
hostname inherits it without any DNS change on your side.

## What I did not do

I did not register anything or publish anything, so nothing here has been claimed. The checks above are
`dig` and one GET. If you want the takeover demonstrated rather than described, say so and I will claim
the name on a benign page, send you the timestamped proof, and release it afterwards — inside a window
you choose.

## Remediation

Remove the CNAME for every hostname listed above, or recreate the App Service app so the name is held by you. Audit the zone for other `*.azurewebsites.net` records pointing at deleted apps — 1 were found in this set.

## Impact

An attacker holding `aon-sitecore-qa-xp-scaled-176730-cm.azurewebsites.net` serves their own content on `https://qa-cms.aon-hugeops.uk/` with an App
Service certificate for the custom domain, on a `aon-hugeops.uk` origin — brand impersonation with a valid
certificate and no browser warning.

## Steps to reproduce

1. `dig +short qa-cms.aon-hugeops.uk CNAME` → `aon-sitecore-qa-xp-scaled-176730-cm.azurewebsites.net`.
2. Resolve `aon-sitecore-qa-xp-scaled-176730-cm.azurewebsites.net` → no records, so the app name is released.
3. Create an App Service app with that name in the matching region.
4. `https://qa-cms.aon-hugeops.uk/` then serves the attacker's app.
