# Subdomain takeover: `nines.githubapp.com` points at a deleted Azure App Service app

**Programme:** GitHub — https://hackerone.com/github
**Asset in scope:** `*.githubapp.com` (listed, `bounty: yes`, submissions allowed)
**Affected host:** `nines.githubapp.com`
**VRT:** Server Security Misconfiguration → Subdomain Takeover → Non-Wildcard
**Suggested severity:** P3 (medium) — escalate if any OAuth redirect or SSO trust references this hostname
**Suggested CVSS 3.1:** 7.2 — `AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N`
**Discovered:** 2026-11-02T22:13:02Z (host-side verification, passive recon only)

---

## Summary

`nines.githubapp.com` is a GitHub-owned hostname that still carries a CNAME to an Azure App Service
application which no longer exists:

```
nines.githubapp.com.  60  IN  CNAME  ninesapp-app-service.azurewebsites.net.
```

The target returns `NXDOMAIN`, so the DNS record now points at a cloud resource name that Azure has
released back into the global pool. Azure App Service app names are unique per region and claimable by
any account on a first-come basis. Anyone who registers the name `ninesapp-app-service` inherits
`nines.githubapp.com` — HTTPS included, because the hostname already resolves to their app and
App Service will issue a certificate for the custom domain once HTTP-01/TXT validation succeeds
against content the attacker controls.

The result is attacker-controlled content served from a `githubapp.com` hostname under a valid
certificate, with no browser warning and no way for a visitor to tell it apart from GitHub's own
infrastructure.

## Impact

1. **Phishing under GitHub's brand from GitHub's own domain.** `githubapp.com` is the domain GitHub
   uses for GitHub App surfaces. A victim cannot distinguish `nines.githubapp.com` from a legitimate
   GitHub endpoint — the padlock is valid and the registrable domain is GitHub's.
2. **Cookie and storage inheritance.** Any cookie scoped to `.githubapp.com` — set by any current or
   former app on that parent domain — is sent to the taken-over host. If a session-relevant cookie
   exists at that scope, this becomes session theft rather than brand abuse.
3. **OAuth / redirect abuse.** Any GitHub App or OAuth application with a registered redirect URI or
   callback on `nines.githubapp.com` can be driven through the attacker's endpoint, which yields
   authorization codes for the attacker's app registration or leaks tokens to it, depending on the
   flow.
4. **Supply-chain trust.** Tooling and CI configs that pin or allow-list `*.githubapp.com` as a
   trusted origin will treat the taken-over host as first-party.

This is not a parked-name or wildcard artefact: the record is specific, the parent domain is in the
programme's published scope, and the deleted resource makes the hostname genuinely claimable.

## Steps to reproduce the misconfiguration

From any host with outbound DNS:

```bash
dig +short CNAME nines.githubapp.com
# ninesapp-app-service.azurewebsites.net.

dig +short A ninesapp-app-service.azurewebsites.net
# (empty)

dig ninesapp-app-service.azurewebsites.net +noall +comments | grep status
# ;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN
```

An `NXDOMAIN` on the CNAME target of a live record is the misconfiguration. Verifying that the name is
actually claimable requires creating an Azure App Service app with that name, which I have **not** done
— no resource was registered and no traffic was sent to the hostname beyond a single `HEAD`-equivalent
connection attempt, which fails to connect (`curl` returns `000`, no HTTP status), consistent with a
target that does not exist.

## Remediation

Delete the `nines.githubapp.com` CNAME, or, if the app is still wanted, recreate the Azure App Service
app and restore the binding. Deleting the record is the complete fix — there is no cache TTL concern
beyond 60 seconds.

Audit the rest of `*.githubapp.com` for the same pattern; the underlying cause (records left behind when
an App Service app is deleted) is almost never a single instance.

## Notes for triage

- Recon was passive: certificate-transparency-derived hostnames, DNS resolution, and one connection
  attempt per host. No account creation on GitHub, no resource claimed on Azure, no fuzzing.
- The DNS record has a 60-second TTL and was re-verified immediately before this report was written.
- If you consider `githubapp.com` out of scope for takeover classes specifically, please say so and I
  will close it rather than pursue it — the record is real either way and worth deleting.
