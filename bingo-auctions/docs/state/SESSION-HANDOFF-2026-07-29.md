# Handoff — 2026-07-29

Continues `HANDOFF20260728.md`. Read that first for the items this session did
not touch; everything it listed as open is still open unless contradicted below.

**Branch:** `claude/new-session-h7v29d` — `git fetch origin claude/new-session-h7v29d`
before comparing anything (2026-07-28 gotcha #5).
**Open PR:** **#219**, draft, CI green, **not merged, not deployed.**
Two separable parts: **A** the P0 dedupe guard, **B** preflight/tooling hygiene.
**Prod:** Supabase `npwseclcxcatjhgjrtwe` · payments = Square
**Migrations added:** 0294 (in repo, **not applied to prod**)

---

## 🔴 Start here: one query decides whether the P0 is actually fixed

PR #219 ships mig 0294, which narrows the dedupe guard. Its logic is verified in
both directions (see below). What is **not** verified is whether it unblocks
**Jared's actual five pairs** — that needs one prod query I could not run.

```sql
WITH RECURSIVE t AS (
  SELECT id, lot_code, title, status, sticker_code, relisted_from_lot_id FROM lots
  WHERE lot_code IN ('BIN-002437','BIN-002569','BIN-002565','BIN-002622','BIN-002567',
                     'BIN-002624','BIN-002571','BIN-002629','BIN-002570','BIN-002627')
), up AS (
  SELECT t.id AS tid, t.id AS cur, t.relisted_from_lot_id AS par FROM t
  UNION ALL SELECT u.tid, p.id, p.relisted_from_lot_id FROM up u JOIN lots p ON p.id = u.par
), roots AS (SELECT tid, cur AS root_id FROM up WHERE par IS NULL)
SELECT min(t.title) AS title,
       array_agg(t.lot_code   ORDER BY t.lot_code) AS lots,
       array_agg(coalesce(t.sticker_code,'<NULL>') ORDER BY t.lot_code) AS stickers,
       count(*) FILTER (WHERE t.sticker_code IS NOT NULL) || '/' || count(*) AS stickered
FROM t JOIN roots r ON r.tid = t.id GROUP BY r.root_id ORDER BY 1;
```

Fuller version with lineage shape + blast radius: `scripts/diagnose-lineage-duplicates.sql` (read-only, Q1–Q3).

| Result | Meaning | Do this |
|---|---|---|
| `2/2` | Separately-stickered boxes — genuinely distinct goods | 0294 unblocks them. Merge #219, apply 0294, dispatch deploy, have Jared retry. |
| `1/2` | **Relist twins — the same physical box.** The guard was CORRECT and this was never a regression | Do **not** relax further. 0294 is still right to ship (strict relaxation, harmless), but the real fix is the **Duplicate Lot Button** — the system cannot express "I received N identical items". |
| `0/2` | Neither stickered — unprovable | Guard stays. Same conclusion as `1/2`. |

**My read, unconfirmed:** the prior handoff records that all five pairs have
`relisted_from_lot_id` set, i.e. they came through the relist path — which is
the shape that produces the `1/2` signature. If so the answer is the quantity
feature, not a guard change. Get the query result before acting on that hunch.

---

## What shipped in PR #219

### mig 0294 — fire the guard on the direct line, not on siblings

0288's guard resolved a lot's lineage **root** and walked the **entire tree**,
refusing if any member was `scheduled`/`live`. A tree contains collateral
relatives, and a sibling is not necessarily the same box.

**The discriminator is not what the 07-28 handoff proposed.** `sticker_code`
(0141, partial UNIQUE on NOT NULL) and `qr_token` (0103, UNIQUE) are already
**globally unique** — no two lots can share a value, so a "two active lots
sharing a sticker" check can never fire. It would have been dead code.

What is load-bearing: `relist_lot_into_auction` **NULLs the source's
`sticker_code` and moves it onto the new child** (0192 STEP 1/2, verbatim in
0285). A second relist of one parent finds no sticker left to move, so its child
gets NULL. Therefore within one lineage:

| Shape | `sticker_code` | Meaning |
|---|---|---|
| Two siblings from sequential relists of one parent | on exactly one side | same box |
| Two boxes each stickered at intake | each holds its own | distinct goods |

One box carries one sticker, so "both sides stickered" is a **proof** of
distinctness, not a heuristic.

**Changes:**
- `lot_lineage_chain(lot)` — ancestors + self + descendants, excluding collateral relatives. Contrast `lot_lineage_members(root)` = whole tree.
- `assign_lots_to_auction` — refuses the direct line unconditionally; refuses collateral relatives **only when either side lacks a sticker**.
- `lots_one_active_relist_child` re-keyed with `sticker_code IS NULL`. Relaxing the RPC alone still 23505'd on the second sibling. Strictly fewer rows than 0290's predicate (verified creatable on prod), so it cannot fail to build.
- `duplicate_lot_audit()` — `same_root_active` now fires only on direct-line or unstickered conflicts, so it stays a meaningful release gate; legitimate quantity>1 units report as the new `same_root_distinct_units` instead of vanishing.

**Strict relaxation of 0288** — nothing 0288 permitted is now refused. Cannot
re-open the hole 0290 closed: those phantoms were direct-line, and
`sold_and_collected_still_live` keys on a shared parent, so it still covers the
collateral case regardless of stickers.

### Error surfacing

`lot_item_already_listed` was **missing from the builder's error map**
(`auctions/[id]/builder/actions.ts`), so it fell through to a bare
`'Assignment failed'`. The raise carries both lot codes; they never reached the
screen. And because the RPC is **one transaction**, a single rejected lot aborts
the **entire** selection — select 40, one conflicts, nothing is added. The
message now says nothing was added and names the pair.

---

## Verification actually performed

Installed pgvector (`apt-get install postgresql-16-pgvector`) and replicated the
CI `schema migrations` job locally — all 294 migrations on real pg16, then
`packages/db/test/lineage_assign_guard.sql` (new, wired into `ci.yml`):

| Assertion | Result |
|---|---|
| Two stickered siblings both list | pass — this was the regression |
| Unstickered relist twin refused | pass — `lot_item_already_listed:GT-B2:GT-B1` |
| Parent of a live child refused **though both stickered** | pass — `lot_item_already_listed:GT-C1:GT-C2` |
| Index blocks two active unstickered children | pass |
| Audit: `same_root_active=0`, `same_root_distinct_units=1` | pass |

**Control:** reverting `assign_lots_to_auction` + the index to their 0288/0290
definitions makes the sibling assertion fail with exactly Jared's error — the
test catches the regression rather than passing trivially. Re-run it that way if
you touch the guard again.

Also green: `resolve_category_ids_batch`, `cron_functions_smoke`,
`app_read_paths_smoke`, `tsc --noEmit`, `npm run lint` (26 pre-existing
warnings, none in touched files). CI on #219: all 6 checks green.

**Not verified:** the five prod pairs. Nothing applied to prod. Nothing deployed.

---

## Corrections to the 2026-07-28 handoff

| Claim | Reality |
|---|---|
| 0269/0272 set `relisted_from_lot_id`, linking identical manifest rows | **They never write that column.** Only the relist path does (0097/0099/0192/0200/0213/0285). 0269 dedupes on `import_row_id` and says the opposite: "Two real units come from two different import_rows (different tracking) and are unaffected." Where the sibling links come from is still unestablished. |
| Fix direction: match on shared `sticker_code`/`qr_token` | Both are globally unique — that check can never fire. The signal is which side *holds* a sticker, not a shared value. |
| PR #218 not merged; TestFlight builds suspect | **#218 is merged** — commit `17e4f65` on master. TestFlight is no longer suspect and the "re-dispatch EAS from master" step is unblocked. |

---

## ⚠️ Read before using a web session for prod work

This container has **two independent walls**, and the second means credentials
would not have helped:

| Route | Blocker |
|---|---|
| Supabase MCP | approval gate — `MCP error -32003: requires approval`, session non-interactive. Tried 7×. GitHub MCP works; Supabase and claude-code-remote do not. |
| curl / psql from the container | environment network policy **403s CONNECT** to `npwseclcxcatjhgjrtwe.supabase.co:443` **and** `api.supabase.com:443` (confirmed via `$HTTPS_PROXY/__agentproxy/status` → `connect_rejected`) |

Consequences: no prod SQL, no `send_later` (so no self-scheduled PR check-ins),
and 07-28 gotcha #6 (can't load a deployed page) is this same policy.

**Do prod verification from a local session.** `CLAUDE.md` already assumes it —
`.secrets/`, `scripts/inspect-*.mjs`, answerable MCP prompts, no egress proxy.
To make future web sessions useful, allowlist `*.supabase.co`,
`api.supabase.com`, and the deployed app domain in the environment's network
settings, and store a Supabase token as an environment secret rather than in
chat. Docs: https://code.claude.com/docs/en/claude-code-on-the-web

---

## Next actions, in order

1. Run the sticker query. Branch to `2/2` or `1/2` per the table above.
2. Merge #219 (currently **draft** — mark ready first). It is safe under either outcome.
3. Dispatch **`apply-migration.yml`** for 0294 — one at a time; the concurrency group keeps only the last pending run (07-28 gotcha #2).
4. Dispatch **`deploy-cloudflare.yml`** — merging ships nothing (gotcha #1). Consider adding a `push: master` trigger; that gap left broken report pages live for hours.
5. Re-run `SELECT * FROM duplicate_lot_audit()` on prod and confirm `same_root_active`, `sold_and_collected_still_live`, `stale_cancel_stamp`, `ghost_parent_on_auction` are all 0 rows. Expect `same_root_distinct_units` to be non-empty if `2/2`.
6. Have Jared retry the five pairs and report back.

---

## Known-real, deliberately not done

- **`relist_lot_into_auction` D1 (0285) still keys on `canceled_at`, not `status`.** 0290 fixed that for the index but not for D1, so a source whose child was `won`-then-refunded still cannot be re-listed — the "too strong" half 0290 documented. Real, pre-existing, separate change; left out to keep 0294's blast radius small.
- **Duplicate Lot Button** — not started. Likely the actual fix for Jared if the query returns `1/2`. Design it alongside the guard, not after.
- Everything in 07-28's 🟡/🟢 sections: Square location ID for Dodge City (**every KS sale still books to Arkansas**), KS tax rate 9 vs 10, KS registration, staff warehouse enforcement (a PIN still works at any location), global web warehouse context, marketing campaigns (disabled — needs explicit owner go-ahead), Twilio SMS (no Worker credentials; 2 of 627 opted in), **mig 0273 recovery** (live on prod, absent from repo — recoverable via `pg_get_functiondef`; 0274/0276 also still missing), portal copy.
- Jared's `IMG_7632` / `IMG_7633` were never sent — ask again.
- Owner still has "a ton of patch notes" to send.

---

## Also in PR #219 — preflight guards were rotten (separate from the P0)

`npm run preflight` **failed on a clean checkout.** Relevant because the EAS
re-dispatch is now unblocked and preflight is meant to gate it.

Three rules still enforced field-mobile's 2026-05-20 expo-updates removal.
`app.config.ts` (~L190) records that decision **reversed on 2026-05-25** — the
iOS 26 launch crash was react-native-screens 4.16 + Sentry
`CPPExceptionTerminate` masking, not expo-updates. OTA is restored,
`expo-updates ~29.0.17` is a declared dep on the same pin bidder-app runs, and
`lib/crash-reporter.ts` legitimately reads `Updates.updateId`. The guards
contradicted the shipping config for two months.

- Static rule **repointed** at the invariant that is still live:
  `disableAntiBrickingMeasures: true` (the v16/20/21/22 death-loop cause).
  Control-tested — forcing `true` fails, `false` passes. Not a dead check.
- Two `preflight-deps.mjs` rules removed. The `SDK54_PINS` expo-updates entry
  stays; validating the pin is the useful part.
- **`npm run preflight` now runs in CI** (typecheck job, ~2s). Nothing ran it
  before, which is exactly why it rotted.
- **`.nvmrc` raised `20.10.0` → `20.19.4`.** It sat below `engines`
  (`>=20.19.4`), so `nvm use` produced a version the repo rejects. CI uses
  node 20.

Full local run after the fix: preflight PASS (0/0 both halves), turbo typecheck
12/12, lint 11/11 (0 errors), test 12/12 (217 operator-web tests).

## Org settings.json — what it can and cannot fix

**Read this before editing org settings.** The two walls above have *different*
causes and only one of them is a settings problem.

| Wall | Fixed by settings.json? |
|---|---|
| MCP `-32003: requires approval` | **Yes** — `permissions.allow` |
| Network `403 CONNECT` to `*.supabase.co` | **No.** That is the *environment's* network policy in Claude Code on the web, configured per-environment when the environment is created. No settings.json key controls it. |

So allowlisting tools alone will **not** give a web session prod SQL. Both need
doing, in different places.

### Permission rules

MCP tools are named `mcp__<server>__<tool>`, and a bare tool name in
`permissions.allow` allows all uses of it:

```jsonc
{
  "permissions": {
    "allow": [
      // MCP — exact tool names. Verify the SERVER segment (see caveat below).
      "mcp__supabase__execute_sql",
      "mcp__supabase__list_tables",
      "mcp__supabase__list_migrations",
      "mcp__supabase__get_advisors",

      // Read-only shell this repo actually uses
      "Bash(git status *)",
      "Bash(git log *)",
      "Bash(git diff *)",
      "Bash(git fetch *)",
      "Bash(npm run typecheck *)",
      "Bash(npm run lint *)",
      "Bash(npm run test *)",
      "Bash(npm run preflight *)",
      "Bash(npm ci *)"
    ],
    "deny": [
      // Keep the destructive paths prompting even under a broad allowlist
      "Bash(rm -rf *)",
      "Bash(git push --force *)"
    ]
  }
}
```

⚠️ **Caveat on the server segment, verified in this session:** claude.ai
*connectors* are proxied under their connector UUID, not a friendly name. Here
the Supabase server appeared as `5f1b3fbc-490c-4c5b-bac8-0e3d167d5566`, so a
rule written as `mcp__supabase__execute_sql` would **not** have matched. A
server added locally with `claude mcp add supabase` *is* named `supabase` and
would match. Before trusting a rule in a remote/web session, confirm the actual
server segment. I did not get to test whether a `mcp__<server>__*` wildcard is
honoured — treat that as unverified.

### Keys worth knowing (from the settings schema)

| Key | Use |
|---|---|
| `permissions.allow` / `deny` / `ask` | The allowlist above. `deny` wins. |
| `permissions.defaultMode` | `"dontAsk"` or `"bypassPermissions"` stops prompting wholesale. **Don't set this org-wide** — it applies to every repo and every tool. Prefer the explicit allowlist. |
| `allowedMcpServers` | Enterprise allowlist of *which servers may be configured at all*. If it is set and Supabase is absent, no permission rule will help. Check this first if allowlisting appears to do nothing. |
| `deniedMcpServers` | Takes precedence over the allowlist. |
| `allowManagedPermissionRulesOnly` | If true in managed settings, user/project/local rules are **ignored**. Would silently void anything added in the repo. |
| `env` | Where a Supabase token belongs — never pasted into chat. |

**Recommendation:** put the MCP allowlist at org level (it is the thing that
actually unblocks remote sessions), keep the bash allowlist in the repo's
`.claude/settings.json` so it stays scoped and reviewable in git, and leave
`defaultMode` alone. Note this repo currently has **no** `.claude/` settings
files at all, so anything added there is new.

## Setting up this laptop

Repo is `jmacluer-design/bingo-auctions`; `CLAUDE.md` hardcodes
`C:\Users\jmacl\Projects\auction-platform`, so clone into that path to keep its
rules accurate:

```powershell
cd C:\Users\jmacl\Projects
git clone https://github.com/jmacluer-design/bingo-auctions.git auction-platform
cd auction-platform; git checkout claude/new-session-h7v29d; npm install
```

Node 20 LTS (>=20.19.4). `.secrets/` is gitignored and was never in the repo —
nothing in it is needed for the P0; Supabase creds come from the dashboard. For
prod SQL from a local Claude Code session, `claude mcp add supabase` with a
Supabase personal access token; approval prompts work there because the session
is interactive. Docker/local Supabase is only needed to run the apps, and
Cloudflare Worker **deploys** need WSL2 (Windows native FS throws EPERM on the
Next.js copyfile step).

## Files touched

| File | What |
|---|---|
| `packages/db/migrations/0294_lineage_guard_direct_line_only.sql` | new — the guard, index re-key, audit split |
| `packages/db/test/lineage_assign_guard.sql` | new — both-direction regression test |
| `.github/workflows/ci.yml` | runs the test in the `schema migrations` job |
| `apps/operator-web/src/app/(operator)/auctions/[id]/builder/actions.ts` | surface `lot_item_already_listed` |
| `scripts/diagnose-lineage-duplicates.sql` | new — read-only prod diagnostic |
| `scripts/preflight-static.mjs` | stale expo-updates rule → live anti-bricking rule |
| `scripts/preflight-deps.mjs` | dropped two stale expo-updates rules |
| `.nvmrc` | `20.10.0` → `20.19.4` (was below the `engines` floor) |
