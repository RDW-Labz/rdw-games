# Subdomain takeover: `candle-src.etoro.com` CNAMEs to an Azure Traffic Manager target nothing owns

**Programme:** etoro.com · **Severity:** medium · **Asset:** candle-src.etoro.com

## Summary

`candle-src.etoro.com` is a DNS record under `etoro.com` that still CNAMEs to `prod-candle.trafficmanager.net`. That target
no longer exists — the provider released the name, so the delegation
terminates in nothing and the record outlived whatever used to hold it.

## Evidence

```
$ dig +short candle-src.etoro.com CNAME
prod-candle.trafficmanager.net

$ dig +noall +comments +answer prod-candle.trafficmanager.net A
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, ANSWER: 0

$ curl -sS -o /dev/null -w '%{http_code}' https://candle-src.etoro.com/
000        # Could not resolve host

$ dig +short mco-rc-rc2.trafficmanager.net    # control: a live name in the same zone
mco-rc-rc2-gd06a86a5f43-596.westeurope.cloudapp.azure.com.
```

`NXDOMAIN` is the whole finding: the name `prod-candle.trafficmanager.net` no longer exists, so the provider has released it. The zone itself is healthy — its own SOA and NS records answer normally — and the only broken link is the record your delegation still points at.

## Why this is claimable

Traffic Manager profile DNS names are globally unique across all of Azure, and the name is
released when the profile is deleted: `prod-candle.trafficmanager.net` no longer resolves because no profile holds it. Any
Azure subscription can create a profile with that exact name, after which this hostname — whose CNAME
never changed — points at the attacker's endpoints with no action on your side.

## What I did not do

I did not register anything or publish anything, so nothing here has been claimed. The checks above are
`dig` and one GET. If you want the takeover demonstrated rather than described, say so and I will claim
the name on a benign page, send you the timestamped proof, and release it afterwards — inside a window
you choose.

## Remediation

Delete the CNAME for every hostname listed above, then audit the zone for other `*.trafficmanager.net` records whose profiles were removed — 1 existed in this set alone, all pointing at released profile names.

## Impact

A recreated profile answers `candle-src.etoro.com` with attacker-chosen content and a Traffic Manager edge
certificate for the name, on a `etoro.com` origin. That is enough to phish employees or customers of the
brand, and to collect any cookie or token issued for the parent domain.

## Steps to reproduce

1. `dig +short candle-src.etoro.com CNAME` → `prod-candle.trafficmanager.net`.
2. Resolve `prod-candle.trafficmanager.net` → it does not exist, so the profile name is released.
3. Create a Traffic Manager profile named for that target under any Azure subscription.
4. `https://candle-src.etoro.com/` then serves content from that profile.
