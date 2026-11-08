# Handoff — for the session that HAS Supabase access

You can reach prod `npwseclcxcatjhgjrtwe` via the Supabase MCP server. The
session that wrote this could not (MCP `-32003: requires approval`, plus the
container's network policy 403s CONNECT to `*.supabase.co`). That is the only
reason this work is unfinished.

**Branch:** `claude/new-session-h7v29d` — `git fetch origin claude/new-session-h7v29d` first.
**PR:** #219, draft, CI green. Not merged, not deployed.
**Full context:** `docs/state/SESSION-HANDOFF-2026-07-29.md` on that branch.

---

## Task 1 — run this. It decides everything else.

```sql
WITH RECURSIVE t AS (
  SELECT id, lot_code, title, status, sticker_code, relisted_from_lot_id FROM lots
  WHERE lot_code IN ('BIN-002437','BIN-002569','BIN-002565','BIN-002622','BIN-002567',
                     'BIN-002624','BIN-002571','BIN-002629','BIN-002570','BIN-002627')
), up AS (
  SELECT t.id AS tid, t.id AS cur, t.relisted_from_lot_id AS par, 0 AS depth FROM t
  UNION ALL
  SELECT u.tid, p.id, p.relisted_from_lot_id, u.depth+1 FROM up u JOIN lots p ON p.id = u.par
), roots AS (SELECT tid, cur AS root_id FROM up WHERE par IS NULL),
   anc   AS (SELECT tid, cur AS ancestor_id FROM up WHERE depth > 0)
SELECT min(t.title)                                    AS title,
       array_agg(t.lot_code ORDER BY t.lot_code)       AS lots,
       array_agg(coalesce(t.sticker_code,'<NULL>') ORDER BY t.lot_code) AS stickers,
       array_agg(t.status::text ORDER BY t.lot_code)   AS statuses,
       count(*) FILTER (WHERE t.sticker_code IS NOT NULL) || '/' || count(*) AS stickered,
       bool_or(EXISTS (SELECT 1 FROM anc a WHERE a.tid = t.id
                       AND a.ancestor_id IN (SELECT id FROM t t2 WHERE t2.id <> t.id))) AS direct_line
FROM t JOIN roots r ON r.tid = t.id
GROUP BY r.root_id ORDER BY 1;
```

Five rows expected. `scripts/diagnose-lineage-duplicates.sql` on the branch has
a fuller version (Q1 lineage shape, Q3 blast radius across all live inventory).

### Why this is the deciding question

`relist_lot_into_auction` **NULLs the source's `sticker_code` and moves it onto
the new child** (0192 STEP 1/2, verbatim in 0285). `sticker_code` is globally
unique (0141), and one physical box carries one sticker. So:

| `stickered` | Meaning | Action |
|---|---|---|
| `2/2` | Two independently-stickered boxes = **distinct goods**. 0288 was wrong to block them. | mig 0294 unblocks Jared → **Task 2A** |
| `1/2` | Relist twin — sticker on one side only = **same physical box**. The guard was CORRECT; this was never a regression. | **Task 2B** |
| `0/2` | Neither stickered — unprovable. Guard stays. | **Task 2B** |

If `direct_line` is true on any row, that pair is ancestor/descendant — the same
item by construction, and 0294 keeps blocking it regardless of stickers.

**Report the five rows verbatim before acting.** The last two sessions each
acted on an unverified premise about this and both were wrong in opposite
directions.

---

## Task 2A — if `2/2`: ship it

1. Mark PR #219 ready, merge.
2. Dispatch **`apply-migration.yml`** for `0294_lineage_guard_direct_line_only.sql`.
   ⚠️ Its concurrency group holds only ONE pending run — dispatching several at
   once cancels all but the last. One at a time, verify each.
3. Dispatch **`deploy-cloudflare.yml`**. Merging ships nothing; it is
   `workflow_dispatch` only. This gap left broken report pages live for hours
   on 07-28.
4. Verify (below).
5. Have Jared retry the five pairs.

## Task 2B — if `1/2` or `0/2`: the guard was right

Say so plainly — it reverses the 07-28 handoff's premise, and the owner should
know the P0 was not a regression.

0294 is still worth shipping: it is a **strict relaxation** (nothing 0288
allowed becomes refused), it fixes a real over-block for genuinely stickered
duplicates, and part B of the PR is independent hygiene. But it will **not**
unblock these five pairs, so do not tell the owner it is fixed.

The actual fix is the **Duplicate Lot Button** — lotting cannot express "I
received N identical items", so quantity>1 keeps surfacing as a duplicate. Not
started. Design it before writing code; it is the same root issue.

---

## Verification — required in BOTH directions

Post-migration, this must return **zero rows** for the four defect kinds:

```sql
SELECT kind, count(*) FROM duplicate_lot_audit() GROUP BY kind ORDER BY 1;
```

- `same_root_active`, `sold_and_collected_still_live`, `stale_cancel_stamp`,
  `ghost_parent_on_auction` → **must be 0**.
- `same_root_distinct_units` → **new in 0294**, non-zero is expected and
  correct if `2/2`. It reports legitimate quantity>1 units so they stay visible
  instead of vanishing from the report.

`duplicate_lot_audit()` is `SECURITY DEFINER` and reads `auth.uid()` →
`operator_users`. Called with no auth context it returns **zero rows
regardless** — so an empty result from an unauthenticated MCP connection proves
nothing. Confirm you are getting real rows before trusting a zero.

Also confirm the relist guard still refuses a double-relist
(`relist_source_already_relisted`).

---

## Already verified — don't redo

Against a local pg16 with all 294 migrations applied, plus CI green on #219:

| | |
|---|---|
| Two stickered siblings both list | pass (the regression) |
| Unstickered relist twin refused | pass |
| Parent of a live child refused, though both stickered | pass |
| Index blocks two active unstickered children | pass |
| `same_root_active=0`, `same_root_distinct_units=1` | pass |

Control: reverting to the 0288/0290 definitions makes the sibling assertion fail
with exactly Jared's error, so the test is real. Lives in
`packages/db/test/lineage_assign_guard.sql`, runs in CI.

The guard **logic** is settled. What is unknown is only which population Jared's
items fall into.

---

## Do not

- **Do not just delete the guard.** It is what closed the real hole: 3 phantom
  lots were taking bids on stock already paid for and physically collected.
- **Do not act on the 07-28 handoff's stated cause.** Two of its claims are
  wrong, verified against the repo: 0269/0272 never write `relisted_from_lot_id`
  (only the relist path does), and its proposed "two active lots sharing a
  sticker_code or qr_token" check can never fire — both columns are already
  globally unique.
- **Do not enable marketing campaigns.** 5 seeded, all disabled,
  `first_bid_nudge` has 256 eligible. Needs explicit owner go-ahead.
- **Do not point anything at `xgsujdzicnjenhqihovk`.** An unexplained second
  project ref surfaced 07-29. Prod is `npwseclcxcatjhgjrtwe` (`bingo-auctions`,
  ACTIVE_HEALTHY, pg 17.6.1.127).

---

## While you have prod access — cheap wins the other session couldn't do

| Item | Query / action |
|---|---|
| **Dodge City Square location** | `UPDATE warehouses SET square_location_id='<ID>' WHERE id='1aebb495-6cd6-4f6d-8595-86fec7106eb4'` — **blocked, the ID was never supplied.** Until then every Kansas sale books to Arkansas. Also set Harrison explicitly to `LH36T6WADKGV7` (currently NULL, working only via the `SQUARE_LOCATION_ID` env fallback). |
| **Mig 0273 recovery** | Three RPCs still carry `0273` markers on prod and are absent from the repo — `intake_lot_to_bin`, `batch_intake_lot_to_bin`, `confirm_move_lot_to_bin`. Dump with `pg_get_functiondef` and commit as a recovery migration. A from-scratch rebuild currently loses that behaviour. 0274 and 0276 are also missing. |
| **Migration ledger drift** | Compare `_schema_migrations` against `packages/db/migrations/`. Migrations have reached prod uncommitted before (0273–0276). |
| **Twilio** | 0 of 27,319 outbox rows ever sent; only 2 of 627 bidders have `sms_enabled` (421 have a phone). Run `sms_optin_push` (419 eligible) before turning anything on. |
