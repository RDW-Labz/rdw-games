# DNS estate sweep — scope of work

**Client:** ______________________  **Date:** ____________
**Prepared by:** Michael Cluer

## 1. What is delivered

For each zone listed in §2:

- Full subdomain inventory, sourced from certificate transparency logs (no brute-forcing).
- Every CNAME edge resolved and classified: live target, dangling target, or unresolvable.
- For each dangling record: the provider, whether a third party can claim the namespace, and the
  exact remediation step.
- Supporting evidence per finding: raw `dig` output, timestamps, and the provider documentation
  that establishes the reuse behaviour.
- A 30-minute walkthrough call.
- One free re-test after your team applies the fixes (within 60 days).

Delivery: PDF report plus a machine-readable CSV of every record examined. 3 business days from
written scope acceptance.

## 2. Zones in scope

```
(appended per engagement)
```

## 3. What is explicitly out of scope

- Any request to your servers beyond DNS resolution. No HTTP probing, no path or parameter testing,
  no authentication testing, no fuzzing.
- Application, API, cloud-account or code review.
- Anything requiring credentials or a VPN.
- Compliance certification of any kind.

## 4. Authorisation

This engagement reads public DNS data only. No authorisation beyond that is required, and none is
claimed. The client is not granting access to any system.

## 5. Findings policy

Every finding goes to the client first, in full, whether or not the engagement proceeds. Findings
are never published, sold, disclosed to a third party, or used as leverage for payment. If the
client's own disclosure programme applies, the report is filed through it in parallel.

## 6. Commercials

| Item | Amount |
|---|---|
| Estate sweep (up to 10 zones) | $________ |
| Monthly monitoring retainer (optional) | $________/month |
| Payment terms | Net 14 from delivery |

---

**Accepted for the client:** ____________________  **Date:** __________
