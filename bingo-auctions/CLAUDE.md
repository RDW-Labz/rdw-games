# CLAUDE.md — BinGo Auctions session rules

BinGo is live production at https://bingoauctions.com. Braden owns decisions
and merges; Jared signs off on floor/business-process changes; Darren handles
infrastructure. Read WORKING_AGREEMENT.md and docs/PREFLIGHT.md before work.
The owner's current task instructions take precedence over historical docs.

## Hard rules

### Rule 1 — Verify before theorizing

Read the file, inspect the API response, or run an authorized read-only check
before naming a root cause. Never use a production write as a diagnostic.
No raw SQL against prod: do not submit ad hoc SQL, including SELECT, directly
to production. Use explicitly authorized application APIs or reviewed
read-only workflows; cleanup Phase 1 does not authorize production scripts.

### Rule 2 — Mac / zsh and safe credentials

Work from the actual checkout on macOS with zsh. Use `pwd` and
`git status --short` before work; do not assume another machine's paths.
Use `rg` to find code and filenames. Check the relevant app's `.env.example`
and gitignored local configuration before asking for missing setup.
Never print secret values, search personal Downloads for credentials, or put
keys/customer data into prompts, logs, fixtures, commits, or PRs. Secrets move
through 1Password. Local payments use Square sandbox credentials only.
Never put a live Square token in a local environment.
Never put customer names or emails in code (including comments), commits, or PRs.

### Rule 5 — Square payments

Square handles card vaulting, charges, refunds, and webhooks. Start with
`apps/operator-web/src/lib/square.ts` and
`apps/operator-web/src/app/api/square/webhook/route.ts`.
`resolveSquareLocationId()` is safety-critical: the Square token is
account-wide, so every charge must remain pinned to BinGo's location.
Do not change payment behavior as part of cleanup. Historical payment-named
database objects and migration files are compatibility contracts, not deletion
candidates. Money stays integer cents; preserve RLS and the `place_bid` RPC.

### Rule 6 — Scope and agent usage

Follow Braden's usage rule. BinGo production code stays on authorized
subscription coding tools; do not send it to OpenRouter. Never send secrets or
customer data to an agent. If parallel writers are explicitly requested, give
them isolated worktrees and bounded file ownership; review the integrated diff.

### Rule 7 — Review, tests, and merges

Use `braden/<scope>` branches from fetched `origin/master`. Never commit or
push to master, force-push shared history, or bundle unrelated work.
Before every push, inspect `git status`, `git diff --staged`, and
`git branch --show-current`. Do not blanket-stage a shared checkout.

Complete WORKING_AGREEMENT §7c and paste the impact review in every PR:
callers, other surfaces, database dependencies, tests, shared readers,
upstream/downstream risks, and manual verification. Complete the three passes
in docs/PREFLIGHT.md. Test the negative case for a behavioral regression guard.
Do not invent a mutation test for a docs-only change.

Require typecheck, lint, unit tests, and DB tests to be green. Do not bypass
failing checks. Do not use admin merges. Open one draft PR per cleanup step,
with a keep/delete list and rollback section. No stacked PRs; wait for the
current PR to merge before starting the next from updated origin/master.

Only after Braden explicitly says "merge", run:

```zsh
gh pr checks N && gh pr merge N --squash --delete-branch
```

Replace N with the approved PR number. Fill its rollback section with the
resulting squash SHA after merge. Never infer merge approval from green CI.

One prod change at a time. Run `post-deploy-check.yml` after each and require
green before the next change. If that production change fails, roll back
first, investigate second; stop and report the failure.

### Rule 9 — Change windows: staff, customers, and the database each have one

BinGo is a live warehouse **and** a live auction site. Staff lot, put away and
check customers out at a counter all day; customers bid hardest in the evening,
and their cards are charged as auctions close. A prod change that misbehaves
does not produce a ticket — it produces a queue at the counter, or bids and
charges failing at the busiest hour.

There is no single "after close" window that is safe for everything: 18:00 is
when the warehouse empties **and** when customer traffic peaks. So the window
depends on who the change can reach.

**When traffic actually happens** (prod, 28 days to 2026-09-24, per-day
averages by hour, Central):

| Hours | Bids | Counter pickups | Card charges | Lots created |
|---|---|---|---|---|
| 05:00–07:00 | ~20/hr | 0 | ~0 | 0 |
| 07:00–10:00 | 40–55/hr | 0–2/hr | ~0 | 16–58/hr |
| 10:00–18:00 | 50–140/hr | 4–19/hr (peak 17:00) | ~1/hr | 21–137/hr (peak 16:00) |
| **18:00–21:00** | **170–325/hr** (peak 18:00) | ~1/hr, 18:00 only | 3/hr at 18:00, then **~36/hr** | 0 |
| 21:00–22:00 | ~85/hr | 0 | **~27/hr** | 0 |
| 22:00–05:00 | 10–65/hr | 0 | ~0 | 0 |

**The windows:**

| Change reaches | Ship it | Avoid |
|---|---|---|
| **Staff only**: staff app OTA/build, staff-only screens and routes | After staff leave: **18:00 onward** (last pickups and lots are before 18:00) | 07:00–18:00, while someone is mid-task |
| **Customers**: bidder app OTA, storefront, bidding, checkout, charges | Mid-morning to mid-afternoon (**09:00–16:00**, ~15–35% of the peak bid rate) | **18:00–22:00**: peak bids, and card charges run until 22:00 |
| **Database locks**: index builds, table rewrites, anything taking SHARE or stronger on `lots`, `bids`, `invoices` | **05:00–07:00** (~20 bids/hr, no staff, no charges) | 18:00–22:00 always; 07:00–18:00 unless it is sub-second and approved |
| **Both staff and customers** (e.g. an operator-web deploy touching shared code) | 05:00–07:00, or 09:00–16:00 when no staff screen changes | 18:00–22:00 |

Always fine, any hour: explicitly authorized read-only application APIs or
reviewed workflows, local dry runs, branches, draft PRs, and local tests.
No raw SQL against prod. Cleanup Phase 1 forbids production scripts and OTA,
including canary publishing; the phase limits below take precedence.

Two notes that follow from how the apps update: an OTA reaches a phone only on
its next launches, so a staff OTA shipped at 18:00 lands at the next morning's
first launch, and it is the *launch* that must be safe, not the publish. And
every customer-facing OTA should have its rollback dry-run before it ships.

Measured with: bids by `placed_at`, pickups by `completed_at`, charges by
`invoices.paid_at`, lots by `created_at`; hour in America/Chicago, over the 28
days to 2026-09-24 (lots: 14 days). Re-measure if the auction close times move.

Origin: set by the owner on 2026-09-01 as "no prod changes before 6 PM", after
both apps hung mid-afternoon while migrations had been applied to prod earlier
the same day. The outage turned out to be the Cloudflare edge — the database
was idle, and the routes recovered on their own — but that is exactly the
point: **when something breaks during business hours, recent prod changes are
the first suspect, and hours go into clearing them instead of fixing the actual
problem.** Revised 2026-09-24 with the table above, because "after 6" had moved
customer-facing changes into the customer peak.

**This is a default, not a law** (owner, 2026-09-01: "that after 6 thing does
not have to be always"). In practice:

- **Just do it** when the blast radius is genuinely small and reversible — a
  new function nothing calls yet, an additive column, a fix to something
  already broken.
- **Use the window** when behaviour changes underneath someone mid-task — a
  guard that starts refusing an action staff use, a deploy that reshapes a
  screen they are working in, anything touching checkout, pickup, bidding or
  charges.
- **Fix it now, whatever the hour**, for an outage or a bug actively costing
  money. Say plainly that you are doing it and why.

When unsure which bucket a change is in, ask — it costs one sentence. What is
not acceptable is deciding alone that a risky change is fine because it is
convenient. "This one is small" is what every change looks like from the
inside.

## Cleanup Phase 1 — owner constraints (2026-11-02)

These phase-specific limits override broader historical shipping defaults:

- No migrations, DB writes, production scripts, OTA, or app builds. Mobile
  source edits merge but ship in the next normal app release.
- Docs-only and scripts-only PRs do not deploy.
- PRs touching `apps/operator-web` or `apps/cron-trigger` deploy using
  `deploy-cloudflare.yml`, 09:00–16:00 Central only. Skip the unchanged Worker.
  Then require `post-deploy-check.yml` green and verify `/api/version` against
  the deployed commit (a cron-only deploy does not change the web build ID).
- Preserve bundle IDs, store names, EAS projects/channels, runtimeVersion,
  Worker names/routes/secrets, `@auction-platform/*`, native
  `modules/clovrbid-arkit`, existing migrations, and database objects named
  `stripe_*` or `clovrbid*`. List GOLD RUN LLC legal pages; do not edit them.
- Preserve referral, bidding, checkout, pickup, and account-access behavior.
- Stop at the first failure and report. Roll back a cleanup-caused live
  failure first, then investigate. Do not roll back a pre-existing baseline
  failure as though cleanup caused it.

## Recovery and state

Start with [the cleanup rollback baseline](docs/state/CLEANUP-ROLLBACK-2026-11-02.md)
and [the README deploy/rollback flow](README.md#deploy-flow).
For a website failure, roll back bingo-web in Cloudflare Deployments to the
recorded build, or rerun the recorded green deploy. Require a green production
post-deploy check. Then create `braden/revert-cleanup-<step>`, revert the squash
commit, open a draft PR, and wait for Braden's merge instruction.
A broken workflow with no live impact only needs the revert PR. Undo multiple
cleanup PRs newest first; restore the whole tree from the pre-cleanup tag only
if no other PRs have merged since. If an app update is ever involved, republish
the previous update group; never roll Android back to its built-in version.

Read the newest relevant handoff in `docs/state/`; dates matter. Its old
STATUS.md and launch reports are historical snapshots, not current production
proof. Verify deployment state through GitHub runs and `/api/version`.
Never edit existing migration files: the production ledger checks their hashes.
Braden must approve the next migration number before any new migration is
written. Cleanup Phase 1 permits no migrations.
Never run `db:reset` / `supabase db reset`: the CLI migration directory does
not contain this repo's real migration chain. Never run the scratch CI applier
against a development or hosted database. Do not install dependencies casually
or use `npm audit fix`. Keep `.nvmrc` and lockfile unchanged unless in scope.
