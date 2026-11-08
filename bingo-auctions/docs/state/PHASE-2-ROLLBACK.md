# BinGo Phase 2 rollback baseline

Recorded 2026-11-02, approximately 15:36 Central, at owner request. The requested tag is named for 2026-11-03; the actual capture date is recorded here rather than inferred from the tag.

- Repository: RDW-Labz/bingo-auctions, GitHub repository ID 1279191152.
- Starting origin/master SHA and pushed tag `pre-phase2-2026-11-03`: `2eda81921ead495b2717f62e7b8029b8c50020c9`.
- Live `https://bingoauctions.com/api/version` build: `2eda81921ead495b2717f62e7b8029b8c50020c9`.
- Matching last green deploy-cloudflare.yml run: [41528236526](https://github.com/RDW-Labz/bingo-auctions/actions/runs/41528236526).
- Last verified matching post-deploy check: [41529143891](https://github.com/RDW-Labz/bingo-auctions/actions/runs/41529143891); post-deploy E2E [41529048273](https://github.com/RDW-Labz/bingo-auctions/actions/runs/41529048273) passed. These are baseline history, not a claim of a new Phase 2 deploy.

## Recovery

One production change at a time. After every deployment require matching version and post-deploy-check.yml green. If a live change fails, roll bingo-web back to the immediate prior recorded deployment first (or rerun its last green deploy workflow), run post-deploy-check.yml and require green, then investigate. Open braden/revert-phase2-<item>, revert the actual squash SHA, open a draft PR, and wait for owner merge. Each item records its own squash SHA, revert command, redeploy need and verification. Never blindly restore this whole tag if unrelated work merged since it. Do not roll Android back to its built-in version; republish the previous update group when an app update is involved.

## Folded Phase 2 work list

1. Repository transfer pointers and external integration checklist; no deploy.
2. CI lockdown: PR runs get no production service-role key and perform no production mutations; full E2E stays on master/deploy. Cloudflare workflow rejects non-master refs. This incorporates the sole deferred item from CLEANUP-PHASE-2.md: “E2E writes to prod and gets the service-role key on PR branches.”
3. Warehouse-correct Square payment search/pay-fees/loyalty location, sandbox tests; separate owner go and 09:00–16:00 deploy gate.
4. Square webhook event-id deduplication and exact-total validation/flagging; after item 3, same payment go/sandbox/window gates.
5. PIN worker effective-role gates and sensitive-action manager PIN/typed name/reason review; staff release after 18:00, Tim first, OTA only on owner go.
6. Offline lot/photo/save, put-away and stage queue, connectivity badge and idempotency; after item 5, show plan before building.
7. Read-only production routine reference capture, including place_bid and functions associated with 0337/0350/0351/0353/0392; no migrations or production writes.
8. One-command local setup using packages/db/migrations; README, authentic local auth/RLS and local-only guards; no db:reset or production target.

Items 1/2/7/8 use separate worktrees in parallel. Native Codex workers only, no OpenRouter/external API spending. Each item gets a separate draft PR and no automatic merge. Local-only work on 1/7/8 can proceed, but publishing PRs that would execute the old mutating E2E workflow waits for item 2 to merge (unless an equally safe non-production PR path is proven).

## Owner hold — item 2

Owner explicitly selected “Hold item 2 at this security boundary.” Existing production credentials are repository-level Actions secrets; only the copilot environment exists, with no branch restrictions. Prepared event/ref guards and credential-free PR GET smoke pass red/green tests but cannot stop PR-edited workflows requesting repository secrets. No environment/settings/secret migration is authorized or performed. Item 2 remains local, uncommitted and unpushed. Other parallel items may finish locally; publishing their code PRs would execute the old mutating E2E workflow, so publication is held.
