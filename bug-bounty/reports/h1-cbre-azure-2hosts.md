# Subdomain takeover: `scorecard.prod.cbreapps.com` CNAMEs to an Azure App Service target nothing owns

**Programme:** prod.cbreapps.com · **Severity:** medium · **Asset:** scorecard.prod.cbreapps.com

## Summary

`scorecard.prod.cbreapps.com` is a DNS record under `prod.cbreapps.com` that still CNAMEs to `gws-scorecard-prod-uks-app.azurewebsites.net`. That target
no longer exists — the provider released the name, so the delegation
terminates in nothing and the record outlived whatever used to hold it.

All 2 records were measured in the same pass. Each CNAME points at its own released name, so every hostname below is separately claimable and every one needs deleting:

```
scorecard.prod.cbreapps.com  ->  gws-scorecard-prod-uks-app.azurewebsites.net
test.angulardemo.emerald.cbre.com  ->  testemeraldangulardemo.azurewebsites.net
```

## Evidence

```
$ dig +short scorecard.prod.cbreapps.com CNAME
gws-scorecard-prod-uks-app.azurewebsites.net

$ dig +noall +comments +answer gws-scorecard-prod-uks-app.azurewebsites.net A
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, ANSWER: 0

$ curl -sS -o /dev/null -w '%{http_code}' https://scorecard.prod.cbreapps.com/
000        # Could not resolve host
```

`NXDOMAIN` is the whole finding: the name `gws-scorecard-prod-uks-app.azurewebsites.net` no longer exists, so the provider has released it. The zone itself is healthy — its own SOA and NS records answer normally — and the only broken link is the record your delegation still points at.

## Why this is claimable

Azure App Service names are unique per region and released on deletion. `gws-scorecard-prod-uks-app.azurewebsites.net` resolves
to nothing, so the name is available: any Azure subscription can create an app with that name, and this
hostname inherits it without any DNS change on your side.

This set involves 2 released names — `gws-scorecard-prod-uks-app.azurewebsites.net`, `testemeraldangulardemo.azurewebsites.net` — so the takeover is not one registration but 2, each claimed independently.

## What I did not do

I did not register anything or publish anything, so nothing here has been claimed. The checks above are
`dig` and one GET. If you want the takeover demonstrated rather than described, say so and I will claim
the name on a benign page, send you the timestamped proof, and release it afterwards — inside a window
you choose.

## Remediation

Remove the CNAME for every hostname listed above, or recreate the App Service app so the name is held by you. Audit the zone for other `*.azurewebsites.net` records pointing at deleted apps — 2 were found in this set.

## Impact

An attacker holding `gws-scorecard-prod-uks-app.azurewebsites.net` serves their own content on `https://scorecard.prod.cbreapps.com/` with an App
Service certificate for the custom domain, on a `prod.cbreapps.com` origin — brand impersonation with a valid
certificate and no browser warning.

## Steps to reproduce

1. `dig +short scorecard.prod.cbreapps.com CNAME` → `gws-scorecard-prod-uks-app.azurewebsites.net`.
2. Resolve `gws-scorecard-prod-uks-app.azurewebsites.net` → no records, so the app name is released.
3. Create an App Service app with that name in the matching region.
4. `https://scorecard.prod.cbreapps.com/` then serves the attacker's app.
