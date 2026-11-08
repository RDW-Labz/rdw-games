# Migration review records

These JSON files record **what an author or reviewer claimed** about a migration.
They do not authenticate a reviewer, establish that anyone inspected physical
inventory, verify a before-image exists, or prove that SQL affects only listed IDs.
A checksum ties a claim to SQL bytes; it does not make the claim true.

The mandatory runner checks introduced in PR #357 were reverted because they broke
historical filename reruns, changed timeout behavior and retired a documented
execution path. Neither restored runner requires these records. CI no longer
requires one JSON file per migration. The retained 0369 record describes the
original review; its runner-policy wording is historical, not an active rule.

## Current migration behavior

- `scripts/apply-migrations.js` supports existing filename reruns, including
  unchanged SQL with top-level BEGIN/COMMIT and no review JSON.
- `--status` and `--dry-run` retain their earlier behavior; dry-run does not
  execute or rehearse SQL.
- `scripts/push-hosted-migrations.js` and its START_AT behavior are restored.
- Neither runner adds the withdrawn thirty-second statement timeout or invokes
  the physical-footprint assertion automatically.
- Existing authorization, target checks and the [physical-impact checklist](../../../docs/PREFLIGHT.md)
  still apply. Do not use blanket application as a production recovery shortcut.

Migration 0369 remains installed and unchanged. For destructive lot work, the
reviewed SQL must explicitly call `assert_no_physical_footprint(uuid[])` on the
exact captured IDs in the same READ COMMITTED transaction as its mutation.
Choose explicit, appropriate timeouts for that reviewed operation. The assertion
locks footprint tables until transaction end and rejects recorded physical
footprints; it does not prove absence of unrecorded labels or active staff work.

Any future runner enforcement, reviewed timeout override or authenticated approval
mechanism needs its own proposal and compatibility evidence. Retiring the hosted
helper is a separate decision. These records must not be described as that control.

## New-file CI omission lint

The physical-footprint workflow now lints newly added migration SQL for common
lot mutations missing an explicit prior assertion. See [the exact scope and
limits](../../../docs/PREFLIGHT.md#ci-backstop-for-new-lot-changing-migrations).
This uses SQL syntax, not these JSON claims. It does not authenticate approval,
prove matching IDs, or modify either migration runner. Existing historical
reruns still require no sidecar and use their unchanged SQL.
