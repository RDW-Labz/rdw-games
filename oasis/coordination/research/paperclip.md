# paperclipai/paperclip — evaluation

**Verdict: borrow patterns.** Not a fit for the OASIS product (wrong audience, wrong stack). Genuinely useful as a reference for our own build tooling — the org-chart/budget/ticket/approval design is the closest thing on GitHub to what T80-class swarm-orchestrator work needs, and it is exactly what the brief's "org charts of agents, budgets, task tracking, heartbeats" question was aimed at.

## 1. What it is / does

Paperclip is a self-hosted Node.js/Express + React (TypeScript, monorepo, pnpm) control plane that turns a roster of *existing* coding/agent CLIs (Claude Code, Codex, Cursor, OpenClaw, plain bash, HTTP webhooks) into an "org chart": a CEO agent hires/reports-to other agents, each with a role, monthly budget, and skill set. Work is tracked as tickets ("issues") with atomic single-assignee checkout. Agents run on **heartbeats** (woken on a schedule, check work, act, sleep) rather than staying resident. State lives in Postgres (embedded PGlite for local dev, real Postgres in prod) via Drizzle ORM; there's an append-only activity/audit log and a separate `heartbeat_run_events` run-log table. Humans approve via a coarse **Approvals** flow (hiring an agent, CEO strategy) plus a much finer-grained **tool/action policy engine**: every governed tool call can be set to "Ask human / Ask first," which creates a signed, argument-hashed `tool_action_request` that pauses the agent (server-owned execution — the provider call literally does not run until approved), and a human can Approve-once, Decline, or "Always allow" (creates a scoped, revocable trust rule per agent+connection+action). Risk levels, rate limits, and argument filters are first-class (`tool_policies`, `ToolRiskLevel`). Sources: [README](https://github.com/paperclipai/paperclip/blob/master/README.md), [AGENTS.md](https://github.com/paperclipai/paperclip/blob/master/AGENTS.md), [docs/api/approvals.md](https://github.com/paperclipai/paperclip/blob/master/docs/api/approvals.md), [doc/connections/TASK-REVIEWS.md](https://github.com/paperclipai/paperclip/blob/master/doc/connections/TASK-REVIEWS.md).

## 2. License / paid / CLA / telemetry

- **License:** MIT repo-wide — root `LICENSE` verified, plus every sampled sub-package (`cli`, `server`, `ui`, `packages/mcp-server`, `packages/adapters/*`, `packages/plugins/sandbox-providers/{e2b,modal}`, `packages/{teams,skills}-catalog`) declares `"license": "MIT"`. No dual-licensed or source-available carve-outs found.
- **No CLA.** No CLA bot, no `CONTRIBUTOR_LICENSE` file.
- **No paid/cloud-only core.** Fully self-hosted, no pricing page gating features; optional plugins integrate paid cloud sandboxes (e2b, Modal, Daytona) but those are opt-in providers, not required.
- **Telemetry: real and opt-out by default.** `AGENTS.md` §7 states plainly: "Telemetry is the Paperclip first-party event system. It is **opt-out** and it **sends data to a Paperclip endpoint by default**." Separate OpenTelemetry "observability" path is opt-in (no-op until an operator sets an OTLP endpoint). The telemetry contract claims no PII/secrets/prompts are sent, task IDs are salted-hashed, but this is a background phone-home by default — a hard no for anything touching Cluer data per our rules.

## 3. Maturity

- 83,974 stars, 15,171 forks, 409 watchers, created 2026-03-02 (~7 months old) — extremely fast-growing.
- Commits daily, latest same-day as this review (2026-09-25); weekly-ish tagged releases (`v2026.916.1`, `v2026.831.x`, ...).
- 30 GitHub contributors but heavily concentrated: one contributor (`cryppadotta`) holds ~2,841 of the commits (bulk of the project); next two ~550/~275. Bus-factor risk.
- 5,663 open issues against a very high closed-issue velocity (issue numbers already past 14,000 in 7 months) — high churn, large backlog, but issues/PRs move fast. Commit messages follow an "AI-agent-authored" template ("## Thinking Path"), i.e. the project appears to largely build itself using its own (or similar) agent tooling — notable both as a maturity signal and as a data point on quality control.
- No company/VC backing found: creator is an individual (also known for an unrelated NFT project), zero pricing, self-funded/self-hosted. (Separately, a YC-backed startup "Naive" reportedly forked Paperclip and stripped attribution shortly after it went viral — a reputational note about the ecosystem, not about this repo's own license.)
- Docs are good: `docs.paperclip.ing` has quickstart/core-concepts/architecture pages, `AGENTS.md`, `CONTRIBUTING.md`, `DESIGN.md`, `doc/SPEC*.md` are all present and detailed.

## 4. Fit for OASIS

**(a) Product (Amber/Michael, non-technical):** **Skip.** Paperclip is explicitly built for people who "have 20 simultaneous Claude Code terminals open" — a builder/operator UI for managing swarms of coding-style agents, not a coworker that lives quietly on one person's desktop. No orb/avatar, no onboarding conversation, no local-first single-user design, no Tauri; it's a hosted web dashboard over a Postgres control plane. Stack is Node/TS + React web app vs. our Python 3.12 agent-core + Tauri 2 desktop shell — a rewrite, not a reuse. Default-on telemetry alone would need stripping before any Cluer data got near it.

**(b) Build tooling (project-swarm / orchestrator):** **Borrow patterns**, don't adopt the whole app.
- *Signed, argument-hashed action requests with a pause-until-approved gate* — directly maps to our "ask-first bound to a plan hash" rule; their implementation (server-owned execution, no provider call until approved, revocable "Always allow" trust rules scoped per agent+connection+action) is a concrete reference for T28/T28a.
- *Heartbeat scheduling model* (agents wake, check work, act, sleep, resume same task context) — a cleaner mental model than a long-lived worker for how project-swarm workers could check in/resume across bounded runs.
- *Org chart with per-agent monthly budgets and hard-stop auto-pause* — worth copying literally for Braden's swarm cost caps ($500 alert rule already in PLAN.md); their budget-hits-limit-agent-stops behavior is a good pattern name: "budget hard-stop."
- *Three-tier data-path discipline* in their own `AGENTS.md` (telemetry vs. observability vs. local run-log, reviewed at different strictness) is a good template for how we document our own scrubber/log boundaries for contributors.
- *Tool risk levels + per-tool rate limits + argument filters* (`tool_policies`, `ToolRiskLevel`) — a reasonable schema reference for expanding `skill.yaml`'s `risky_steps` into something queryable/auditable at the DB level, if/when we outgrow YAML.

Do not adopt: their coarse "Approvals" (hiring/strategy only) as our per-action gate — it's the wrong grain for us; we already have the better (per-`risky_step`) design in the plan. Do not adopt their bring-your-own-coding-agent org-chart concept for agent-amber/agent-michael — wrong audience.

## 5. Conflicts with our rules

- **Telemetry sends data off-machine by default (opt-out).** Directly conflicts with "no company data leaving the machine" / no-training-provider rules if ever pointed at anything Cluer-related, even for internal swarm tooling — would need to be disabled/patched, not just configured.
- **"Always allow" trust rules** let a human relax ask-first per action — philosophically close to our Scoreboard-proposes/person-accepts relaxation, but done by a raw UI toggle with no injection-test gate; if we ever borrowed this component we'd need to bolt our "cannot relax until injection suite passes" rule on top, it doesn't exist there.
- **Stack mismatch:** Node.js/TypeScript server + Postgres/Drizzle, not Python 3.12/mypy/uv; UI is a web React dashboard, not Tauri 2. Nothing here is drop-in for `agent-core`, `remote`, or `desktop-app` — only the *ideas* are portable, and would need reimplementation in our stack.
- **Bus factor / single dominant contributor** — a risk if we ever depended on upstream fixes rather than just reading it for ideas.

No file changes needed elsewhere; this is the only file touched.
