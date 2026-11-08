# BinGo cleanup — Phase 2 follow-ups

Deferred review items; listing them does not authorize implementation in Phase 1.

- **E2E writes to prod and gets the service-role key on PR branches.** Review this in Phase 2. The current setup updates the synthetic auth user and upserts its bidder row; `.github/workflows/e2e.yml` supplies the service-role key on PR runs. Per Braden's instruction, Phase 1 leaves all E2E files unchanged, runs the existing suite normally, and requires E2E green before merging. The Phase 1 no-DB-writes limit applies to cleanup operations, not this existing synthetic-user suite.

Evidence: [E2E workflow](../../.github/workflows/e2e.yml) and [synthetic-user setup](../../apps/operator-web/e2e/setup/global-setup.ts).
