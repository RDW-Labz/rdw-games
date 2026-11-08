# DNS estate sweep — Celemi

**Prepared:** 2026-11-01  **By:** Michael Cluer

## Executive summary

- Zones examined: **1** (celemi.com)
- Hostnames enumerated: **85**
- Hostnames with a CNAME: **16**
- CNAMEs pointing at a target that no longer resolves: **1**
- Of those, in a namespace a third party can register: **1**

**Act on these first.** Each is one DNS deletion away from being closed, and each is usable by a stranger today.

| Zone | Record | Dead target | Provider | Fix |
|---|---|---|---|---|
| celemi.com | `dig.sim.celemi.com` | `mup-env-celemi-prod-app-central.txpey7hhzg.eu-central-1.elasticbeanstalk.com` | elasticbeanstalk.com (hashed) | Delete the record |

## All records pointing at a dead target

| Record | Target | Status | Claimable | Note |
|---|---|---|---|---|
| `dig.sim.celemi.com` | `mup-env-celemi-prod-app-central.txpey7hhzg.eu-central-1.elasticbeanstalk.com` | NXDOMAIN | yes | hashed EB names are still takeable: a new environment using the id as its DNS name wildcar |

## Remediation checklist

1. Delete every record in the claimable list above (one DNS edit each).
2. Re-run this sweep after the changes to confirm nothing is left.
3. Add `delete the DNS records` to the teardown runbook for every hosted environment.
4. Repeat the sweep quarterly, or monthly if the estate changes often.

## Method and limits

Names come from certificate transparency logs — no brute-forcing, no wordlists. Each CNAME target is resolved and classified against a table of provider reuse behaviour built from the providers' own documentation. No request is sent to any host belonging to the client: this examines public DNS only. Ports, applications, APIs and cloud accounts are out of scope and were not tested.

A record that resolves is not proof of safety — it can still point at a service the client no longer controls. The reverse holds too: a dead record inside a namespace nobody can register is hygiene, not exposure. Both are reported above, labelled.
