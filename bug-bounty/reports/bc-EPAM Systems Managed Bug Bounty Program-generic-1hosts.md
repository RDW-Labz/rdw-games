# Subdomain takeover: `alt.emakina.at` CNAMEs to a generic target nothing owns

**Programme:** emakina.at · **Severity:** medium · **Asset:** alt.emakina.at

## Summary

`alt.emakina.at` is a DNS record under `emakina.at` that still CNAMEs to `alt.emakina.com`. That target
no longer exists — the provider released the name, so the delegation
terminates in nothing and the record outlived whatever used to hold it.

## Evidence

```
$ dig +short alt.emakina.at CNAME
alt.emakina.com

$ dig +noall +comments +answer alt.emakina.com A
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, ANSWER: 0

$ curl -sS -o /dev/null -w '%{http_code}' https://alt.emakina.at/
000        # Could not resolve host
```

`NXDOMAIN` is the whole finding: the name `alt.emakina.com` no longer exists, so the provider has released it. The zone itself is healthy — its own SOA and NS records answer normally — and the only broken link is the record your delegation still points at.

## Why this is claimable

The target answers NODATA, so nothing claims it. Which party can register it depends on the
provider; the delegation itself is broken regardless, and a record pointing at a name nobody
controls is a takeover waiting for the first person to claim it.

## What I did not do

I did not register anything or publish anything, so nothing here has been claimed. The checks above are
`dig` and one GET. If you want the takeover demonstrated rather than described, say so and I will claim
the name on a benign page, send you the timestamped proof, and release it afterwards — inside a window
you choose.

## Remediation

Remove the `alt.emakina.at` CNAME, or point it at a backend you control. Audit the zone for other records delegating to `alt.emakina.com`.

## Impact

Content served from `https://alt.emakina.at/` would carry a valid certificate for a hostname under
`emakina.at`, which is what makes the impersonation work: the address bar, cookies scoped to the parent
domain, and any allow-list entry for the hostname all keep trusting it.

## Steps to reproduce

1. `dig +short alt.emakina.at CNAME` → `alt.emakina.com`.
2. Resolve the target → NODATA, so nothing claims the name.
3. Claim the target at generic and publish content.
4. `https://alt.emakina.at/` then serves it.
