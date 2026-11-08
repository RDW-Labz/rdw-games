# Orchestrator review for project-swarm upgrades

Research only, 2026-10-13. Nothing was installed, cloned or run. Everything below comes from each repo's README and a few source-file headers, read through the GitHub API at the commits listed. Licenses were read from each repo's own LICENSE file at that commit and are recorded in `docs/design/references/LICENSES.md`. Decision #382 applies: reuse MIT/Apache, never copy AGPL, Elastic or other source-available code.

None of the seven is AGPL or Elastic. All are MIT or Apache-2.0, so any of them could be a code source. project-swarm itself is Apache-2.0 and public (`RDW-Labz/project-swarm`), so copied MIT or Apache code must keep its notices in the swarm repo's NOTICE file.

## 1. Summary

| Tool | Repo (commit read) | License | Verdict | Top idea for project-swarm |
|---|---|---|---|---|
| Paperclip | paperclipai/paperclip (`e43af97`) | MIT | Borrow ideas; maybe the budget math | Budget policies per scope with warn %, hard stop and pause, plus a record of each budget incident |
| Bernstein | sipyourdrink-ltd/bernstein (`0af5743`) | Apache-2.0 | Borrow ideas; small code (kill switch) | A file-backed kill switch, heartbeat stall detection with an escalation ladder, and budget actions (pause, downgrade, abort) |
| Agent Orchestrator | OrchestratorInc/agent-orchestrator (`b3588f6`) | Apache-2.0 | Borrow idea | A board whose card positions come from facts (session, PR, CI, review), not from what agents say |
| Baton | mraza007/baton (`7bb5fb7`) | MIT | Borrow idea; small code if wanted | A claim, run, retry-with-backoff, release state machine, and a slot count from `max_concurrent` |
| Code Conductor | ryanmac/code-conductor (`bf87141`) | MIT | Borrow idea only | A shared queue as labelled GitHub issues with an atomic claim, plus a stale-claim cleanup job. Its auto-merge is the opposite of our rule |
| Microsoft Conductor | microsoft/conductor (`f0480d0`) | MIT | Borrow ideas; maybe the pricing table approach | A fleet view across all running workflows with tokens and cost, human gates you answer from the dashboard, and per-run iteration and time limits |
| Emdash | generalaction/emdash (`10be20f`) | Apache-2.0 | Borrow idea | A desktop app that runs agents in parallel worktrees, resets stale agent status, and installs lifecycle hooks into each agent |

Name note: Bernstein's README and links point to `sipyourdrink-ltd/bernstein`, and `chernistry/bernstein` resolves to the same repo (same stars, not a fork). Agent Orchestrator was found as `ComposioHQ/agent-orchestrator` and now lives at `OrchestratorInc/agent-orchestrator`. Baton is a common name; `mraza007/baton` is the one matching "autonomous coding agent orchestrator".

## 2. Each tool

### Paperclip (MIT)

**What it is:** a Node server plus React UI that runs a "company" of agents. It has org charts, tickets, approvals, budgets and a dashboard.

**What project-swarm lacks:**
- **Budgets for every agent, enforced.** `packages/db/src/schema/budget_policies.ts` holds a budget per scope (company, agent or project) and time window. Each has a warn percentage (default 80), a hard-stop flag, and a rule for usage it can't price (default "block"). `server/src/services/budgets.ts` compares observed spend with the limit, returning warning or hard_stop, and pauses the scope.
- **Budget incidents.** `budget_incidents.ts` records each crossing: limit, observed, window and status, linked to an approval to resume.
- **Heartbeats and a watchdog.** Agents "wake" on a heartbeat. Watchdog decisions are stored and can be snoozed (`heartbeat_run_watchdog_decisions.ts`).
- **Dashboard plus approvals,** in one place.

**Verdict:** borrow the ideas. Its code is built on a Postgres schema and a server we don't run. The budget threshold function (observed vs limit vs warn %) is small and could be re-written in a few lines, so code reuse isn't worth the attribution overhead. Its "unpriced usage = block" default is worth copying as a rule.

### Bernstein (Apache-2.0)

**What it is:** a Python "governance layer" for agents. A YAML file declares phases, roles and gates; a plain-Python scheduler runs it. Each coding task gets its own git worktree behind merge gates. It has a replay journal, an optional signed audit log, and terminal and browser dashboards. It describes itself as beta and solo-maintained.

**What project-swarm lacks:**
- **Kill switch:** `src/bernstein/core/autoheal/kill_switch.py`, about 2.8 KB. A single file whose content is empty (on), `forever`, or an ISO time ("off until"). The workflow checks it first on every run.
- **Heartbeat and stall detection:** `src/bernstein/core/agents/heartbeat.py` (45 KB) and `heartbeat_escalation.py`, with adaptive stall detection and an escalation ladder.
- **Budget actions:** `src/bernstein/core/cost/budget_actions.py`, about 15 KB. On a threshold: pause for approval, downgrade to a cheaper model, or abort the run. Also a per-agent cost ledger (`core/agents/agent_cost_ledger.py`).
- **Approval queue:** `core/approval/queue.py`.
- **A "janitor" verify step:** tests pass, files exist, lint and types clean, before a task counts as done.

**Verdict:**
- **Kill switch:** borrow the idea, and optionally the code. It's small and Apache-2.0, but a re-write in JavaScript is shorter than porting.
- **Budget actions:** borrow the idea. "Downgrade to a cheaper model" maps directly onto our tier ladder.
- **Heartbeat:** borrow the idea only. 45 KB of Python isn't worth porting; a simple "no output for N minutes" watchdog fits swarm better.

### Agent Orchestrator (Apache-2.0)

**What it is:** a desktop workspace with a Go backend and a frontend. It runs and supervises many coding agents, each in its own worktree. Its live Kanban derives each card's column from facts: session, pull request, CI and review state. Review feedback goes back to the same agent.

**What project-swarm lacks:**
- **A board driven by facts.** swarm's `board` shows live runs and writer conflicts, but not PR, CI and review state per job.
- **Feedback routing:** CI failures and review comments go back to the agent that owns the work.

**Verdict:** borrow the idea. The code is a Go plus desktop stack; nothing to lift into a Node CLI. `private/` (a submodule) and `cloud/` (a hosted product) were not read and are not sources.

### Baton (MIT)

**What it is:** a small Python tool (about 28 files). It polls GitHub issues by label, makes a worktree per issue, runs Claude Code, and opens a PR.

**What project-swarm lacks:**
- **A persistent retry queue:** `symphony/state.py` has `max_concurrent`, `available_slots`, claim and release, a retry queue with due times, and `persist()` to disk. `symphony/orchestrator.py` has exponential backoff (`_backoff_delay`) and a reconcile loop.
- **A queue fed from issue labels,** with no manual dispatch.

**Verdict:** borrow the idea. The state machine (Unclaimed, Claimed, Running, RetryQueued, Released) is a good, small model for a shared queue. The code is short enough to re-write.

### Code Conductor (MIT)

**What it is:** a GitHub-native setup. Tasks are issues labelled `conductor:task`. Agents claim them (`.conductor/scripts/task-claim.py`), work in worktrees, and open PRs. It has stale-claim cleanup (`cleanup-stale.py`, a scheduled workflow) and a health check.

**What project-swarm lacks:**
- **A shared queue any seat can read,** stored in GitHub issues.
- **Automatic release of stale claims.**

**Verdict:** borrow the idea only. Its install guide suggests `--auto-merge`, which breaks decision #80 and #380 (Braden merges). Its claim is "pick an unassigned issue", which can race. Last push was 2026-03-30.

### Microsoft Conductor (MIT)

**What it is:** a Python CLI for repeatable multi-agent workflows in YAML. It runs agents in parallel, has human gates, a web dashboard, and a "Fleet Manager" TUI showing every running workflow with tokens, cost and gate alerts.

**What project-swarm lacks:**
- **Run limits:** `src/conductor/engine/limits.py` caps each run at a maximum number of agent runs and a maximum wall-clock time.
- **Pricing tables:** `src/conductor/engine/pricing.py` refuses to invent a price for an unknown model ("an invented rate would print as a confident cost") and marks partial costs as lower bounds.
- **A fleet view** across all runs, with cost and pending gates in one screen.
- **Human gates answered from the dashboard.**

**Verdict:** borrow the ideas. The "unknown price stays unknown" rule matches swarm's cost reporting (`reported` vs `estimated-from-transcript`) and should become an enforced refusal under a cap. The code is MIT and clear, but tied to its own engine. Re-write.

### Emdash (Apache-2.0)

**What it is:** a desktop app (YC W26) that runs many coding agents in parallel worktrees. It sends issues from Linear, GitHub and Jira to agents, and reviews diffs, PRs and CI in one place.

**What project-swarm lacks:**
- **Stale-status reset:** e.g. `reset-stale-tui-agent-statuses.ts`.
- **Lifecycle hooks:** marker-tagged hook entries installed into each agent, so the app knows when an agent starts, stops or waits.

**Verdict:** borrow the idea. It's a desktop product, and swarm is a CLI.

## 3. What project-swarm already has (don't rebuild)

From the swarm source at `406f51b` and `swarm.mjs --help`:

- **Concurrency per run:** a manifest `concurrency` field (default 2), tracked as peak concurrency in the monitor view. One writer per repo across runs is enforced by `board` (writer conflicts refuse before start).
- **Per-job timeouts,** with `cancel RUN`, plus provider-limit detection with reset times.
- **Cost per job:** reported by the agent, or estimated from the transcript, with the source labelled.
- **Enforced spend caps for OpenRouter only:** `tools/openrouter.mjs` refuses before sending if the worst case breaks $5 per job or $25 per UTC day, and refuses when pricing can't be read.
- **`sweep --max-usd`** for scout sweeps.
- **Verify before merge:** `integrate` runs the checks, the mutation check (`--mutants`) and the flake check. `ship` waits for CI, and `--no-merge` holds the PR. Preflight guards, `redcheck`, and checks from CI.
- **Dashboards:** `board` (live runs), `monitor RUN --view/--watch`, and `status`/`inspect`/`wait`.
- **License-checked scouting:** `scout --allow-license / --licenses`.
- **Lessons:** add, list, check and publish.

**Gaps:**
- **Daily cap across all agents:** the $60/day cap (#140) is a policy in the orchestrator's memory, not enforced by swarm.
- **No global kill switch.**
- **No silence watchdog:** only a hard timeout.
- **No queue that outlives a session:** TASK.md is hand-kept.
- **No fact-driven board** across PR, CI and review.
- **No morning digest.**

## 4. Five upgrades worth doing (ranked)

1. **An enforced daily spend cap across all agents, with warn and hard stop.** Idea from Paperclip's `budgets.ts` (MIT) and Bernstein's `budget_actions.py` (Apache-2.0); re-write in swarm. Extend the OpenRouter cap pattern to every adapter: a UTC-day ledger file, warn at 80%, and refuse new jobs at 100%. Unknown price means refuse (Paperclip's "unpriced = block", Conductor's "no invented rate"). Optional action: drop one tier instead of stopping. **Idea, re-written.**
2. **A kill switch.** Idea from Bernstein's `core/autoheal/kill_switch.py` (Apache-2.0). One file, e.g. `~/.config/project-swarm/STOP`: empty or missing means run, `forever` means stop, an ISO time means stop until then. `run`, `sweep`, `scout` and `ship` check it first; a running job sees it within one poll and cancels cleanly. **Idea; the code is small enough to re-write.**
3. **A heartbeat and silence watchdog.** Idea from Bernstein's `heartbeat.py` (Apache-2.0) and Paperclip's watchdog decisions (MIT). Each job writes a last-output time; no output for N minutes marks it `stalled`, then cancels after M. **Idea, re-written** (Bernstein's 45 KB is too much to port).
4. **A shared queue that outlives a session.** Idea from Baton's `state.py` (MIT) and Code Conductor's claim and stale-cleanup (MIT). A file-backed queue with states proposed, approved, queued, claimed, running, held and done. Claims are atomic (rename or lock file), stale claims are released, and retries use backoff. The Planner writes to it and seats claim from it. **Idea.**
5. **A digest and fact-driven board.** Idea from Agent Orchestrator's Kanban (Apache-2.0) and Conductor's fleet view (MIT). One read-only report per morning: spend vs cap, held PRs with CI state, stalled jobs, queue changes, scout proposals waiting. Its column positions come from facts (`gh` PR, CI and review), not from what agents say. **Idea.**

**Not worth doing:**
- **Auto-merge** (Code Conductor): it breaks #80 and #380.
- **Org-chart governance** (Paperclip): too heavy for one seat.
- **Signed audit receipts** (Bernstein): nice, but OASIS already logs every action; revisit later.

## 5. Fit with Scout + REA Lab + Planner

The design in `docs/design/swarm-scout-rea-planner.md` adds autonomous teams: Scout, REA Lab and Planner. They run without Braden watching, so the safety rails must exist first.

- **Upgrade 1 (daily cap) and upgrade 2 (kill switch) are prerequisites.** No autonomous team starts until both are enforced in swarm and tested. A scout sweep that can't price its model refuses.
- **Upgrade 3 (heartbeat) is a prerequisite** for any unattended run, so a stuck REA Lab container or scout job doesn't burn time overnight.
- **Upgrade 4 (shared queue) is the Planner's output channel.** Approved proposals become draft tickets in the queue; builders claim from it, and every PR stays held for Braden's typed merge.
- **Upgrade 5 (digest and board) is the morning digest** in the design, read-only, with a fact-driven held-PR list.
- **Scout reuse:** Scout already maps to `swarm scout --licenses` and `sweep --max-usd`, so it needs no new runner, just the cap and kill switch in front of it.
- **REA Lab** needs none of these seven tools. It needs the sandbox from the REA scout-only setup.
