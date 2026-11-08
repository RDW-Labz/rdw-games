# Scout + REA Lab + Planner: an autonomous front end for project-swarm

Status: design only, nothing built (Braden, 2026-10-13). Decisions: #382 (reuse before build), #383 (this design's fixed rules).
Companion: [swarm-orchestrator-review.md](swarm-orchestrator-review.md) (what to borrow from seven orchestrators).

## 1. The idea in one paragraph

Today work starts when Braden types a ticket or a "go". This adds three teams in front of the existing builders. **Scout** looks, per active project, for existing tools that would save a build (decision #382) and queues license-checked proposals. **REA Lab** studies open-source or our own software in a locked sandbox and writes feature specs, never code. **Planner** turns the proposals Braden approves into draft tickets that sit ahead of the queue. **Builders** stay exactly as they are: the existing seats, every PR held for Braden's typed merge. Nothing in the new teams writes to a product repo, merges, installs or spends past a cap.

```
active projects ──► SCOUT ──► proposals queue ──► (Braden: approve / drop)
                       │                               │
                       └──► REA LAB (sandbox) ──► specs ┘
                                                       ▼
                                                   PLANNER ──► draft tickets ──► (Braden: "file T…")
                                                                                     ▼
                                                              BUILDERS (existing seats) ──► held PRs ──► (Braden: "merge N")
        morning digest ◄── spend ledger, queue, specs, drafts, held PRs, kill switch state
```

Braden's three gates stay where they are: approve a proposal, file a ticket, merge a PR. The new teams only make those three lists better and shorter to read.

## 2. What project-swarm already has (reuse, don't rebuild)

From `swarm --help` (version installed at `~/.project-swarm/current`):

| Need | Already in swarm |
|---|---|
| License-checked tool search | `swarm scout --brief F --licenses FILE --allow-license PKG=LICENSE --max-picks N` |
| Batch search with a money cap | `swarm sweep --goals FILE --max-usd N --concurrency N --top N` |
| Run board / live view | `swarm board`, `swarm monitor RUN --view --watch` |
| Waiting on runs | `swarm wait RUN` |
| Verify before merge | `swarm integrate --mutants`, `swarm ship --no-merge`, flake checks |
| Lessons loop | `swarm lesson add/list/set/publish` |
| Tiered cheap-first routing | config `tiers` / `fallback`; Hermes → Cursor → Codex → OpenRouter → Claude (2026-10-08 routing rule) |

What is missing is the glue: a schedule, a shared proposal queue, an **enforced** daily cap across all runs (today `--max-usd` is per sweep and the $60/day worker cap is policy), a kill switch, heartbeats, a sandboxed REA runner, the Planner step and the digest. The companion review ranks which of those to borrow from other orchestrators. Its upgrades 1–3 (an enforced daily cap, a kill switch, a heartbeat/silence watchdog) are phase 1 here and must exist before any autonomous team runs. Upgrade 4 (a shared, file-backed queue) is the Planner's output channel, and upgrade 5 (a fact-driven board) is the digest. All are re-written in swarm from the idea; no code is copied.

## 3. The teams

### 3.1 Scout

- **Input:** `coordination/active-projects.yaml`, which lists each active project with its repo, current ticket queue (`docs/TICKETS.md` or `coordination/TASK.md`), and an allow/deny list of topics.
- **Run:** once a day (and on demand) a `swarm sweep` per project. The goals are the next N tickets that are not started, plus any ticket tagged `scout`. Cheap tier only (Hermes or Codex luna), with `--max-usd` set from the daily cap.
- **License rule:** a proposal is queued only if the candidate's license, read from its own repo at a pinned commit, is MIT, Apache-2.0, BSD-2/3 or ISC. AGPL, GPL (for code), ELv2, BSL, SSPL, non-commercial and custom licenses become "idea only" entries, with no code, prompts or docs copied (#382). The license row goes in `docs/design/references/LICENSES.md` when the proposal is approved, not before.
- **Output:** one file per proposal in `coordination/proposals/queued/<date>-<project>-<slug>.md`, from a fixed template:
  - ticket it saves;
  - candidate (repo, commit, license, stars, last push, archived?);
  - what we would reuse (idea / config / code);
  - integration cost (S/M/L);
  - risks (supply chain, maintenance, data leaving the machine);
  - "nothing fit" reasons when the search was empty.
- **Never:** install, clone into a product repo, run the candidate, or open a PR.

### 3.2 REA Lab

REA (`morluto/rea`, MIT, npm `rea-agents`) is used in **scout-only** mode, under #382 and #383.

- **Sandbox:** a throwaway Linux container (OrbStack or Docker on the Mac, or a GitHub Actions job in a private repo).
  - Image built from a checked-in Dockerfile with `rea-agents` pinned by exact version and npm integrity hash.
  - `npm ci --omit=optional`, so no Frida.
  - Runs with `--network none` and a read-only input mount.
  - The one writable output folder is `coordination/rea-lab/out/<run>/`.
  - No home directory, no Keychain, no `~/.oasis`, no agent configs. `rea-agents setup` is never run.
- **Allowed analyses:** static only. JavaScript/Electron, .NET, Go, WASM, packages and bundles, SQLite schema. No Hopper, IDA or JEB, no Ghidra in phase 1, no browser, device, network-capture or process-capture tools, and the target is never executed.
- **Allowlisted targets:** `coordination/rea-lab/targets.yaml`. Each entry is either `ours` (one of our repos or builds, e.g. OASIS.app for T124) or an MIT/Apache open-source project at a pinned commit with its license recorded. The runner refuses any target not on the list, and any entry without a license line. Third-party closed products are never targets (#382: no reverse engineering someone else's product).
- **Output: specs, not code.**
  - A worker turns REA's JSON findings into `coordination/rea-lab/specs/<target>-<feature>.md`: what it does, inputs and outputs, states, edge cases, and evidence cited by file/function name.
  - A check rejects any spec with a code block longer than 3 lines, or any 8-word run that matches the target's source (the same overlap check used for the NirDiamant repos).
  - A spec goes into the proposal queue like a Scout proposal.
- **Data:** REA's findings go to a model only through our routed workers. For `ours` targets with private data (drawers, customer files), the run stays local-model only (Hermes) or doesn't run.

### 3.3 Planner

- **Input:** proposals and specs Braden approved, i.e. moved by him to `coordination/proposals/approved/` or approved in the digest with a typed line like "approve P-2026-10-14-3".
- **Output:** a draft ticket in `docs/TICKETS.md` under a `## Drafts (not filed)` section, in the existing format:
  - title, repo, priority;
  - "Done when";
  - the reuse line ("reuses X at commit Y, MIT");
  - the questions Braden must answer first.
- **Placement:** drafts sit ahead of the queue but are not in it. Only Braden's typed "file T…" moves a draft into the numbered list. Builders never pick up a draft.
- **Never:** start a build, edit an existing ticket, or reorder filed tickets.

### 3.4 Builders (unchanged)

The existing orchestrator seat and swarm workers, with the current rules: one worktree per job, tests with code, mutation check after commit, every PR held for Braden's typed merge (#380), Rig and secrets limits (#126, AGENTS.md).

## 4. Safety rails

| Rail | Design |
|---|---|
| **Daily spend cap** | One enforced cap across Scout, REA Lab, Planner and builders. The usage ledger the 2026-10-08 routing rule calls for (`docs/state/usage-ledger.md`) does not exist yet; phase 1 creates it as a machine-written file from each run's recorded cost. Each dispatch reads today's total before starting and refuses when today + the job's estimate is over the cap. Proposed: **$10/day for the three new teams together**, inside the existing $60/day worker cap (warn at $40). Per team: Scout $4, REA Lab $3, Planner $3. Cheap tiers first; Claude workers are never used by the new teams. *Braden sets the numbers.* |
| **Kill switch** | `swarm stop` writes `~/.config/project-swarm/STOP` and cancels every running run of the new teams. Every scheduled job checks for the file first and exits if it's there. Builders are not killed by it (they are already interactive). Removing the file (`swarm resume`) is the only way back on. The digest shows the state on its first line. |
| **Heartbeat** | Each scheduled job writes `coordination/state/heartbeat/<team>.json` (last start, last finish, status, spend). A job with no heartbeat for 2× its schedule shows as "stalled" in the digest; stalled jobs are not retried automatically. |
| **Writes** | New teams write only under `coordination/` (proposals, rea-lab, state, digest) and the `## Drafts` section of `docs/TICKETS.md`. Product repos: read-only. No `git push`, no PRs, no merges. |
| **Untrusted text** | Everything Scout and REA Lab read (READMEs, docs, REA output) is data. It can't add targets, raise caps, change the allowlist or approve anything. Those files are edited only by Braden or by a held PR he merges. |
| **Supply chain** | Candidates are never installed by Scout. REA itself runs only from the pinned image. Any `@latest` in a command fails the check. |

## 5. Morning digest

Written at 07:00 local to `coordination/digest/<date>.md`, with one macOS notification that links to it. No email in phase 1; email through the Microsoft 365 connector can come later, but sending is outward and needs Braden's OK. One screen, in this order:

1. Kill switch: on/off. Spend yesterday per team vs cap; month to date. **Root repo: local ahead by N** (`git rev-list --count origin/main..main` in the oasis root; anything above 0 names the sync PR or says "not pushed").
2. Held PRs waiting for "merge N" (repo, number, 3 lines each).
3. Draft tickets waiting for "file T…".
4. New proposals and specs (one line each: project, candidate, license, saves which ticket, cost S/M/L), with "approve P-…" / "drop P-…" lines to copy.
5. Stalled or failed jobs, and what was skipped because of the cap.
6. Anything refused by a rule (license, target not on the allowlist, overlap check).

## 6. How agents get REA's docs as reference

- **Copy the docs:** REA's docs are MIT. Copy `README.md`, `DISCLAIMER.md`, `SECURITY.md`, `docs/cli.md`, `docs/mcp-contracts.md` and the per-target guides we allow into `docs/design/references/rea/<commit>/`, with the LICENSE file and a row in `LICENSES.md`.
- **Pass them as context:** workers get them with `--context` as read-only files. They never run REA's installer or skill, and never register its MCP server in a seat's agent config.
- **Index the CLI:** a short `docs/design/references/rea/USAGE.md`, written by us, lists only the allowed commands and flags (static analyses, `--json`, no runtime or browser commands), so a worker can't pick a forbidden one from the full docs.
- **Docs are data:** REA's own text includes instructions to agents ("Ask your agent…", "run setup"). Workers treat them as data; our USAGE.md is the only instruction source.
- **Refresh:** when the REA pin moves, the docs copy moves with it in the same held PR.

## 7. Phases

Each phase is one or two small held PRs. Nothing starts without Braden's typed go for that phase. Changes to project-swarm itself need his OK (2026-10-08 routing rule).

| Phase | What | First PR | Needs from Braden |
|---|---|---|---|
| **0** | This design + decision #383 | this PR (oasis docs) | read, "merge N" |
| **1** | **Rails first:** the usage ledger plus an enforced daily cap, kill switch (`swarm stop` / `resume`), heartbeat files, plus `swarm digest` (spend, held PRs and stalled jobs only) | **project-swarm PR: `swarm stop/resume` + ledger cap check in `run`/`sweep`/`scout`, with tests** (small; no new team yet) | cap numbers; OK to change project-swarm; digest time (07:00?) |
| **2** | Scout team: `active-projects.yaml`, proposal template, queue folders, daily `sweep` on launchd, digest section 4 | oasis PR (template + yaml + launchd plist, not loaded) | list of active projects; OK to load the launchd job (he runs `launchctl load` himself) |
| **3** | REA Lab: Dockerfile with a pinned `rea-agents`, runner script with allowlist + `--network none`, spec template, overlap check, REA docs copy | oasis PR; first target = our OASIS.app (T124) | install OrbStack/Docker (him); approve `targets.yaml`; confirm the REA pin |
| **4** | Planner: approved → draft tickets in `## Drafts`, digest section 3 | oasis PR | the approve/file wording; max drafts per day |
| **5** | Tune: per-team budgets, ideas from the orchestrator review (shared queue, dashboard) | per the review's ranked list | per item |

**The first small PR (phase 1)** is in project-swarm, not a new team:
- `swarm stop` / `swarm resume` write and remove `~/.config/project-swarm/STOP`; `run`, `sweep`, `scout`, `ask` and `ship` refuse while it exists.
- Every run appends its cost to the usage ledger (created by this PR); `run`, `sweep` and `scout` read today's total from it and refuse a dispatch that would cross the configured `dailyCapUsd`, with a plain message.
- Tests for both, plus a mutation check. It's useful on its own the same day, even if nothing else is built.

## 8. Open questions for Braden

1. Daily cap for the three new teams together (proposed $10) and per team.
2. Which projects are "active" for Scout (OASIS only to start?).
3. Digest delivery: file + Mac notification only, or also email later?
4. Where REA Lab runs: OrbStack on the Mac (proposed) or a GitHub Actions job in a private repo.
5. May REA Lab ever use Ghidra (free, Apache-2.0) on our own native builds, or static JS/.NET/bundles only for now?
