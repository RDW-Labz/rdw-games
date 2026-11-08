# Dangling DNS → potential subdomain takeover: `ind-dev.stewart.com`, `ind-uat.stewart.com`

**Program:** Stewart — Vulnerability Disclosure Program
(`https://www.stewart.com/en/vdp`, tier *L5 — full safe harbour + CVD* in disclose.io's directory)
**Official channel:** `secops@stewart.com`
**Assets:** `ind-dev.stewart.com`, `ind-uat.stewart.com` (records in the `stewart.com` zone,
Cloudflare DNS)
**Class:** Dangling CNAME to a deprovisioned Azure Traffic Manager profile
**Severity:** Medium (takeover) / Low (dangling record alone) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)
**Researcher:** Michael Cluer
**Date found:** 2026-11-01

---

## Summary

Two `stewart.com` records still CNAME to Azure Traffic Manager profiles that no longer answer:

```
ind-dev.stewart.com.   300 IN CNAME ind-dev.trafficmanager.net.   -> NXDOMAIN
ind-uat.stewart.com.   300 IN CNAME ind-uat.trafficmanager.net.   -> NXDOMAIN
```

Traffic Manager profile names are a **globally unique, tenant-scoped namespace**. Microsoft's
Traffic Manager FAQ is explicit about what happens on deletion:

> *"When you delete a Traffic Manager profile, the associated domain name is reserved for a period
> of time. Other Traffic Manager profiles in the same tenant can immediately reuse the name.
> However, a different Azure tenant isn't able to use the same profile name until the reservation
> expires."*

So after the reservation lapses, **any Azure tenant can create a profile called `ind-dev` and
receive `ind-dev.trafficmanager.net`** — the exact hostname your record points at — and then bind
an external endpoint to it. Public Azure takeover guides document this claim path end to end
(create profile → green tick confirms the name is free → add an *External* endpoint → your content
is served on the customer's subdomain).

Two caveats I want to be straight about, because they are what a triager will ask:

1. `NXDOMAIN` on a `trafficmanager.net` name has a second cause: the profile still exists but has
   no healthy endpoints. So this is proof that the record is **dead**, not proof that the name is
   already claimable. The claimability depends on whether the profile was deleted and when the
   reservation expires. Only you (or Azure support on the subscription) can confirm which case
   this is — and it changes nothing about the fix.
2. If the profiles were deleted and the reservation is active, the exposure is dormant, not gone:
   the record sits there pointing into a namespace that will be handed to someone else later.

Either way these are dangling DNS entries that should not exist.

## Evidence

```
$ dig +noall +answer ind-dev.stewart.com CNAME
ind-dev.stewart.com.  300  IN  CNAME  ind-dev.trafficmanager.net.
$ dig ind-dev.trafficmanager.net A +noall +comments
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN

$ dig +noall +answer ind-uat.stewart.com CNAME
ind-uat.stewart.com.  300  IN  CNAME  ind-uat.trafficmanager.net.
$ dig ind-uat.trafficmanager.net A +noall +comments
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN
```

`can-i-take-over-xyz` classifies **Microsoft Azure** — `azurewebsites.net`, `cloudapp.azure.com`,
`blob.core.windows.net`, and the rest of the platform's shared hostname space — as **Vulnerable**
with `NXDOMAIN` as the signature (issue #35). Traffic Manager belongs to that same shared,
tenant-claimable namespace.

## Impact

If the profile names are claimable, an attacker gets:

- attacker-controlled responses at `ind-dev.stewart.com` / `ind-uat.stewart.com` with a
  certificate issued for those exact names (DNS validation succeeds through the claimed profile);
- a `stewart.com` origin for phishing, defeating brand-reputation checks and any
  `*.stewart.com` allow-list (CORS, `redirect_uri`, CSP, proxy rules);
- capture of any request still configured for those hostnames — including tokens in headers.

The `ind-` prefix and `-dev`/`-uat` suffixes point at an integration/QA environment, so the
credential-capture path is the realistic risk rather than direct customer traffic.

## Remediation

1. Delete both CNAME records from the `stewart.com` zone. One change, closes it permanently.
2. If you want to keep the names, point them at a resource you still own — a dangling record is
   never the right placeholder.
3. Add "delete the DNS records" to the Azure resource teardown checklist, and sweep the zone once
   for any CNAME whose target no longer resolves (Traffic Manager, App Service, Storage, plus the
   AWS equivalents). The sweep is a few `dig` calls.

## Testing notes

Passive DNS enumeration only: public certificate transparency logs plus `dig`. No HTTP requests
were made to the records (they do not resolve), no Azure subscription was used, and no profile was
created or claimed. I will keep this private for well past your policy's disclosure window.
