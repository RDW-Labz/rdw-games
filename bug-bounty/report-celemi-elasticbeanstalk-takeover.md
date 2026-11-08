# Subdomain takeover: `dig.sim.celemi.com` (dangling CNAME to a terminated Elastic Beanstalk environment)

**Reported by:** Michael Cluer
**Date:** 2026-11-01
**Program:** Celemi disclosure policy (disclose.io profile — full safe harbour, CVD)
**Contact:** security@celemi.com
**Severity:** Medium — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)
**Status:** Not tested beyond DNS. Nothing was claimed, registered, or served.

---

## 1. Summary

`dig.sim.celemi.com` is a DNS record in the `celemi.com` zone (Route 53) that points at an Elastic
Beanstalk environment hostname which no longer exists:

```
dig.sim.celemi.com. 3221 IN CNAME mup-env-celemi-prod-app-central.txpey7hhzg.eu-central-1.elasticbeanstalk.com.
mup-env-celemi-prod-app-central.txpey7hhzg.eu-central-1.elasticbeanstalk.com  ->  status: NXDOMAIN
```

`sim.celemi.com` itself is live (A records to EC2 in eu-central-1, `3.170.115.9/11/55/109`), so the
`dig` label looks like a left-over piece of a simulation environment — a name that was provisioned
once and torn down without its DNS entry being removed.

## 2. Why the name is claimable by a third party

Elastic Beanstalk CNAMEs come in two shapes:

| Shape | Example | Claim path |
|---|---|---|
| Plain | `<prefix>.<region>.elasticbeanstalk.com` | anyone can create an environment with that exact `--cname-prefix` in that region |
| Hashed | `<env>.<id>.<region>.elasticbeanstalk.com` | the `id` segment is the deletable part; an environment created with `--cname-prefix <id>` resolves **every** nested name under it |

This record is the hashed shape, `txpey7hhzg` being the id segment. AWS's own documentation on the
feature states that terminating an environment does not release the association for you:

> "If you terminate an environment, you must also delete any CNAME mappings that you created, as
> other customers can reuse an available hostname… A dangling DNS entry can expose internet traffic
> destined for your domain to security vulnerabilities."

Public research on the hashed form (Stratus Security, *AWS Subdomain Takeover Guide*) documents the
same outcome: registering the id segment as a new environment's DNS name wildcards the nested names
beneath it, which is exactly the `mup-env-celemi-prod-app-central` entry here.

**I did not attempt the claim.** Proving it would mean provisioning an AWS environment and serving
content under `celemi.com`, which is your asset to authorise, not mine. The evidence is the DNS
state plus the provider's own documented behaviour.

## 3. Impact

An attacker who registers the name serves content at `https://dig.sim.celemi.com` with a valid
certificate — DNS validation passes through the CNAME to their environment, so no MITM or forged
certificate is needed. That buys:

- Phishing under the Celemi brand on a `celemi.com` origin, which survives most domain-reputation
  checks and any allow-list that trusts the parent domain.
- Bypass of controls keyed on the domain: CORS allow-lists, OAuth `redirect_uri` patterns, CSP
  `script-src` entries, proxy/e-mail allow-lists.
- Capture of anything still pointed at the dead name — integrations and CI jobs that have not been
  cleaned up — including bearer tokens sent in headers.

The `sim` label suggests a simulation/testing environment; if any client-facing material, SSO
callback or training integration still references it, the traffic is already failing today and
would be captured silently after a takeover.

## 4. Reproduction

```
dig dig.sim.celemi.com CNAME
dig mup-env-celemi-prod-app-central.txpey7hhzg.eu-central-1.elasticbeanstalk.com A   # NXDOMAIN
dig sim.celemi.com A                                                                  # live: 3.170.115.9 ...
```

Raw output: `evidence-celemi/01-dns.txt`.

## 5. Remediation

1. Delete the `dig.sim.celemi.com` CNAME. That alone closes the exposure.
2. Sweep the zone for any other CNAME whose target no longer resolves — there may be more from the
   same environment.
3. Add "delete the DNS records" to the Elastic Beanstalk teardown runbook, before `eb terminate`.

## 6. Disclosure

Reported privately to security@celemi.com under the published policy. I am happy to hold for your
usual remediation window and will not publish before that. No systems were accessed, no traffic was
intercepted, and no account was created at the provider.
