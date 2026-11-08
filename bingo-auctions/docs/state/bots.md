# BinGo Auctions bots

Last updated: 2026-11-06 by the orchestrator (#867, #724, #725, #831). Off switches and spend caps are in MANAGER.md (on the #647 branch until that PR merges).

## Worktree rules (all builder lanes, from #714)

- The main checkout `~/Developer/bingo-auctions` stays on `master` with a clean
  tree. Never branch, build or edit ticket work there.
- Every ticket/lane gets its own worktree at
  `~/Developer/bingo-worktrees/<ticket>` (ticket = issue or PR number).
  Do not use `/private/tmp` — it can be wiped on restart.
- Push work-in-progress to its branch at least every 30 minutes.
- Weekly cleanup: `git worktree remove` worktrees whose PR is merged or closed,
  then `git worktree prune`. Post the count removed on #687. Never delete
  branches.

## Grok (BIngo Auction BOT), manager

Job: watches PRs, checks, issues and staff feedback, assigns agent labels, posts digests and alerts. **Ship gate:** may merge, push and apply prod migrations only when a RED TEAM PASS names the exact head (app 1144995), all checks are green, there is no `red-team-block`/HIGH finding, and a rollback is in place — and outside freeze windows. Money, signups, customer data, secrets and other one-way changes still need a direct Braden/Jared typed yes (owner decision recorded on #867; ship gate in `docs/state/LAUNCH-PLAN-2026-05-24.md`). Never publishes OTAs or deploys, and never touches money, refunds or Square.
May touch: issue/PR labels and comments, the #687 digest log, and the ship-gate actions above. Read-only everywhere else.
Schedules (America/Chicago):

- Daily 7:30 AM digest (every day): shipped, stuck, yes/no questions, migration RED TEAM verdict and rollback lines. Posted in chat and on #687. Adds or removes needs-rollback.
- Daily 4 PM digest plus open staff issues (every day): same format, posted in chat and on #687.
- Staff feedback triage: every 10 min, weekdays 8:00-17:30. Labels, routes, and /reply-staff on from:staff-help issues.
- Watch auto TEST updates: every 15 min, weekdays 8:00-19:45. Watches eas-update runs and posts the TEST checklist 2 h after a clean update. Read-only.
- Watch morning prod migrations: every 10 min, 5:00-7:50, Nov 4-8. Read-only watch and report. Braden runs migrations. URGENT on a failure, an out-of-order run, or a failed ledger_check. A planned skip if nothing ran by 6:00 on Wed.
- RED TEAM verdict watch: on each new verdict from either agent app. Matches the block/clear label to the app-attributed verdict and its exact SHA (Grok relays owner decisions; the auto-labeler applies sensitive-path labels).
- Approval ping: on a typed yes/no from Braden in his Grok chat. Reposts it verbatim on the PR/issue with its scope, so a merge or migration approval is never inferred.
- Live build board: every 5 min (launchd `com.bingo.swarm-status`). Publishes the read-only `swarm-status` branch snapshot; see #698.
- Self-improvement loop: nightly (~11 PM CT). Posts metrics on #722 and keeps at most two loop items open at a time (#723, #724 are the current pair).
- Friday staff feedback list: Fridays 3 PM.
- Weekly status on Jared's requests: Fridays 2 PM, a draft for Braden to forward.
- Monday weekly scoreboard: Mondays 8 AM. Counts only.

## Orchestrator (OpenRouter)

Job: works agent:opencode issues: branches, draft PRs, tests, fixes. Skips status:parked.
May touch: its own branches and draft PRs, and read-only prod checks through the query workflow. Merges only with all checks green and Braden's or Jared's typed "merge", plus auto-merge for docs/unit-test-only PRs with all checks green. Auto TEST (development) OTA after staff-app merges. No preview/production OTA, deploy or migration without Braden's or Jared's yes. No raw SQL on prod, no secrets, no money, refunds or Square. No rollback, no ship.
Schedule: launchd `com.bingo.autopilot` fires `scripts/autopilot/tick.sh` every 60 seconds; `tick-check.mjs` decides whether there is new work and only then starts one model run. Owner-approved combined budget (Nov 5 2:27 PM CT, relayed by Grok on #831): **warn $200/day, hard stop $300/day**, split into fixed per-machine shares **ghost $100/day, mac-mini $200/day**; autopilot and bot-fleet `launch-build` share the machine's budget. The tracked `run.sh`/`tick.sh` on master still enforce the older **$50/day** until the #831 launcher merge lands; after that the shared machine authority enforces each machine's share. Spend is read from `~/.bingo-autopilot-spend.json` (plus the shared machine store after #831); a cap stop is posted on #687.

### Orchestrator sessions

- **Start:** launchd runs `tick.sh` (working copy `~/Developer/bingo-auctions`). A single-instance lock directory `~/.bingo-autopilot.lock` prevents two cycles at once. `AUTOPILOT_OFF` in the repo root stops every cycle.
- **Context:** each triggered cycle is a fresh `opencode run` process; context does not carry between ticks. Continuity is the files, not a conversation: `docs/STATE.md` (state and next tasks), the tick's `New events since last tick` JSON, and `~/.bingo-autopilot-seen.json` (what has already been reported).
- **When context runs out:** the process exits; the next tick starts clean and resumes from `docs/STATE.md`. Write progress to the issue/PR and `docs/STATE.md` before a long task, not after.
- **After a reboot:** launchd reloads the user LaunchAgents at login. Verify with `launchctl print gui/$(id -u)/com.bingo.autopilot`; reload with `launchctl bootout` + `launchctl bootstrap`.
- **How to tell it is stuck:** no new line in `~/Library/Logs/bingo-autopilot/launchd.out`, an old `~/.bingo-autopilot-tick.json` date, a stale `~/.bingo-autopilot.lock` with no matching process, or a cycle whose `*.summary` reports a nonzero exit. `#687` is the escalation log.
- **What is unknown today:** there is no measured per-tick context size, no automatic retry for a failed cycle, and no session-level resume beyond `docs/STATE.md`. Treat those as open gaps, not guarantees.

## Engineer bot (Claude API)

Job: small, clear bugs labeled agent:engineer.
May touch: draft fix PRs only.
Schedule: on label. Cap $50/month. Off switch ENGINEER_BOT_ENABLED=false (#646).

## Staff Help chat (Haiku)

Job: answers staff in the app and files from:staff-help issues.
May touch: creating issues only.
Schedule: always on. Cap $25/month. Off switch HELP_CHAT_ENABLED=false (#645).

## RED TEAM (ChatGPT)

Job: reviews fix PRs and migrations and gives a GO or NO-GO verdict. Advice only, never an approval.
May touch: nothing directly. The ChatGPT Codex Connector app (id 1144995) posts its reviews as PR comments; Grok (app 1210556) relays owner decisions.
Schedule: on every new PR head with green checks. `scripts/autopilot/request-red-team.mjs` posts the re-review request from the tick; the fix-until-PASS rule is: fix every HIGH and MEDIUM in one push, add a regression test for each HIGH, re-request, repeat while the verdict is FAIL/BLOCK/FREEZE. A PASS applies only to the exact SHA reviewed. $0 extra.

## Runbook pointers

- Migrations: `docs/runbooks/` has only `asc-app-privacy-runbook.md` today; the Member Pro order lives in `docs/runbooks/MEMBER-PRO-MIGRATIONS.md` on its PR branch until that PR merges. The Wed 0479 runbook is `scripts/autopilot/wed-0479-launchd.sh` (#705).
- OTAs: no dedicated runbook yet; the gate and the approval requests are on #769 and the `eas-update` workflow.
- Help chat: no runbook yet; design and status are on #645/#693.
- Swarm: #698 and `scripts/autopilot/publish-swarm-status.mjs` (read-only snapshot).

## Business metrics snapshot (#725)

Grok's counts-only feed. `.github/workflows/metrics-status.yml` runs daily at 13:15 UTC and commits `status/metrics.json` to the **`metrics-status`** branch (never master, never force-pushed). Read it at `https://raw.githubusercontent.com/RDW-Labz/bingo-auctions/metrics-status/status/metrics.json`.

- **Read-only (two layers):** one SELECT through the Supabase Management API (`scripts/metrics-status/lib.mjs`). `assertReadOnly()` strips comments/literals and refuses anything that is not a single SELECT/WITH, including data-modifying CTEs, `SELECT INTO` and every write/DDL verb. The Management API request also sets `read_only: true`, so the database itself rejects any write the lexical guard missed (the scratch-PG16 check confirmed a read-only transaction denies a data-modifying CTE and `SELECT INTO`).
- **Data sources:** `auth.users` (`last_sign_in_at`, `created_at` timestamps only), `bids`, `watchlist`, `lot_status_history`, `auction_status_history`, `invoices`, `operator_refund_ledger` (0421, the per-refund amount+timestamp ledger), `bidder_subscriptions`. Only aggregates leave the database; the document is built from an allowlist, so an unknown column is never copied.
- **Event semantics:** listings/sales/unsold/auction runs come from the status-history tables (a lot first published today counts today; an unsold outcome survives a relist). Refunds use `operator_refund_ledger`, so amount-only refunds are included and each refund lands on its own date. Member Pro `current` requires an unexpired `current_period_end`; its windows report activation dates. Active users are distinct users with a sign-in, bid, watchlist add or paid invoice in the window.
- **Windows:** every metric carries `1d`, `7d` and `30d`. `member_pro_members` also carries `current` (a snapshot).
- **Privacy (money disclosure model):** no names, emails, phones, addresses, user ids, invoice lines or free text. A nonzero count under 5 is published as the literal `"<5"`; a true zero stays `0` (it identifies nobody). A money total is released only when its smallest contributing calendar day had at least 5 distinct customers; otherwise it is withheld as `"<5"`. One customer with many invoices is still one contributor, and 30d−7d or two daily snapshots can only ever reconstruct days that were themselves releasable — no small amount can be isolated by differencing.
- **Guard:** `scripts/__tests__/status-metrics.test.mjs` fails the lint job if any leaf is not a number, the `"<5"` sentinel, or the one ISO date, and fails closed on a missing/null/negative/fractional/unsafe aggregate instead of coercing it to zero.
- **Merge gate:** touches money totals and adds a scheduled job, so it needs Braden's or Jared's yes and a RED TEAM check that no personal data can leak.

## Planned, not live

- Listing QA (#685): daily read-only listing check. Goes live only on Braden's yes.
- RED TEAM review Action (#680): parked.
