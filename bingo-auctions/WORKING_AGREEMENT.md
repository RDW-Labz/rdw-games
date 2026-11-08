# Working Agreement — BinGo Auctions

**Who this is for:** Braden (runs BinGo and decides), Jared (business scope; signs off on anything that changes floor or business process), Darren (CTO/infra).
**Handover, 2026-09-30:** Michael handed BinGo over to Braden and Jared. He no longer confirms migration numbers or signs off on phases. Braden decides; Jared signs off on floor/business-process changes.
**Repo:** `jmacluer-design/bingo-auctions` — private, closed-source, proprietary to GOLD RUN LLC.
**Status:** Live production. `bingoauctions.com` serves real customers, auctions, and payments through Square.

---

## 0. The one-line version

This is a production system handling live payments. Nothing I do should be capable of affecting a real customer, a real bid, or a real dollar until someone with ownership has reviewed it.

---

## 1. Git — branch and push discipline

**Never commit or push to `master`.** All work happens on a branch.

| Rule | Detail |
|---|---|
| Branch naming | `braden/<short-description>` — e.g. `braden/watch-list-outcomes` |
| Branch from | Whatever base branch Braden specifies; `master` by default |
| One branch per scope item | `WATCH-01` and `LOC-01` are separate branches and separate PRs |
| Never force-push | No `git push --force` on any branch that isn't exclusively mine. Use `--force-with-lease` if genuinely required on my own branch |
| Never rebase shared history | No rewriting commits that exist on the remote and that others may have pulled |
| Never delete unrelated remote branches | Delete only the approved PR's branch through Braden's authorized merge command |
| Merge gate — PR checks green | Required PR checks must pass first. PRs must never run with production keys. |
| Merge gate — PR smoke only | A PR runs only the credential-free GET smoke (no checkout, no secrets, no production writes). |
| Merge gate — full E2E on `master` | Full E2E runs on `master` after every merge, against the deployed build. The PR smoke does not replace it. |
| Merge gate — master E2E or post-deploy-check red | Revert first, investigate second. The bot merges the revert itself; no owner instruction is needed. Confirm the revert is deployed and `post-deploy-check.yml` is green, then investigate. |

**Merge gate — RED TEAM reviews code only.** RED TEAM must not FAIL or BLOCK a PR over how an owner yes was posted.

RED TEAM reviews code only. Owner approvals are out of scope. The ship gate checks those, including approvals relayed by Chief of Staff or posted through an app. Never FAIL or BLOCK a PR over how Braden's yes was posted.

Keep cleanup PRs draft. For PR number N, run:

```zsh
gh pr checks N && gh pr merge N --squash --delete-branch
```

One PR at a time; no stacked cleanup PRs. Fill in its rollback squash SHA after merge, then fetch master before starting the next step. Merging does not itself deploy operator-web; deployment is a separate manual workflow.

**Full E2E is a post-merge gate, not a PR gate.** A PR runs only the credential-free GET smoke (no checkout, no secrets, no production writes). Full E2E runs on `master` after every merge (`master` push, `master` workflow_dispatch, or a successful same-repository `workflow_run` from `master`). If master E2E or `post-deploy-check.yml` fails, revert first; the bot merges the revert itself (no owner instruction needed). Confirm the revert is deployed before investigating. Changing when E2E runs needs Braden's explicit OK; do not add or remove path filters, conditions or event triggers on your own.

**Before every push, run:**
```
git status          # nothing unexpected staged
git diff --staged   # read what I'm actually sending
git branch --show-current   # confirm not on master
```

**Commit hygiene:** small, focused commits. No "fix stuff" messages. No commits that bundle a feature change with formatting churn — reviewers can't separate them.

---

## 2. Secrets — hard rules

- **Never commit any `.env*` file.** Verify `.gitignore` covers it before the first commit, and re-verify after adding any new env file.
- **Never paste real keys into chat, Slack, email, issues, PR descriptions, or commit messages.** Secrets move through 1Password only.
- **Payments are Square, not Stripe.** The live secret is `SQUARE_ACCESS_TOKEN`. Stripe is dead code; `lib/stripe.ts` no longer exists. Every doc claiming Stripe Connect is stale.
- **Never put a live `SQUARE_ACCESS_TOKEN` in a local environment.** Sandbox credentials only. If no sandbox set exists, that is a blocker to raise, not a thing to work around.
- **The Square token is account-wide and can charge any of 25 Square locations.** Only a pinned `location_id` keeps auction money on the BinGo account. Any charge path that omits the location books real revenue to the wrong business. Treat `resolveSquareLocationId()` as safety-critical.
- If a secret is ever exposed: say so immediately. Rotation is cheap; a quiet leak is not.

---

## 3. Production — what I do not touch

Treat the following as requiring explicit, per-instance approval from Braden (Darren for infrastructure). Not standing permission.

**Never run without approval:**
- `bash scripts/deploy-cf.sh` — deploys the live operator console
- `wrangler deploy`, `wrangler secret put` — touches the live Worker
- `eas build`, `eas update`, `eas channel:*` — ships to real TestFlight/Play Store users
- `npm run db:push` — applies migrations to the **hosted** database
- `scripts/push-hosted-migrations.js` — same
- `node scripts/apply-migrations.js` — the authoritative applier for every migration
- Anything using `SUPABASE_SERVICE_ROLE_KEY` against a hosted URL — this key bypasses RLS entirely
- Any Square dashboard action in live mode

**Safe by default:**
- `supabase start` — local Docker database only (but see §4: `db:reset` is **not** safe on this repo)
- `npm run dev -w @auction-platform/operator-web` — local server
- `npm run test`, `npm run lint`, `npm run typecheck`, `npm run preflight`
- Explicitly authorized read-only application APIs or reviewed workflows; no raw SQL against prod

**One prod change at a time.** Run `post-deploy-check.yml` after each and require green before the next. If that production change fails, roll back first, investigate second; stop and report. Cleanup Phase 1 forbids migrations, DB writes, production scripts, OTA, and app builds. Docs-only and scripts-only PRs do not deploy; operator-web/cron-trigger deployments use `deploy-cloudflare.yml` during 09:00–16:00 CT, skip the unchanged Worker, and require post-deploy-check plus `/api/version` verification.

**Rule of thumb:** if a command's effect is visible to someone who isn't me, it needs approval first.

---

## 4. Database and migrations

- Develop against **local Supabase**, never the hosted instance.
- **Never run `npm run db:reset` or `supabase db reset` on this repo.** It applies zero migrations and wipes the local database. The Supabase CLI only reads `supabase/migrations/`, which doesn't exist here; the real migrations are in `packages/db/migrations/`. Confirmed firsthand.
- **Never run `scripts/ci/apply-migrations-scratch.sh` locally.** It stubs `auth.uid()` to return null, which makes every RLS policy deny.
- **Never edit an existing migration file.** Far more exist than the 126 the docs claim, and the numbering has gaps, so file count never equals highest number. **Do not trust any number written here** — as of Sept 14 it was 347 files with 0355 the highest, and both went stale within hours of being written. Check `ls packages/db/migrations | tail -1` and **have Braden approve the next number before writing one**; 0354 and 0355 were both claimed within days of each other. Approved on 2026-09-30: **0382** (stranded drafts), **0383** and **0384** (keep a sold lot, Phase 2).
- New migrations are idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`) and numbered in apply order: `NNNN_description.sql`.
- **Never bypass RLS in application code.** If a policy makes something hard to express, the policy gets fixed — that's the architecture, not an obstacle.
- Money is always integer cents (`BIGINT` in SQL, `number` in TS). Use the helpers in `packages/shared/src/money.ts`. Never introduce a float into a money path.
- `place_bid` is the only writer to `bids`. Direct inserts are blocked by policy and should stay that way.
- Coordinate before adding a migration — if someone else has a pending number, two people numbering independently will collide.

---

## 5. Dependencies and tooling

- **Do not run `npm audit fix`,** especially not `--force`. The 73 reported vulnerabilities are mostly transitive dev dependencies; auto-fixing across a monorepo with pinned React 19 overrides will break things. If security patching is wanted, it's a separate scoped task.
- **Do not change `.nvmrc`,** even though Wrangler/miniflare warn they want Node ≥22 and it's pinned at 20.19.4. That contradiction is real and worth raising, but changing it affects CI and everyone else's builds.
- **Do not add dependencies casually.** Ask first. Every addition is something the team maintains forever.
- **Do not reformat files I'm not otherwise changing.** Prettier runs on the repo; a whole-file reformat buries the actual diff.
- Lockfile changes should only appear in a PR that intentionally changes dependencies.

---

## 6. AI agent usage (Cursor / Claude Code)

Agents are useful here but this codebase has conventions that an agent won't infer from the code alone.

- **Read `CLAUDE.md` myself before pointing an agent at anything.** It's 13KB of project-specific rules and it exists precisely so agents and humans behave consistently.
- **Disable auto-run / auto-apply.** Every command and every edit gets reviewed before it executes. An agent that runs `npm run db:push` or `wrangler deploy` because it seemed like the next logical step is the exact failure mode this document exists to prevent.
- **Never let an agent operate on `master`.**
- **Review agent output as if a stranger wrote it.** Agent code that violates RLS-first, uses floats for money, or writes directly to `bids` will look completely plausible.
- Agents don't get secrets. Don't paste env contents into a prompt.

---

## 7. Definition of done (from Jared's scope)

The scope sets a hard bar: **a feature is not complete until tested and confirmed on every applicable platform** — PC browser, mobile browser, Android, and iOS. Any addition, removal, correction, or upgrade applies to all four unless the scope names an exception.

For each completed item, report:
1. Which platforms were tested
2. The test result
3. Any known limitation

Regression check on every release — the scope specifically calls out that fixes must not break the referral program, bidding, checkout, pickup, or account access. `REF-01` is explicit: the referral program works, don't redesign it, just don't break it.

---

## 7b. Timing — Rule 9

Follow [CLAUDE.md Rule 9](CLAUDE.md#rule-9--change-windows-staff-customers-and-the-database-each-have-one): staff-only changes after 18:00 CT; customer changes 09:00–16:00 CT; database lock work 05:00–07:00 CT. Merging and deploying are separate actions. Cleanup Phase 1's stricter limits in §3 and the owner's current instructions take precedence: no mobile publishing or migrations; website/cron deploys 09:00–16:00 CT only.

## 7c. Impact review — required before every PR

Braden's condition for merging any PR. Run this before opening one:

> Trace everything that touches what I changed:
> - Other callers of any function or query I modified
> - Other surfaces rendering the same data (web, iOS, Android, staff)
> - Database objects that depend on it — views, triggers, RPCs, RLS policies, cron jobs
> - Tests covering the changed path, and tests that should but don't
> - Anything reading the same column or table that might now behave differently
>
> Then: what could break upstream, what could break downstream, and what needs manual verification that automated tests won't catch.

**Test the negative case.** A regression guard that passes against the bug it's meant to catch is worse than no guard. Reintroduce the bug deliberately and confirm the test fails before trusting it.

**Destructive migrations must review physical impact.** For any deletion, soft deletion, reassignment or removal of an existing identity, complete [docs/PREFLIGHT.md](docs/PREFLIGHT.md). Explicitly ask whether a person has its sticker/label, whether it has a shelf/bin history, whether staff are acting on it now, and what stops working for that person. Passing financial/data checks alone does not establish that removal is safe. The reusable physical-footprint guard is planned separately; do not claim it is already enforced.

## 8. Who to ask

| Topic | Person |
|---|---|
| Business rules, priorities, scope interpretation | Jared |
| Infrastructure, Cloudflare, secrets, deploys | Darren |
| Ownership, architecture decisions, merges, migration numbers, phase sign-off | Braden |
| Anything that changes floor or business process (sign-off) | Jared |
| Legal entity questions (GOLD RUN LLC) | Michael, unless Braden says otherwise |

The scope's own first delivery instruction is to **review it with management and identify business-rule questions before development begins.** Ambiguity gets resolved before code, not after.

---

## 9. Open questions to resolve before writing code

These are contradictions found between the scope, the README, and the actual repo. Each needs an answer.

1. ~~Square vs Stripe.~~ **ANSWERED:** Square is the entire payment stack (`lib/square.ts`). Stripe is removed. All docs saying otherwise are stale.
2. **Points-per-dollar rule.** `LOY-01` says to confirm the exact earning rule with management before implementation. Unanswered.
2b. **Is OTA actually working?** Migration 0350's header says OTA updates are not reaching either mobile platform. That breaks the scope's "tested on all four platforms" bar. Ask Darren.
3. **Android status.** The scope describes current Android app behavior as if it's in customers' hands. The README says Android isn't built yet (task #57, blocked on Play Console) while also listing Play Store as a deployment target. Which is true?
4. **Location model.** The scope treats locations as cities (Harrison, Dodge City). The codebase is multi-tenant with `operator_id` and warehouses. Is a "location" a warehouse, an operator, or a new concept?
5. **Brand naming — answered.** BinGo Auctions is the customer-facing brand at `bingoauctions.com`. Preserve legacy technical identifiers for compatibility and leave legal entity wording unchanged.
6. **Public sales history removal** (`WEB-02`) deletes data customers currently see. Confirm it's a UI removal, not a data deletion, and that reporting still needs those figures internally.
7. **Base branch and current state.** 50 branches; `master` had a failing CI check. Which branch do I build from?
8. **Stale docs.** `docs/state/STATUS.md` is dated 2026-05-23, roughly four months old. `README.md` references `infra/` (actual: `supabase/`) and a Redis/BullMQ auction engine (actual: pg_cron). How much else has drifted?

---

## 10. Escalation

If something looks like it may have affected production — a wrong branch pushed, a command run against a hosted URL, a key committed — **stop and tell Braden and Darren immediately, and Jared if the floor is affected.** Don't attempt a quiet fix. Recovery is far easier before someone else pulls, deploys, or builds on top of it.
