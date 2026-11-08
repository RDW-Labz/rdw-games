# Bugcrowd submission — eToro Managed Bug Bounty Engagement

**Title:** Subdomain takeover via dangling CNAME to a released Azure Traffic Manager profile on etoro.com

**VRT:** Server Security Misconfiguration → Subdomain Takeover → Non-Wildcard
**Suggested priority:** P3. CVSS 3.1 `AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N` = **7.2**.

**Scope relied on:** the engagement's published target `https://*.etoro.com` — the wildcard covers any
depth subdomain, so `candle-src.etoro.com` is in scope. Programme maximum bounty is $15,000.

## Description

One CNAME record in the `etoro.com` zone points at a **Traffic Manager profile that no longer exists**.
The profile's DNS label is the only thing that answers this name: when the profile is deleted, the
`<label>.trafficmanager.net` name stops resolving — as it does now — and the label becomes available to
any Azure subscription that creates a profile with that same label. Because eToro's own record already
points at it, the attacker does not need to touch eToro's DNS: once the label is recreated and an
External endpoint is attached, `candle-src.etoro.com` resolves to attacker-controlled infrastructure.

The label in question — `prod-candle` — is guessable from the hostname alone.

## Asset

| In-scope hostname | CNAME target | Target resolution |
| --- | --- | --- |
| `candle-src.etoro.com` | `prod-candle.trafficmanager.net` | **NXDOMAIN** (no A, no CNAME) |

Verified on the wire 2026-11-02:

    dig +short CNAME candle-src.etoro.com
    prod-candle.trafficmanager.net.
    dig +short A prod-candle.trafficmanager.net
    (empty — NXDOMAIN)
    dig +short CNAME prod-candle.trafficmanager.net
    (empty)

`candle-src.etoro.com` itself serves nothing: the TLS handshake fails because no name in the chain
answers, which is the observable symptom of the dangling record.

## Reproduction

1. `dig +short CNAME candle-src.etoro.com` → `prod-candle.trafficmanager.net.`
2. `dig +short A prod-candle.trafficmanager.net` → empty (NXDOMAIN).
3. Confirm that the profile does not exist rather than being merely unhealthy: an existing profile always
   returns its endpoints' addresses; a deleted profile returns NXDOMAIN for the label itself.

## Impact

- Any content served from `candle-src.etoro.com` — phishing, credential capture, malware — carries
  eToro's brand and a hostname that is inside the `etoro.com` zone.
- A certificate for `candle-src.etoro.com` can be issued to the attacker by ordinary ACME HTTP-01
  validation once they control the endpoint the record points at, so the site appears with a valid
  eToro certificate and no browser warning.
- Cookies scoped to `.etoro.com` become reachable from attacker-controlled content on the same parent
  domain; allow-lists and CSP `script-src` entries that trust `*.etoro.com` are bypassed.
- Anything that still calls `candle-src.etoro.com` — integrations, historical client builds, QA
  configuration — silently talks to the attacker.

## Remediation

Delete the CNAME record for `candle-src.etoro.com`, or recreate the Traffic Manager profile with the
label `prod-candle` in a subscription eToro controls and keep it for as long as the record exists.
Audit the rest of the zone for CNAMEs whose targets no longer resolve — this record was found alongside 66,000
others in a passive sweep, so the same class of record may exist elsewhere in the estate.

## What was and was not done

Passive DNS resolution only. No Azure profile was created, no name was reserved, no HTTP request was made
against any eToro hostname, and no other in-scope asset was touched. The finding is DNS-record evidence
and can be reproduced by your team in seconds. Deliberately, the claim path was **not** exercised —
reserving the label would itself be a takeover of a production name, which is the vendor's call to make,
not the reporter's.

---

Draft prepared 2026-11-02 from `engine/state.db`. This is the only payable finding in the sweep of
2,353 paying-scope zones that is not part of the EPAM/emakina.at cluster.
