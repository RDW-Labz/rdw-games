# BinGo cleanup rollback baseline — 2026-11-02

Recorded before Phase 1 step 1. No cleanup change has been deployed.

- Starting `origin/master`: `610afa055790494f8d01b681efd86761f3559c9e`.
- Remote rollback tag: `pre-cleanup-2026-11-02` (points to the starting master).
- Live build from `https://bingoauctions.com/api/version`: `17674159794e5c644cd6a19087a2d6e43638f210`.
- Last green `deploy-cloudflare.yml` run: [41112745265](https://github.com/jmacluer-design/bingo-auctions/actions/runs/41112745265), created 2026-10-30 19:08:20 UTC; commit `17674159794e5c644cd6a19087a2d6e43638f210`.
- Pre-cleanup `post-deploy-check.yml`: [41492272999](https://github.com/jmacluer-design/bingo-auctions/actions/runs/41492272999), **success**, dispatched 2026-11-02 17:33:24 UTC against starting master; check job passed in 17 seconds. Cleanup began only after this run was green.

## Roll back first

1. For a website failure, use Cloudflare > Workers > bingo-web > Deployments to roll back to the deployment for the live build above. Alternatively, rerun the recorded deploy: `gh run rerun 41112745265` (about six minutes). That workflow run can deploy both Workers; prefer the instant website rollback when only bingo-web is affected.
2. Run `gh workflow run post-deploy-check.yml --ref master`; require a green result.
3. Create `braden/revert-cleanup-<step>` from current `origin/master`, run `git revert <squash SHA>`, open a draft PR, and wait for Braden's explicit merge instruction.
4. A broken workflow with no live impact needs a revert PR; no production rollback is needed.
5. For full undo, revert cleanup PRs newest first. Restore the whole tree from the tag only if no other PRs have merged since the tag.
6. Stop the phase at the first failure and report it. Do not attribute a pre-existing baseline failure to cleanup.

## Per-PR rollback record

Each cleanup PR must record its squash SHA after merge, `git revert <squash SHA>`, whether redeploy is needed, and the checks to run. Docs-only and scripts-only PRs do not deploy. Website/cron deployments use `deploy-cloudflare.yml` only, 09:00–16:00 America/Chicago, skipping the unchanged Worker, followed by a green post-deploy check and live `/api/version` verification.

No migrations, database writes, production scripts, OTA updates, or app builds are part of this phase. Mobile source changes ship in the next normal app release. If an app update is ever involved in recovery, republish the previous update group; never roll Android back to its built-in version.
