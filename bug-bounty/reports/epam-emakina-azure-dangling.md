Report: dangling CNAME to a released Azure App Service hostname (subdomain takeover)
Programme: EPAM Systems Managed Bug Bounty Program (Bugcrowd, engagement epam-mbb-og)
Scope entry relied on: website:*.emakina.at  — every host below is a subdomain of emakina.at
Severity suggestion: High (a stranger can serve content on an EPAM-owned client hostname)
Status: NOT submitted — needs the Bugcrowd account (PLATFORMS.md, step 2)

## Summary

2 Azure App Service hostnames that EPAM/Emakina controls as CNAME targets no longer exist.
App Service names are global: once an app is deleted the name is released and any Azure subscription can
create `appname.azurewebsites.net`. The `*.emakina.at` records still point at them, so whoever registers
the name serves content on an EPAM hostname — no DNS change on your side, no certificate warning, a
valid certificate for the EPAM hostname is issued to them automatically through App Service.

### donauchemie-dev.azurewebsites.net  (13 hosts)

  - donau-carbon-us.devweb.emakina.at
  - donau-carbon.devweb.emakina.at
  - donau-chemie-group.devweb.emakina.at
  - donau-chemie-ro.devweb.emakina.at
  - donau-chemie.devweb.emakina.at
  - donau-products.devweb.emakina.at
  - donau-realitaeten.devweb.emakina.at
  - donau-umweltinformation.devweb.emakina.at
  - donau.devweb.emakina.at
  - donauchem-hu.devweb.emakina.at
  - donauchem-pl.devweb.emakina.at
  - donauchem-rs.devweb.emakina.at
  - donauchem-sk.devweb.emakina.at

### lsgganterdev.azurewebsites.net  (1 host)

  - ganterdevweb.emakina.at

## Verification (2026-11-01)

    $ dig +short +time=3 +tries=1 CNAME donau-chemie.devweb.emakina.at
    donauchemie-dev.azurewebsites.net.
    $ dig +short +time=3 +tries=1 A donauchemie-dev.azurewebsites.net
    (no answer — NXDOMAIN, the app has been deleted)

Repeated for each target above: the CNAME resolves from the EPAM zone, the target returns no A record.

## Impact

An attacker who registers one of these names in their own Azure subscription receives a valid
`*.azurewebsites.net` endpoint and, because the EPAM record still points at it, the content is served
under `*.emakina.at`. That yields: phishing and malware hosting on a client-facing agency hostname,
cookies scoped to the parent domain reachable from the attacker's page, and bypass of any allow-list or
CSP `script-src` that trusts `*.emakina.at`. The `devweb` naming suggests client staging sites, so the
hostnames may still be referenced in client configurations and QA documentation.

## What I did not do

I did not register, claim or resolve any of these names, and I did not send a request to any of the
hostnames. The finding rests on DNS records alone, consistent with the programme's rules and with the
rule that a stranger must not take over a customer's asset to prove it is takeable.

## Remediation

Delete the CNAME records for the hostnames above (they have no backing app), and audit the rest of
`*.devweb.emakina.at` for records pointing at App Service names that are no longer provisioned. Where a
client site must remain reachable, recreate the app and keep the name reserved by not deleting it while
the record exists.
