# Subdomain takeover: `bas-facility-layout-tool-api-{dev,staging}.differential.com`

**Program:** Differential — Vulnerability Disclosure Policy
(`https://www.differential.com/security/vulnerability-disclosure-policy`, also published in
`/.well-known/security.txt`)
**Official channel:** `security@differential.com`
**Policy scope:** *"This policy applies to any digital assets owned, operated, or maintained by
Differential."* Safe harbour is extended for research that follows the policy.
**Assets:** `bas-facility-layout-tool-api-dev.differential.com`,
`bas-facility-layout-tool-api-staging.differential.com` (records in the `differential.com` zone,
DNSimple)
**Class:** Subdomain takeover via dangling CNAME to a terminated AWS Elastic Beanstalk environment
**Severity:** Medium — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)
**Researcher:** Michael Cluer
**Date found:** 2026-11-01

---

## Summary

Two records in the `differential.com` DNS zone still point at Elastic Beanstalk environments that
no longer exist. The CNAME targets return `NXDOMAIN` — AWS has released those hostnames — so
**AWS will hand the same hostname to any other AWS customer who creates an environment with that
name in `us-east-2`.** That makes both records takeable: an attacker who claims the hostname
serves their own content, over a trusted certificate, at a `differential.com` address.

AWS documents this exact failure mode on the page that defines the feature (evidence 03):

> *"If you terminate an environment, you must also delete any CNAME mappings that you created, as
> other customers can reuse an available hostname. Be sure to delete DNS records that point to
> your terminated environment to prevent a **dangling DNS entry**. A dangling DNS entry can expose
> internet traffic destined for your domain to security vulnerabilities."*

## Evidence

**DNS (evidence 01):**

```
differential.com.                        IN NS  ns1..ns4.dnsimple.com
bas-facility-layout-tool-api-dev.differential.com.      1722 IN CNAME bas-facility-layout-tool-api-dev.us-east-2.elasticbeanstalk.com.
bas-facility-layout-tool-api-staging.differential.com.  1722 IN CNAME bas-facility-layout-tool-api-staging.us-east-2.elasticbeanstalk.com.

$ dig bas-facility-layout-tool-api-dev.us-east-2.elasticbeanstalk.com A +noall +comments
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 52348
$ dig bas-facility-layout-tool-api-staging.us-east-2.elasticbeanstalk.com A +noall +comments
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: ...
```

**HTTP (evidence 02):** both hostnames fail to resolve, so clients get `NXDOMAIN` instead of the
API they were configured to reach.

**Fingerprint (evidence 04):** `can-i-take-over-xyz` lists *AWS/Elastic Beanstalk* as
**Vulnerable**, with `NXDOMAIN` as the detection signature (issue #194). AWS's own docs say the
hostname becomes reusable by other customers, and the standard claim path is
`aws elasticbeanstalk check-dns-availability --cname-prefix bas-facility-layout-tool-api-dev`
followed by `create-environment` in `us-east-2`.

Note the distinction the same table draws: `elb.amazonaws.com` and `cloudfront.net` are *not*
takeable because those names embed an account-specific identifier. These Elastic Beanstalk names
are the plain regional form `<prefix>.us-east-2.elasticbeanstalk.com`, with no random id segment —
the fully claimable shape.

## Impact

An attacker who creates the environments gets:

- **`bas-facility-layout-tool-api-dev.differential.com`** and **`…-staging…`** serving
  attacker-controlled responses, with an AWS-issued, publicly trusted TLS certificate for the
  exact hostname.
- Any client, integration, browser extension, internal tool or third-party service still
  configured to call those hostnames sends its request — and any bearer token, API key or basic
  auth header in it — to the attacker.
- A `differential.com` origin for phishing that defeats domain-reputation checks and any
  `*.differential.com` allow-list (CORS, `redirect_uri` prefixes, CSP, proxy rules).

The hostnames suggest an internal facility-layout-tool API in dev/staging, which makes leaked
credentials the realistic worst case rather than brand abuse alone. Because the records were never
cleaned up after teardown, they have been publicly resolvable and dead for an unknown period —
whatever still points at them has been failing, and is therefore likely stale configuration that
nobody is watching.

## Reproduction (all read-only)

```bash
dig +noall +answer bas-facility-layout-tool-api-dev.differential.com CNAME
dig bas-facility-layout-tool-api-dev.us-east-2.elasticbeanstalk.com A +noall +comments
dig bas-facility-layout-tool-api-staging.differential.com CNAME
dig bas-facility-layout-tool-api-staging.us-east-2.elasticbeanstalk.com A +noall +comments
# -> CNAME to *.us-east-2.elasticbeanstalk.com, target status: NXDOMAIN
```

I did not create an Elastic Beanstalk environment and did not claim either hostname — that would
have taken over a live third-party asset. The NXDOMAIN answer plus AWS's documented reuse
behaviour is the proof; the claim itself is a single `create-environment` call in `us-east-2`.

## Remediation

1. **Now:** delete both CNAME records from the `differential.com` zone (DNSimple). That alone
   closes the exposure, permanently.
2. **Process:** every environment teardown should include deleting the DNS records that pointed at
   it — the AWS docs quoted above make this a launch-checklist item, not an afterthought.
3. **Sweep:** the same audit over the whole zone (CNAME → provider, then resolve the target and
   flag `NXDOMAIN`) is cheap and would catch any other record left behind by a decommissioned
   service.

## Testing notes

Passive DNS enumeration from public certificate transparency logs, `dig` queries, and one HTTP
probe per hostname. No credentials used, no environment created, no account signed up, no data
accessed. Happy to retest after the records are removed, and I'll keep this private for at least
the 60 days your policy asks for.
