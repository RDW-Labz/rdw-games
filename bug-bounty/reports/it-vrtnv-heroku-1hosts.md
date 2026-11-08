# Subdomain takeover: `upload.sporza.be` CNAMEs to a Heroku target nothing owns

**Programme:** sporza.be · **Severity:** medium · **Asset:** upload.sporza.be

## Summary

`upload.sporza.be` is a DNS record under `sporza.be` that still CNAMEs to `upload.sporza.be.herokudns.com`. That target
answers with no records, so the delegation
terminates in nothing and the record outlived whatever used to hold it.

## Evidence

```
$ dig +short upload.sporza.be CNAME
upload.sporza.be.herokudns.com

$ dig +noall +comments +answer upload.sporza.be.herokudns.com A
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, ANSWER: 0

$ curl -sS -o /dev/null -w '%{http_code}' https://upload.sporza.be/
000        # Could not resolve host
```

`NOERROR` with `ANSWER: 0` is NODATA, not a dead zone: the provider's own SOA and NS records are served normally, and a control name under the same zone returns the same shape. What is missing is the backend, not the DNS.

## Why this is claimable

Heroku's custom-domain target is derived from the **domain name**, not the app: adding
`upload.sporza.be` to any Heroku app issues exactly `upload.sporza.be.herokudns.com` again. The existing CNAME therefore already points
at whatever app holds that domain, so no change on your side is needed for a third party to take it
over — only a free Heroku account, where the domain is currently unclaimed.

## What I did not do

I did not register anything or publish anything, so nothing here has been claimed. The checks above are
`dig` and one GET. If you want the takeover demonstrated rather than described, say so and I will claim
the name on a benign page, send you the timestamped proof, and release it afterwards — inside a window
you choose.

## Remediation

Remove the `upload.sporza.be` CNAME, or re-add the domain to a Heroku app you control. Audit the zone for other `*.herokudns.com` records that survived their apps — the CNAME alone is the entire precondition.

## Impact

Whoever adds `upload.sporza.be` to a Heroku app has the hostname served from their own content, with a
certificate Heroku issues for it automatically. On a `sporza.be` origin that survives a glance at the
address bar, receives any cookie scoped to the parent domain, and satisfies any allow-list or redirect
rule that treats `*.sporza.be` as first-party.

## Steps to reproduce

1. `dig +short upload.sporza.be CNAME` → `upload.sporza.be.herokudns.com`.
2. Resolve that target → `NOERROR`, zero answers: nothing claims the custom domain.
3. Create a Heroku app, add `upload.sporza.be` as its custom domain, deploy any content.
4. `https://upload.sporza.be/` then resolves to that app.
