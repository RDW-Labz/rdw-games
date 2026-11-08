# Physical inventory safeguards for destructive migrations

Status: migration0369 is deployed (run35652004382); read-only production test35652311846 flagged PNK4822591 with reason sticker_code. The physical-impact checklist remains required. PR357's runner-policy changes were withdrawn to restore historical filename reruns and the hosted helper. Review JSON records claims, not authenticated approval. Restoration of the 347 lots is complete and separately recorded in the [incident audit](../audits/2026-09-21-pink-stickers-hidden-by-cleanup.md).

## Work backwards from the failure

0366 did what its predicate asked. The safety review concentrated on auctions, bids and winners and omitted the physical item. Its SQL did not include a separate invoice predicate; that detail does not change the failure: passing the financial checks could not answer whether staff held a printed label or had already shelved the box. This was an incomplete decision rule, not an unexplained failure to execute it.

The single blocking check was: **does ANY row in the proposed destructive batch have a physical footprint? If yes, abort the whole generic cleanup before changing any row.**

For today's batch, `sticker_code IS NOT NULL` alone would have found 342 rows and stopped the entire deletion. Adding intake-bin evidence protects at least one further row (ten with bins, nine overlapping stickered rows). That does not establish that the remaining four are safe to delete. A machine-visible footprint is positive evidence; absence is not proof that no person has a box or label.

Keep product correction separate from identity removal. A questionable title calls for review/correction on the same findable lot, not removal of its code from staff lookup.

## 1. Required destructive-migration checklist

The [preflight document](../PREFLIGHT.md) applies to hard deletes, soft deletes, reassignment of existing rows, merges/deduplication and other changes that make an existing identity cease resolving. It asks what happens to a person holding the label, scanning at a shelf, moving inventory, bidding, paying or handing over an item. Include indirect effects through cascades, triggers, changed lookup visibility and overwritten foreign keys.

Before approval, materialize the proposed IDs and record a read-only impact summary: count, identifiers, original values, footprint reasons, and affected staff/customer flows. Identify the warehouse person who can confirm current activity. Database inactivity is not evidence that no one is working: mobile/offline work and a label in someone's hand may leave no current query. An unknown physical impact blocks destructive cleanup; choose a non-destructive correction or explicit physical reconciliation.

A named reviewer must answer the physical-impact questions, in addition to ordinary data/financial invariants. Rehearse rollback, preserve the exact before-image needed for reversal, and verify codes resolve before and after. A count assertion and a backup table do not substitute for this review.

## 2. Reusable physical-footprint guard

Implemented interface:

- `lot_physical_footprint(p_lot_id uuid)` returns evidence reasons and contributing lot IDs.
- `lot_has_physical_footprint(p_lot_id uuid)` returns the boolean from that same evidence definition.
- `assert_no_physical_footprint(p_lot_ids uuid[])` raises if any proposed lot has evidence, or any ID cannot be evaluated. A destructive migration invokes it before its first mutation and uses the same captured ID set for both the assertion and mutation.

The evidence definition includes:

- Non-null `lots.sticker_code` (conservative even if legacy malformed/blank).
- `lots.intake_bin_id` or `intake_at` set.
- Any `bin_assignments` record, including historical assignment.
- Any `lot_location_events` record, including a move to a null bin. Migration 0328 deliberately records removal from a shelf; clearing today's bin must not erase physical history.
- A `lot_sticker_pool` claim pointing to the lot. Absence of a pool row does not negate a sticker binding.
- Evidence across the full connected relist family: ancestors, descendants and sibling branches reached through ancestors. A relist changes the row while the physical box may remain on the same shelf. Traversal must deduplicate IDs, handle cycles, remain operator-scoped, and reject inconsistent cross-operator lineage rather than silently dropping it.

Evaluate soft-deleted lineage members too; a prior deletion must not make a physical footprint disappear. Missing input lots, permission errors, incomplete traversal and query failure are errors, never “false.” Expose the administrative guard only to the migration/admin role, with fixed search_path and explicit revocation of public/anon/authenticated access; do not create a public way to inspect hidden inventory. The ordinary app must not receive a new bypass-RLS endpoint.

Use raw tables with indexed EXISTS queries and bounded, set-based batch evaluation. Do not reuse `lot_location_history()` as the safety predicate: it depends on operator context, filters null-bin events and caps output, losing evidence needed here. Existing indexes support location events by lot and bin assignments by lot; verify actual plans for pool claims and lineage before adding indexes. Test the batch at representative scale instead of calling an unbounded lineage scan hundreds of times.

### What this guard cannot yet know

Printing a canonical BIN/QR label does not necessarily populate `sticker_code` or the preprinted pool. Current evidence is not a complete print ledger. Plan a small append-only lot-label issuance/request event at the server boundary used for PDF/ZPL/label generation, and include it in the guard. A request is conservatively protected even if printing later fails; do not claim a printer receipt proves a label reached a box. Cover every actual print path and offline/native printing, or keep uncovered paths explicitly manual-review-only. Do not backfill “never printed” from absent historical events.

Active warehouse work also needs human confirmation until there is a trustworthy work-claim mechanism. No active SQL sessions is not clearance to delete.

### Exceptions and races

The generic cleanup defaults to **abort**, not silently skip protected rows and report success. For a deliberately approved, narrower cleanup, capture a new reviewed subset and report every exclusion. A necessary physical reassignment requires a specific reviewed migration and physical relabel/rescan/reconciliation plan; do not introduce an environment-wide `skip_guard=true` toggle. Record exact approved IDs and reason.

Checking once and later mutating leaves a race with staff binding/placing an item. The destructive migration must recheck in the mutation transaction under a locking strategy shared with all footprint writers, with bounded timeouts and a reviewed execution window. Row locks alone are not claimed sufficient for every child-table insert or print path. Until this is proven, use a coordinated pause of the affected warehouse workflow; unknown concurrent/offline work blocks generic cleanup. Do not deploy a broad application trigger that suddenly rejects routine pickup, relist or disposal operations without tracing those paths.

## 3. Original runner proposal — withdrawn, not current behavior

The following was the original proposal. Its implementation broke recovery compatibility and was withdrawn. These requirements are not enforced by the restored runners; any replacement needs a separate proposal and compatibility proof. Explicit use of the installed SQL assertion remains required by the checklist.

1. Every future/pending migration declares whether it changes existing identities/data, or is schema-only. Destructive data changes supply a captured lot-ID set, before-image/reversal reference and completed physical-impact review. Historical reruns need a separately reviewed declaration/authorization tied to the original SQL checksum; do not rewrite historical SQL just to add metadata.
2. The runner invokes the batch assertion for declared destructive lot changes and refuses missing declarations/review metadata. A generic cleanup cannot claim protected rows were checked merely through a comment.
3. CI detects common destructive SQL and missing declarations as a backstop. Dynamic SQL, cascades and called functions still require human impact review; a regex cannot prove their absence. Reviewers must reject inaccurate schema-only declarations.
4. Keep the existing applier's transaction semantics and explicit production-target checks. Validate every production migration entry point, including single-file reruns and Management API execution; otherwise a new runner check would cover only one path.

This plan changes no existing migration. Allocate a new migration number only after current reservations are checked; 0367/0368 remain assigned to #348. Do not retrofit a destructive guard into historical 0366 and assume that repairs an already-run operation.

## 4. §7c and implementation acceptance

Callers/data writers to trace: `scripts/apply-migrations.js`, the Actions migration workflow and supported manual procedure; sticker bind/rebind/clear RPCs; single/batch intake and relocation; relist functions; bin assignment and location-log triggers; native and web print generation; operator lookup and mobile scan resolvers. Existing collected-item, missing-item and payment invariants remain required alongside this guard.

Affected people/surfaces: warehouse mobile scanners, printed labels, shelf lookup, operator web, public code lookup, bidder web/iOS/Android and pickup staff. The initial helper/runner rollout must not silently alter their everyday transitions. A canonical code still resolving is an acceptance check, not just a surviving row count.

Required negative cases:

- Replay a synthetic 0366-shaped batch containing a saved stickered lot with zero bids/auction/winner: the original cleanup would delete it; the new assertion must abort before ANY batch row changes. Removing the guard must make this regression fail.
- One fixture for each evidence source, including a cleared bin with history, a claimed pool row, a printed canonical label without sticker_code, and a relist child with evidence only on its ancestor or a sibling branch.
- Missing/cross-operator/cyclic lineage, denied access, timeout and unknown print history never become automatic clearance.
- Staff binds/places/prints between discovery and mutation: either the new footprint blocks mutation or the reviewed writer/transaction protocol prevents that race. Demonstrate the real boundaries, not only a mocked function.
- Rollback restores original identifiers and values; retries reuse the captured batch rather than rediscovering new rows. Partial application cannot report success.
- Legitimate app flows retain behavior; only the intended migration gate changes. Document any route that still bypasses the gate.

Historical rollout proposal (runner enforcement withdrawn): guard/evidence implementation and focused tests first; runner/preflight enforcement second; controlled synthetic dry-run third. Three substantive review passes and final preflight apply to each slice. No live failure injection, disposal, restoration or deployment is authorized by this plan.

## Review record

Pass 1: reconstructed the omitted physical-impact question from the actual deletion and restored set. Pass 2: traced existing physical evidence, print blind spots, lineage and concurrent-work risks. Pass 3: independent review found no plan-only blocker; clarified raw-table evidence, sibling lineage and historical-rerun policy. Documentation preflight confirms this is a plan, not a deployed protection claim; links, scope, source facts and whitespace checked. No application tests are claimed for the documentation changes.

## Implementation follow-up

Migration0369 implements all six recorded evidence sources and complete connected relist-family traversal, including deleted siblings. It refuses missing/null IDs, dangling/cross-operator/cyclic lineage and bounded-traversal exhaustion. Admin-only SECURITY INVOKER functions use fixed search paths and fail on RLS-hidden evidence. The assertion requires READ COMMITTED, obtains SHARE ROW EXCLUSIVE locks on lots and the three child evidence tables in fixed order, then evaluates a fresh snapshot. These locks block warehouse writes until transaction end. A five-second lock timeout bounds assertion lock acquisition. The restored runners do not add a statement timeout; the reviewed destructive operation must choose one explicitly. Use a short reviewed maintenance window.

The runner-policy implementation described below is historical and has been reverted. Both runners now match their pre357 versions: historical transaction-bearing SQL and filename reruns work without sidecars; push-hosted and START_AT are restored. The mandatory review validator, automatic guard injection and runner-imposed thirty-second timeout are removed. Physical SQL functions, their behavioral/concurrency tests and the CI0366 fixture are retained unchanged.

The checklist requires explicit assertion use on the exact captured IDs in the mutation transaction. There is no automatic runner enforcement or application-wide trigger. Review records neither authenticate warehouse clearance nor enforce arbitrary SQL scope. Privileged entry points remain governed by the checklist and existing authorization.

Canonical/offline print coverage is still incomplete: no print ledger was invented or backfilled. Unrecorded physical activity remains a mandatory warehouse-review gate. The guard will stop today's recorded-sticker case; it does not certify that every physically printed label is visible to SQL.

### Historical PR357 verification record (September21; runner findings superseded)

Pass1 reconstructed0366's missing physical requirement and traced all six evidence sources, full relist lineage, grants and actual runner entry points. Pass2 exercised real PostgreSQL fixtures: a347-row financially empty batch with one sticker aborts wholly; replacing the assertion with a no-op makes that regression fail. Two-session tests show all four table writers blocked, a preceding writer's committed sticker observed after locking, lock timeout refusal, and stale isolation refusal. These are an isolated schema, not a claim of full production trigger integration.

Independent pass3 found and corrected three runner problems before release: whitespace around identity assignments escaped a text check, ambiguous string quoting hid transaction boundaries, and tracking SQL initially lacked a statement terminator. Actual runner execution through pg and Management-API adapters backed by local PostgreSQL now verifies commit, tracking-failure rollback, missing-review refusal, read-only status, physical-batch rejection and the reviewed empty-footprint path. No live Management API transaction is claimed by these adapter tests.

Local preflight: eight Node tests pass with real PostgreSQL adapter cases enabled; SQL behavioral and concurrent-writer tests pass; migration declaration checksum validates; root static/dependency preflight and whitespace checks pass. Full-schema and embed-smoke CI initially failed at0366's empty-database count assertion. A CI-only positive fixture now creates one synthetic eligible lot, executes unchanged0366, verifies its capture/deletion, then removes all fixture rows while retaining the real capture-table schema. It refuses missing scratch authorization, nonempty databases and repeat use. Both full-schema and embed-smoke checks passed on revision e8a6514, alongside the dedicated guard job. Migration0369 was subsequently deployed and verified as recorded at the top of this document. Those runner tests did not cover historical compatibility, which prompted the recovery revert.

## Separate follow-up: CI omission lint, runner proposal still separate

A new-file CI check now catches direct lot mutations missing an earlier explicit
assertion in a transaction. It would reject 0366 if introduced as new SQL, while
leaving the existing historical file and runners unchanged. It is a conservative
syntax backstop, not proof of guarded row scope or human clearance. Full behavior,
title-correction limitations, and review obligations are in [preflight](../PREFLIGHT.md#ci-backstop-for-new-lot-changing-migrations).

Runtime enforcement remains a separate runner proposal. Its acceptance must cover
unchanged historical BEGIN/COMMIT and filename reruns on both backends, status,
dry-run, START_AT, and tracking/partial-commit failures. A timeout override must
be explicit, documented, reviewed per migration and displayed before execution.
Retiring push-hosted remains an independent decision. Review JSON continues to
record claims only; any authenticated approval would need independent enforcement
bound to the exact SQL and target. None of that is implemented by this CI change.
