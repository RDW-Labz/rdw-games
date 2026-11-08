# BinGo Auctions

BinGo Auctions runs online auctions and warehouse pickup at
[https://bingoauctions.com](https://bingoauctions.com). Bidders browse lots,
place bids, pay through Square, and collect purchases. Staff import and lot
inventory, run auctions, and manage pickup.

Private, closed-source repository. Legal entity wording is maintained in
`legal/`; branding cleanup does not change those agreements.

## Three apps

- **`apps/operator-web`** — Next.js storefront and staff console, served by
  the Cloudflare Worker `bingo-web` at bingoauctions.com.
- **`apps/bidder-app`** — Expo / React Native app for bidders on iOS and Android.
- **`apps/field-mobile`** — Expo / React Native app for warehouse staff,
  including intake, inventory, and native ARKit mapping.

`apps/cron-trigger` is supporting infrastructure: the `bingo-cron` Worker
calls scheduled routes on operator-web. It is not a fourth user app.

## Stack and repo layout

- TypeScript, npm workspaces, and Turborepo.
- Next.js 16 / React 19, deployed through OpenNext to Cloudflare Workers.
- Expo SDK 54 / React Native 0.81 for mobile.
- Supabase Postgres, Auth, Storage, Realtime, and row-level security.
  PostgreSQL `pg_cron` handles auction lifecycle work; external API jobs run
  through Worker routes.
- Square for card vaulting, charges, refunds, and webhooks.
- Cloudflare R2 for assets; Resend / Twilio / Expo for notifications.

Shared code lives under `packages/`: `shared`, `design-system`,
`supabase-client`, `domain-bidding`, `domain-fulfillment`, `domain-lotting`,
`scan-extract`, and `image-enrichment`. Database schema history and tests live
in `packages/db/`. Local Supabase configuration is in `supabase/`.
`legal/` contains the legal source documents; `scripts/` and
`.github/workflows/` contain tooling and CI.

## Run locally (Mac / zsh)

Use the Node version pinned in `.nvmrc` and npm 10+. Docker and the Supabase
CLI are needed for local database services; Xcode / Android Studio are needed
for the corresponding mobile simulators. The staff app's custom native
modules require an existing compatible development build.

From this checkout:

```zsh
npm ci
cp -n apps/operator-web/.env.example apps/operator-web/.env.local
cp -n apps/bidder-app/.env.example apps/bidder-app/.env.local
cp -n apps/field-mobile/.env.example apps/field-mobile/.env.local
```

Do not overwrite an existing local env file. Configure each app using its
example, pointing Supabase URLs/keys at your local stack and using only Square
sandbox credentials. Never copy production service-role or Square tokens into
local development. Env files stay gitignored; do not paste their values.

Start local services from the repo root:

```zsh
npx supabase start
```

This starts local services; it does **not** replay this repo's schema chain.
Use an already prepared local database. Fresh schema setup needs a separately
reviewed local-only procedure: migrations are in `packages/db/migrations/`,
not `supabase/migrations/`. **Do not run `npm run db:reset` or
`supabase db reset`**: they wipe the local database without applying the real
migration chain. `scripts/ci/apply-migrations-scratch.sh` is only for disposable
CI databases; its auth stubs make it unsuitable for local app development.
No schema setup or database writes are authorized during cleanup Phase 1.

In separate terminals:

```zsh
# Website and staff console, normally http://localhost:3000
npm run dev --workspace=@auction-platform/operator-web

# Bidder Metro server
npm run start --workspace=@auction-platform/bidder-app -- --port 8081

# Staff Metro server (existing compatible native development client)
npm run start --workspace=@auction-platform/field-mobile -- --port 8082
```

Phase 1 does not build or publish apps. Do not change native IDs, EAS
projects/channels, runtime versions, or `modules/clovrbid-arkit` for branding.

## Checks and PR flow

```zsh
npm run typecheck
npm run lint
npm test
npm test --workspace=@auction-platform/db
npm run preflight
```

[CI](.github/workflows/ci.yml) also runs source/schedule guards and SQL schema
tests on a disposable PostgreSQL service. Its migration replay and test
fixtures are isolated test setup; never point those jobs at hosted data.
Default DB package tests include opt-in integration suites that remain skipped
without their local-only flags. A green smoke suite is not production proof.

Read [WORKING_AGREEMENT.md](WORKING_AGREEMENT.md), especially §7c, and
[CLAUDE.md](CLAUDE.md). Start each cleanup step from fetched `origin/master` on
`braden/cleanup-<step>`, with one draft PR per step. Paste the impact review,
keep/delete evidence, checks, and rollback plan in the PR. No stacked PRs.
Keep it draft until Braden explicitly says "merge"; then run:

```zsh
gh pr checks N && gh pr merge N --squash --delete-branch
```

Fill in the squash SHA after merge. Start the next step only after fetching
the newly merged master. BinGo production code uses authorized subscription
coding tools; do not route it through OpenRouter.

## Deploy flow

Merging is not proof of deployment. Docs-only and scripts-only PRs do not
deploy. During cleanup Phase 1, no migrations, production scripts, OTA updates,
or app builds run. Mobile source edits wait for the next normal app release.

Changes to operator-web or cron-trigger use the manual
[deploy-cloudflare.yml](.github/workflows/deploy-cloudflare.yml) workflow,
**09:00–16:00 America/Chicago only**. Deploy the approved merged master and
skip the Worker that did not change:

```zsh
# operator-web changed; skip bingo-cron
gh workflow run deploy-cloudflare.yml --ref master -f skip_cron_trigger=true

# cron-trigger changed; skip bingo-web
gh workflow run deploy-cloudflare.yml --ref master -f skip_operator_web=true
```

If both changed, skip neither. Track the resulting run and require success.
Then run [post-deploy-check.yml](.github/workflows/post-deploy-check.yml):

```zsh
gh workflow run post-deploy-check.yml --ref master
# Use the resulting run's ID:
gh run watch RUN_ID --exit-status
curl --fail https://bingoauctions.com/api/version
```

Require a green check. The version must match the new website build's full
commit SHA. For a cron-only deploy, verify that bingo-web still reports its
recorded build and that the deploy run confirms bingo-cron changed. Follow
CLAUDE.md Rule 9 for broader release windows; Phase 1's limits above govern
this cleanup.

## Rollback flow

The [2026-11-02 rollback baseline](docs/state/CLEANUP-ROLLBACK-2026-11-02.md)
records the starting master, live website build, remote pre-cleanup tag, last
green deployment, and green pre-cleanup production check.

1. Stop at the first failure. For a cleanup-caused website failure, use
   Cloudflare > Workers > bingo-web > Deployments to roll back to the recorded
   deployment immediately, or `gh run rerun 41112745265` (about six minutes).
   Rerunning that run can deploy both Workers; use the instant website rollback
   when only bingo-web needs recovery.
2. Run `post-deploy-check.yml` and require green.
3. Create `braden/revert-cleanup-<step>` from current origin/master, run
   `git revert <squash SHA>`, open a draft PR, and wait for Braden's "merge".
4. For a broken workflow with no live impact, use the revert PR. Undo multiple
   cleanup PRs newest first. Restore the entire tree from
   `pre-cleanup-2026-11-02` only if no other PRs merged since that tag.
5. If an app update is ever involved, republish the previous update group.
   Never roll Android back to its built-in version.

Every PR's Rollback section records its squash SHA (filled after merge),
revert command, redeploy yes/no, and verification. A baseline failure is
pre-existing; do not attribute it to cleanup or revert unrelated work.

## Doc index

- [Working agreement and impact review](WORKING_AGREEMENT.md).
- [Mac / zsh agent rules and Rule 9 windows](CLAUDE.md).
- [Cleanup rollback baseline](docs/state/CLEANUP-ROLLBACK-2026-11-02.md).
- [Change preflight and physical-impact safeguards](docs/PREFLIGHT.md).
- [Newest owner handoff](docs/state/HANDOFF-2026-09-30.md) and
  [previous handoff](docs/state/HANDOFF-2026-09-29.md).
- [Database transport/schema testing](docs/testing/real-schema-in-ci.md).
- [Legal source documents](legal/README.md).
- [CI](.github/workflows/ci.yml), [deploy](.github/workflows/deploy-cloudflare.yml),
  and [production check](.github/workflows/post-deploy-check.yml) definitions.

All of `docs/state/` is retained as dated history. Older app/package READMEs,
runbooks, launch reports, and STATUS.md may describe previous branding,
processors, or deployment states; verify against current code and live runs.
Deleted historical docs remain available in Git history and under the
`pre-cleanup-2026-11-02` tag. Historical links into those deleted docs can be
resolved from that tag; they are not current operational instructions.
