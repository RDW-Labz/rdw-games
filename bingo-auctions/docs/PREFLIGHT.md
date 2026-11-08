# Change preflight

Use with WORKING_AGREEMENT §7c. Complete three distinct passes: scope/impact, behavior/failure evidence, and independent final integration review. A passing test suite verifies questions encoded in tests; it does not supply missing operational questions.

## Destructive migration: mandatory physical-impact review

Applies whenever a migration deletes, soft-deletes, reassigns, merges or hides existing rows/identifiers, including effects through cascades, triggers and called functions.

- [ ] Exact affected IDs and original values are captured; count alone is insufficient. Target, expected scope, reversal and post-checks are explicit.
- [ ] **Does any row represent something physical?** A box, printed sticker, canonical/QR label, shelf/bin position, staged pickup, or label in someone's hand? Check current bindings AND history/lineage.
- [ ] **Is anyone acting on it now?** Name the warehouse reviewer and establish the work window. No active database query does not establish that staff/mobile/offline activity has stopped.
- [ ] **What breaks for a person?** Walk the action: label scan → lot lookup → shelf/put-away → auction/pickup. Explain how the existing code and physical item remain findable.
- [ ] Query and review footprint evidence. Any footprint blocks generic destructive cleanup; unknown physical impact also blocks it. Missing evidence is not permission.
- [ ] Use `assert_no_physical_footprint(uuid[])` on the same captured IDs and transaction as the mutation. The restored runners do not inject this assertion: destructive maintenance SQL must call it explicitly before mutation. Review JSON records claims; it does not authenticate physical clearance. Confirm migration0369 is installed on the actual target; a local test is not deployment.
- [ ] Verify bids, invoices, auctions, winners, payments, collected-item protections and other existing business invariants separately. Their absence does not prove a physical row is disposable.
- [ ] Prefer correcting titles/metadata while preserving the original identity. Any protected-row reassignment/deletion requires an explicit physical reconciliation plan and approval for the exact IDs; no blanket bypass flag.
- [ ] Rehearse with rollback, account for concurrent footprint writers, and use bounded lock/statement timeouts. Stop on a scope mismatch, stale capture or failed guard.
- [ ] After commit, independently verify affected counts AND representative real codes/lookup behavior. Record any UI/device verification still outstanding.

Today's counterexample: 0366 removed 347 lots; 342 had sticker bindings and ten had intake-bin references. `IF any captured lot has a physical footprint THEN abort` would have stopped the entire generic cleanup. The missing requirement was physical continuity, not an SQL test assertion that happened to be absent.

Guard design and enforcement: [physical-footprint safeguard plan](plans/PLAN-physical-footprint-migration-safeguard-2026-09-21.md). Implementation is in migration0369, applied in production run35652004382 and verified read-only in run35652311846. The runner-policy changes from PR357 were withdrawn to restore historical recovery compatibility. See [review-record limitations and current runner behavior](../packages/db/migration-reviews/README.md).

## CI backstop for new lot-changing migrations

The Physical footprint guard workflow checks **new SQL paths** against the PR base
(or the previous commit on a master/main push), with rename detection disabled.
Unchanged historical files and both execution runners are untouched. A copied or
renamed historical migration is new SQL for this check. Missing base history fails
with an error; it does not silently skip the check.

Run locally after committing the candidate migration:
`node scripts/check-new-lot-migrations.cjs --base <full-base-commit-sha>`.
It checks committed additions; it is not an editor/working-tree check.

For detected migration-time `UPDATE` / `DELETE` against `lots` or `public.lots`,
CI requires an explicit transaction and an earlier standalone
`SELECT public.assert_no_physical_footprint(...)` in that transaction. Quoted
identifiers, aliases, `ONLY`, CTEs and direct writes inside `DO` are included;
`MERGE INTO lots` and direct `TRUNCATE lots` are also flagged. Put the assertion
outside `DO`, before the block. Comments, strings, a function definition, or an
assertion after the write do not count. Dynamic `EXECUTE` inside `DO` is rejected
as unanalyzable; use explicit maintenance SQL. Nested `DO` and escape-string
`DO` bodies are also rejected; use top-level dollar-quoted blocks. Unicode-escaped
SQL syntax is rejected; use ordinary identifiers/literals. No waiver JSON
is accepted.

This is a **conservative omission lint**, not a SQL execution or authorization
control. It cannot prove that the assertion checks the exact IDs mutated, that
all execution paths are protected, or that a human inspected boxes. Calls to
existing routines, trigger/cascade effects, writes through views/other schemas,
and arbitrary SQL syntax require the impact review above. Creating a function
is not executing it: function/procedure bodies are not classified as immediate
migration writes. Review the functions and their callers separately.

All direct lot updates are flagged, including title-only corrections. That is
intentionally conservative: do not check an empty/unrelated ID array to appease
CI, and do not remove physical evidence to make a title correction pass. A
protected-row correction needs a separately reviewed, narrowly scoped policy;
this change supplies no generic bypass. The installed guard remains appropriate
for generic destructive cleanup, not every legitimate inventory operation.

Use this structure for generic cleanup, after completing the physical review:

```sql
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
-- Capture the reviewed IDs and before-image; assert expected scope/count.
-- Choose and review an appropriate timeout for this particular operation.
SELECT public.assert_no_physical_footprint(
  ARRAY(SELECT lot_id FROM public.reviewed_cleanup_ids)
);
-- DELETE/UPDATE only those same IDs, then verify postconditions.
COMMIT;
```

This is a structure, not ready-to-run cleanup SQL. The lint does not change the
production migration workflow or historical reruns. Making this CI status a
required merge check is a repository protection setting, not a property of the
script; a green lint must never be described as verified physical clearance.
On September 21, the classic protection read returned 404 and the branch-rules
API returned 403 with a GitHub plan-upgrade message. Required-status enforcement
was not verified; this change adds a failing CI status, not a proven merge lock.

## Final release checks

- [ ] One owner per changed output; parallel writers isolated; final diff contains only the authorized scope.
- [ ] Callers, surfaces, DB objects and upstream/downstream effects reviewed under §7c.
- [ ] Meaningful regression guards reject the original failure; required checks/CI pass or blockers are plainly stated.
- [ ] No credentials/customer PII in code, artifacts or retained logs.
- [ ] Current branch/revision, migration order, approvals, trading-hour impact and rollback verified.
- [ ] Deployed, configured, provider-accepted and customer-verified are reported as separate states.
