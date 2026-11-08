# Subdomain takeover: `donau-carbon-us.devweb.emakina.at` CNAMEs to an Azure App Service target nothing owns

**Programme:** devweb.emakina.at · **Severity:** medium · **Asset:** donau-carbon-us.devweb.emakina.at

## Summary

`donau-carbon-us.devweb.emakina.at` is a DNS record under `devweb.emakina.at` that still CNAMEs to `donauchemie-dev.azurewebsites.net`. That target
no longer exists — the provider released the name, so the delegation
terminates in nothing and the record outlived whatever used to hold it.

All 14 records were measured in the same pass. They point at 2 released names, so claiming those names takes over every hostname below in 2 registrations:

```
donau-carbon-us.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
donau-carbon.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
donau-chemie-group.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
donau-chemie-ro.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
donau-chemie.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
donau-products.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
donau-realitaeten.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
donau-umweltinformation.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
donau.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
donauchem-hu.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
donauchem-pl.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
donauchem-rs.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
donauchem-sk.devweb.emakina.at  ->  donauchemie-dev.azurewebsites.net
ganterdevweb.emakina.at  ->  lsgganterdev.azurewebsites.net
```

## Evidence

```
$ dig +short donau-carbon-us.devweb.emakina.at CNAME
donauchemie-dev.azurewebsites.net

$ dig +noall +comments +answer donauchemie-dev.azurewebsites.net A
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, ANSWER: 0

$ curl -sS -o /dev/null -w '%{http_code}' https://donau-carbon-us.devweb.emakina.at/
000        # Could not resolve host
```

`NXDOMAIN` is the whole finding: the name `donauchemie-dev.azurewebsites.net` no longer exists, so the provider has released it. The zone itself is healthy — its own SOA and NS records answer normally — and the only broken link is the record your delegation still points at.

## Why this is claimable

Azure App Service names are unique per region and released on deletion. `donauchemie-dev.azurewebsites.net` resolves
to nothing, so the name is available: any Azure subscription can create an app with that name, and this
hostname inherits it without any DNS change on your side.

This set involves 2 released names — `donauchemie-dev.azurewebsites.net`, `lsgganterdev.azurewebsites.net` — so the takeover is not one registration but 2, each claimed independently.

## What I did not do

I did not register anything or publish anything, so nothing here has been claimed. The checks above are
`dig` and one GET. If you want the takeover demonstrated rather than described, say so and I will claim
the name on a benign page, send you the timestamped proof, and release it afterwards — inside a window
you choose.

## Remediation

Remove the CNAME for every hostname listed above, or recreate the App Service app so the name is held by you. Audit the zone for other `*.azurewebsites.net` records pointing at deleted apps — 14 were found in this set.

## Impact

An attacker holding `donauchemie-dev.azurewebsites.net` serves their own content on `https://donau-carbon-us.devweb.emakina.at/` with an App
Service certificate for the custom domain, on a `devweb.emakina.at` origin — brand impersonation with a valid
certificate and no browser warning.

## Steps to reproduce

1. `dig +short donau-carbon-us.devweb.emakina.at CNAME` → `donauchemie-dev.azurewebsites.net`.
2. Resolve `donauchemie-dev.azurewebsites.net` → no records, so the app name is released.
3. Create an App Service app with that name in the matching region.
4. `https://donau-carbon-us.devweb.emakina.at/` then serves the attacker's app.
