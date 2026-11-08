# Subdomain takeover: `api.qa.whatsup.volkswagen.de` CNAMEs to an Azure App Service target nothing owns

**Programme:** qa.whatsup.volkswagen.de · **Severity:** medium · **Asset:** api.qa.whatsup.volkswagen.de

## Summary

`api.qa.whatsup.volkswagen.de` is a DNS record under `qa.whatsup.volkswagen.de` that still CNAMEs to `whatsup-backend-qa.azurewebsites.net`. That target
no longer exists — the provider released the name, so the delegation
terminates in nothing and the record outlived whatever used to hold it.

## Evidence

```
$ dig +short api.qa.whatsup.volkswagen.de CNAME
whatsup-backend-qa.azurewebsites.net

$ dig +noall +comments +answer whatsup-backend-qa.azurewebsites.net A
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, ANSWER: 0

$ curl -sS -o /dev/null -w '%{http_code}' https://api.qa.whatsup.volkswagen.de/
000        # Could not resolve host
```

`NXDOMAIN` is the whole finding: the name `whatsup-backend-qa.azurewebsites.net` no longer exists, so the provider has released it. The zone itself is healthy — its own SOA and NS records answer normally — and the only broken link is the record your delegation still points at.

## Why this is claimable

Azure App Service names are unique per region and released on deletion. `whatsup-backend-qa.azurewebsites.net` resolves
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

An attacker holding `whatsup-backend-qa.azurewebsites.net` serves their own content on `https://api.qa.whatsup.volkswagen.de/` with an App
Service certificate for the custom domain, on a `qa.whatsup.volkswagen.de` origin — brand impersonation with a valid
certificate and no browser warning.

## Steps to reproduce

1. `dig +short api.qa.whatsup.volkswagen.de CNAME` → `whatsup-backend-qa.azurewebsites.net`.
2. Resolve `whatsup-backend-qa.azurewebsites.net` → no records, so the app name is released.
3. Create an App Service app with that name in the matching region.
4. `https://api.qa.whatsup.volkswagen.de/` then serves the attacker's app.
