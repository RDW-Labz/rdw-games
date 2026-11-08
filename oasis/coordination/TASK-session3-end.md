# TASK.md — current task, ready for a fresh orchestrator

**Date:** 2026-09-23. **Status:** Phase 0 finish line reached on Braden's Mac. Only the guide PR merge is left. Session-3 running log: `coordination/TASK-session3-log.md` (history only). Session 2: `TASK-session2-log.md`.

## Done-when (Phase 0 finish line, Braden)
The shared `daily-summary` skill runs for real on Braden's Mac through `rig-service` (clock or `POST /skills/daily-summary/run`), reads Outlook calendar and unread mail through connectors, the default model writes ≤3 lines, one note per day goes to his drawer, and `daily_summary_matches` passes. **MET 2026-09-23** (run 4: done/done, $0.00098; counts matched Outlook). Then the Mac guide `desktop-app/docs/mac-quickstart.md` ships in the Mac-build PR: **desktop-app#6 OPEN**, waiting for Braden to merge. NEVER MERGE; Braden merges.

## Remaining work (in order)
1. **Braden merges desktop-app#6** (branch codex/mac-build, head 0b9bea6). Check: `gh api repos/RDW-Labz/desktop-app/pulls/6 --jq .merged`. Nothing to do until then.
2. **(m) PRIORITY, agent-core:** the service writes every Rig status poll to `log.jsonl` as `action: local_service`, `data.operation: status` (772 of 859 lines in one morning). That inflates the Scoreboard's "tasks" and "cost per task". Stop logging read-only status polls (a status read is not an action; "every action logs" still holds for real actions). Add status-poll noise to the Scoreboard test fixture so it can't regress. Do it before the Scoreboard ever runs on real logs. After it merges, delete or recompute `~/.oasis/drawers/braden/scoreboard/2026-09-23.json` (made from the noisy log) and ask Braden which.
3. **(j) agent-core bug:** a second same-day daily-summary run ends `done_when_failed` and still pays for a model call (~$0.001). Likely cause: `notes.write` returns the morning note (its recorded counts) while the checker compares it to the live step 1-2 counts. Fix so a repeat run on the same day is `done` without a new note, and ideally without a model call (skip the model step when today's note exists). Adding a skip may be a design choice: if the plan doesn't cover it, ask Braden.
4. **(h) design first, then build:** the service and the Rig must get the drawer path from ONE place (decision #55: `~/.oasis/drawers/<person>/`). Today it is a `--drawer` flag in one and a hard-coded Tauri fs scope `$HOME/.oasis/**` in the other. Propose the single source to Braden before building.
5. **T17 Orb v2** (docs/TICKETS.md, decision #56): first Rig ticket of Phase 1, after desktop-app#6 merges. Covers the clipped right-click menu (n) and the dark box (o). Original art only. Click-through uses the Rust cursor-poll from `docs/research/rig-framework-tauri-vs-electron.md`. T18 voice comes after, and Braden decides the mic flow and speech model first.
6. Smaller, when convenient: re-vendor connectors 0.3.1 into agent-core (so `--catalog-dir` becomes optional; the vendored wheel is still 0.3.0); Rig Activity rows show raw ISO times and "braden — local_service" (polish); chat answers as plain Claude (no agent profile yet; thin T12); onboarding and Scoreboard are not bound to rig-service (only daily-summary is); (l) a quick restart once printed "could not start" (likely the old process still held its lock or port). Watch for it.

## Current Mac state (Braden's machine)
- Drawer `~/.oasis/drawers/braden` (mode 700). profile.yaml: anthropic `claude-haiku-4-5-20251001`, secret `anthropic.api_key`, price 1/5 per MTok. daily-summary 1.1.0 installed (schedule 07:30 weekdays).
- Keychain (service OASIS): anthropic.api_key, rig.service_token (generated in place), Outlook + Outlook Calendar tokens, updater keys.
- **rig-service is RUNNING** in the background from `worktrees/agent-core-guide-verify` (detached d965a33 = agent-core 0.6.0, vendored connectors 0.3.0 wheel installed), `--catalog-dir repos/connectors/catalog` (b65b7ba). Its log is in session 3's scratchpad. It stops if the Mac restarts; restart it with guide step 6.
- OASIS.app (latest build) is at `worktrees/desktop-app-mac/src-tauri/target/release/bundle/macos/OASIS.app`.
- Ledger: the call refused for low credit was settled at $0 with Braden's OK. `ledger settle braden --amount 0 --drawer ~/.oasis/drawers/braden` → "nothing to settle".

## Rules (Braden, standing)
- Read AGENTS.md, coordination/ORCHESTRATOR.md, docs/DECISIONS.md (#41–#53 are new this session).
- **Workers run through the swarm CLI**, never the Agent tool unless the CLI can't do the job. Tell Braden and fall back once. `node ~/Documents/repos-projects/project-swarm/tools/swarm.mjs --root <dir> validate|run|monitor --view --watch 5|inspect|integrate`. Keep project-swarm main pulled.
  - Manifests must live inside `--root`: use `<worktree>/.swarm-manifests/` (listed in `.git/info/exclude`). For cross-repo read-only or PR-body jobs, use root = oasis with outputs in `coordination/`.
  - Run output is two JSON lines; the run id is `head -1 | jq -r .id`.
- **Every job names `model`** (swarm refuses otherwise; the default would be Opus). Route by difficulty: cheap=haiku (small follow-ups, PR bodies), mid=sonnet, expensive=opus with a `tierReason`.
- CLI workers have no shell. The orchestrator integrates, then runs pytest, ruff check, ruff format --check (changed files, when main has old drift), mypy --strict native and `--platform win32`, and `git diff --check`. Read every diff at trust boundaries and in docs.
- Tooling: uv `/private/tmp/oasis-t01-tools/bin/uv`. Rust: `RUSTUP_HOME=/private/tmp/oasis-t01-tools/rust/rustup CARGO_HOME=/private/tmp/oasis-t01-tools/rust/cargo PATH=/private/tmp/oasis-t01-tools/rust/cargo/bin:$PATH`. PRs via `gh api repos/RDW-Labz/<repo>/pulls --input <json>`. Never bare `git stash` in worktrees.
- Parallel PRs in one repo both edit the top of CHANGELOG Unreleased. Rebase the second one, keeping newest first.
- **Swarm improvement duty:** log friction in `coordination/swarm-lessons.md`. Ship fixes as project-swarm PRs from a fresh worktree off origin/main. Open lessons: 4 5 6 7 9 10 11 12 13 14 17 18 19 20. Priority next swarm PR: #20 (retry the `--help` flag probe under load and report "probe failed" separately from "flag missing"), #18 (manifest outside root), #16/19 prompt hygiene.

## Merged in session 3
agent-core #14 (T16b, 0.5.0) #15 (follow-ups: #54 accounting, ledger CLI, 0.6.0) · connectors #5 (packaged catalog, python -m gates, Entra /callback, 0.3.1).
Open, ours: desktop-app #6. Open, not ours: project-swarm #14, #15.

## Decisions added in session 3
#54 refused call = failed at $0; uncertain never blocks; `ledger settle`. #55 drawer at ~/.oasis/drawers/<person>. #56 Orb v2 = T17, voice = T18 (both Phase 1, added to docs/TICKETS.md).

## Other open items
- Worktrees that can be removed after confirming their PRs merged: agent-core-t16b, agent-core-mac-run, agent-core-followups, connectors-t16b, connectors-connect-fixes, plus the session-2 list in TASK-session2-log.md. Keep agent-core-guide-verify while rig-service runs from it. Keep desktop-app-mac until #6 merges. Keep remote-t05 (draft PR #3, needs a Windows box).
- Updater key: Braden was told to back up `~/.tauri/oasis.key` and its password off the Mac (not confirmed done). Keychain names: updater.private_key, updater.key_password.
- Braden may delete an Anthropic key named "OASIS-braden" in his console. If that is the key in `anthropic.api_key`, daily-summary breaks until he stores a new one.
- Preserve dirty, unrelated files: `repos/skills/docs/formats.md`, `repos/playbooks/docs/{DECISIONS,PLAN,TICKETS}.md`, `repos/playbooks/docs/research/`.
- Swarm lessons from session 3 to log in `coordination/swarm-lessons.md`: the validate/run manifest path is relative to --root; workers invent scope (fb added an agent budget), so read money and trust diffs; worker tests can miss imports (typecheck catches it); workers cite untracked `.swarm-manifests` files in shipped docs.
