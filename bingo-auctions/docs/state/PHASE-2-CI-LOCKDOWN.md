# Item 2 — held at the production-secret boundary

Confirmed in e2e.yml/global-setup.ts: PR E2E receives the production service-role key and updates/creates a synthetic auth user plus upserts its bidder row. Deploy had no ref guard. App Store credentials also reached PR-controlled code. API metadata confirms repository-level production credentials; only an unprotected copilot environment exists. No secret values were read/copied.

Prepared locally: credential-free PR GET smoke (no checkout), full E2E only on trusted master/deploy events, executable Cloudflare master-ref guard, and master-only App Store credential step. Four focused Node security tests failed on old workflows then passed. YAML parsed; forced typecheck12/12, lint11/11 and unit/DB tasks12/12 passed. Runtime/E2E implementations unchanged.

These guards fix the existing jobs but cannot deny a same-repo PR that edits workflows access to repository-level credentials. Enforced isolation requires protected secret storage and wiring every consumer. The API cannot retrieve existing values. Owner explicitly selected HOLD; no environment changes, secret migration, PR/push/merge/deploy. Preserve this local branch for review. Do not call item2 complete or publish other PRs through the old unsafe E2E path.

Rollback: local/unmerged; no production rollback needed. Eventual merge needs its actual squash SHA and draft revert PR. Workflow-only change has no deploy. Reverting this boundary reopens exposure and needs deliberate owner review.
