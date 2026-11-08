# TASK.md — current task, ready for a fresh orchestrator

**Date:** 2026-09-22. **Status:** resumed 2026-09-22 by fresh orchestrator (session 2); watcher decision reversed (#41); implementations incomplete, no new PRs/commits/pushes. 7 dispatches used (one additional Rig spawn attempt failed before launch). All coding workers stopped with no pending tool sessions. Read coordination/HANDOFF.md for the restart sequence.

## Done-when
Refresh all repositories and worktrees and safely remove stale merged worktrees; record approved decisions; implement T12b local service and T15 clock in parallel with disjoint files and one agent-core PR each, plus the approved companion desktop authentication PR; apply T13 watch-answer/admin decisions in a playbooks PR; verify checks and supply exact updater-key instructions. Braden approves merges. NEVER MERGE. T05 remote PR #3 stays draft until a Windows box exists.

## Required rules
Read AGENTS.md, coordination/ORCHESTRATOR.md, docs/PLAN.md, docs/TICKETS.md, docs/DECISIONS.md. Orchestrator does not open source files or write code; delegate source inspection/implementation with capped JSON and explicit filenames. Cheap model for manifests/summaries/bookkeeping; mid model for code. One writer per file. Inspect diffs and rerun real checks before publication. Tests before/with code; pytest, ruff, mypy --strict native and win32 for Python; update CHANGELOG. Never overwrite dirty unrelated work. Stop on missing design/secret or same step failing three times. Handoff at 10 dispatches in a session; Braden requested this handoff earlier.

## Approved decisions and clarifications
- T13 q1: keep profile.yaml.watch_answers as saved consent store; mirror Yes/No there, Not now unsaved so next visit asks again (#23 and #38).
- T13 q2: access_level admin-set, never onboarding input. New member default; preserve existing admin; Braden grants admin (#31).
- T15 (#30): installed skill schedules trigger existing T07 scheduler on time and once after sleep; log proposal shown/answered and task start/end plus necessary producer fields so all ten Scoreboard measures compute. Missing actual baseline/check-in data stays not_measured, never fabricated.
- T12b (#32): loopback-only local HTTP/WebSocket service matching Rig endpoint paths/payloads, chat/connect/log-path/pause/glow; token via secrets.
- Auth conflict resolved by Braden: **Yes, update Rig authentication too.** (#39) This requires two T12b PRs across agent-core and desktop-app; disclosed and approved. Agreed keychain service `OASIS`, account `rig.service_token`; HTTP Authorization Bearer; WS client protocols `["bearer", token]`, validate second protocol and echo `bearer` only. No URL token or logs. Native Rig fetches OS-keychain value, no employee setup.
- Watcher: #40 SUPERSEDED by #41 (Braden, 2026-09-22). T12b service MUST start without a watcher backend; real local pause/glow state; pause also pauses the T15 clock; activity log reports "watcher: not connected" until T05 wired. Fake backends test-only. (Old #40 text: refuse startup without real WatcherBackend — no longer applies.)
- Updater: Braden generates/stores keys himself; no real keys touched. Exact Windows instructions in coordination/updater-key-steps.md: from repos/desktop-app, `npx tauri signer generate --write-keys "$env:USERPROFILE\.tauri\oasis-rig.key"`, then hidden prompt via `uv run --project ..\agent-core secrets set updater.tauri.private_key` and similarly `updater.tauri.private_key_password`. Public key replaces `plugins.updater.pubkey` in desktop-app/src-tauri/tauri.conf.json. See document for full safe steps.
- Requested decision IDs collided: old30→35, old31→36, old32→37; old text preserved, explicit dated map and PLAN reference updated. #33/34 unchanged. New30clock,31admin,32service,38watchmirror,39authcompanion,40watcherrequired.

## Completed preparation / preserved work
- Nine repo mains refreshed, existing worktrees refreshed safely; clean demonstrably merged stale worktrees removed. Root workspace has no .git.
- Preserve dirty repos/skills/docs/formats.md and repos/playbooks/docs/{DECISIONS,PLAN,TICKETS}.md plus docs/research/. Not our changes; do not overwrite/commit blindly.
- Preserve worktrees/remote-t05 and remote draft PR #3.
- Root docs/TICKETS.md, docs/DECISIONS.md, docs/PLAN.md decision reference, and coordination/t03-pr.md updated. Dirty copies under repos/playbooks deliberately not overwritten.
- Main baseline root verified AFTER uv sync --frozen: agent-core330passed2skipped1deselected, ruff clean, mypy strict25files; playbooks41passed. These are BASELINE checks, NOT current branch approval.

## Worktree state at handoff
### T12b — agent-core service DRAFT, tests unrun
- worktrees/agent-core-t12b; branch codex/t12b-local-service; base3265e152f7aefd3c591a4a67fcfd64d352dcb229.
- Modified pyproject.toml, uv.lock (actual uv-generated lock, authorized); untracked src/anorak/local_service.py and tests/test_local_service.py.
- Draft aiohttp3.13.3 host/auth/CORS/Host/port ownership/10 routes, real T07+T08 chat adapter, lazy T11 adapters, mandatory watcher dependency and optional clock lifecycle.
- Worker uv lock and frozen sync passed. Initial ruff7 findings and mypy1 finding patched but NOT rerun. pytest local/all, win32 mypy, git diff check UNRUN. No t12b-checks.log yet.
- Next: tests/fixes, docs/local-service.md and docs/changes-T12b.md, startup requirement verification, check logs, review. Draft local_service.py 1056lines; split authorized into src/anorak/local_service_adapters.py and local_service_auth.py. service_cli.py and tests/test_service_cli.py also authorized if useful for truthful launch path; real backend mandatory.
- Known limitation: T11 OAuth flow uses a blocking thread; T11 public API has no cancellation handle. Document/review bounded service shutdown honestly.

### T15 — clock + telemetry DRAFT, final edits unverified
- worktrees/agent-core-t15; branch codex/t15-clock; same base3265e152.
- Modified docs/scoreboard.md, src/anorak/loop.py, src/anorak/memory/task.py, src/anorak/scoreboard.py, tests/test_memory_loop.py, tests/test_scoreboard.py.
- Untracked docs/changes-t15.md, docs/clock.md, src/anorak/clock.py, src/anorak/telemetry.py, tests/test_clock.py, tests/test_telemetry.py.
- Worker evidence coordination/t15-checks.log: 341passed2skipped1deselected, focused19passed BEFORE final async/risk edits. Final pytest/ruff/mypy native+win32 UNRUN. Root has not independently reviewed/verified branch.
- Known risk: test_clock real-loop test awaits dispatch tasks across two asyncio.run calls; gather must stay in same event loop. Fix first.
- API: DirectorySkillRegistry + LoopSkillScheduler(real LoopRunner) + SkillClock(registry,scheduler,actor,now,sleep,poll_seconds); async tick returns ClockDispatch.task promptly, run async, stop/set_paused sync. Must avoid long skill serializing clock dispatch. T12b can accept lifecycle seam; no T15 dependency on T12b.
- Ownership excludes scheduler.py, pyproject/lock, __init__.py; ask before expansion. Required real-loop gate/resource, catch-up/dedup, honest telemetry tests.

### Rig auth — NOT STARTED, clean worktree
- worktrees/desktop-app-auth; codex/t12b-rig-auth; base2e46cb157c7f3c585d6bef0afef5428e9a437ddb.
- Boundary coordination/rig-auth-build.json. Native token read, HTTP/WS auth, contract update, tests. No code changes. Failed spawn due native thread limit did not start work.

### T13 decisions — NOT STARTED, clean worktree
- worktrees/playbooks-t13-decisions; codex/t13-profile-decisions; basec580403310d8106076b54a068e5901f3fd49c46c.
- Boundary coordination/t13-decisions-build.json. Watch answer mirror/canonical saved values; no access_level input; member default/admin preservation and tests. No code changes.

## Integration / PR status
No new commits, pushes, or PRs. Four PR body outlines/create JSON payloads exist in coordination/ (t12b, t15, rig-auth, t13-decisions), but are NOT final evidence. Inspect before reuse; names in HANDOFF. Per-repo CHANGELOG still pending after source release, using worker fragments. Keep agent-core T12b and T15 independent; verify combined clock/service lifecycle after both are ready. No cross-repo release pin changes or merges authorized here.

## Tooling and dispatch history
- project-swarm skill read/applied. Runner exists /private/tmp/oasis-t01-swarm/tools/swarm.mjs, but root doctor claude fails missing required flags --restricted,--safe-mode,--tools,--permission-prompts,--strict-mcp-config,--no-session-persistence,--no-chrome. Do not weaken isolation. Earlier preparer compatible claim not reproduced.
- Native fallback per previous HANDOFF: gpt-5.6-sol code, gpt-5.6-luna manifests/summaries. Use fork none for model overrides. Explicit task manifests are native boundaries, NOT executable swarm schema. External smoke/provider not run or verified.
- uv /private/tmp/oasis-t01-tools/bin/uv. Cache access may need required sandbox escalation; do not bypass approval. Per-worktree .venv. New dependency locks generated by uv only.
- Rust isolated: RUSTUP_HOME=/private/tmp/oasis-t01-tools/rust/rustup CARGO_HOME=/private/tmp/oasis-t01-tools/rust/cargo PATH=/private/tmp/oasis-t01-tools/rust/cargo/bin:$PATH.
- Dispatches:1prepare(sync/docs),2updater(verifiedinstructions),3preparationstatus,4manifests,5T15draft,6T12bdraft,7cheapintegrationprep+handoff. Native workers t12b/t15 final stopped; manager finishes HANDOFF only. No code publication released. Successor should start fresh workers, not assume old native IDs usable.

## Session 2 progress (2026-09-22)
- Decisions #41 (watcher not required), #42 (unpause catch-up once), #43 (skill.yaml tier = install scope only; model from skill.yaml/agent config/Scoreboard), #44 (format chore separate) recorded.
- MERGED by Braden: agent-core#7 (T15), playbooks#3 (T13).
- OPEN: agent-core#10 (T12b), desktop-app#4 (Rig not-connected screen; log-reason question pending), project-swarm#17 (tier by difficulty), agent-core#8 (format chore), agent-core#9 (unpause catch-up, #42), project-swarm#16 (tier metadata).
- IN FLIGHT: T12b worker (worktrees/agent-core-t12b, base 3265e152 — must rebase onto agent-core main dd1fc2e before PR).
- Swarm field notes: coordination/swarm-lessons.md.
- NEXT (Braden, 2026-09-22): Mac first. AFTER T12b + Rig auth (desktop-app#3) merge: produce a Mac build (Rig .app via `npm run tauri build`, macOS bundle) and a plain-words "install and run on your Mac" guide covering: build the .app, start the agent-core service, sign in, connect Gmail (Google app in Testing mode, Braden only tester, 7-day refresh), run onboarding, run one skill, run the Scoreboard once. Clearly mark Windows-only parts as skipped (T05 watcher/proxy → "watcher: not connected"; .msi/.exe installer and signing; Windows keychain acceptance). Planned home: desktop-app/docs/mac-quickstart.md via its own PR, each step verified on this Mac before writing.
- 2026-09-22 later: merged agent-core#8, desktop-app#3, project-swarm#16. agent-core#9 rebased onto main, checks clean, mergeable. T12b rebased onto main (WIP commit 26ae509), 360 passed; worker now wiring real SkillClock into rig-service CLI. In flight: Rig "Not connected yet" screen (worktrees/desktop-app-not-connected, codex/rig-not-connected, Sonnet); swarm tier-by-difficulty docs (project-swarm-difficulty, Haiku). Decisions: Rig no-token screen text per Braden; tier by difficulty (ORCHESTRATOR.md updated). Latent issue from T12b: profile.yaml preferences.models.routes.*.secret_name trips T09 _SECRET_KEY validator (T08/T09 format conflict) — ask Braden.
- Updater (2026-09-22): Braden generated the keypair on this Mac. Keychain names are `updater.private_key` and `updater.key_password` (NOT the documented updater.tauri.* names). Public key id E25107C3B69B99B9 from ~/.tauri/oasis.key.pub is now in desktop-app `plugins.updater.pubkey` on branch codex/mac-build (worktrees/desktop-app-mac); this becomes the Mac-build PR together with docs/mac-quickstart.md. The private key was never read. The private key FILE ~/.tauri/oasis.key is still on disk with mode 644; flagged to Braden.
- 2026-09-22 later: MERGED agent-core#9, desktop-app#4. agent-core#10 (T12b) rebased onto main cd467ef, 366 passed, mergeable clean. Decisions #45 (secrets by name), #46 (service logs "no token found"), #47 (T16) recorded; T16 added to docs/TICKETS.md. In flight: secret_name fix (worktrees/agent-core-secret-name, codex/secret-name-refs, Haiku); T16 (worktrees/agent-core-t16, codex/t16-skill-tools, STACKED on #10 — rebase --onto main after #10 merges, Sonnet); updater pubkey follow-up (worktrees/desktop-app-mac, codex/mac-build, Haiku). After #10 merges: tiny PR for #46 no-token log line; then Mac build + docs/mac-quickstart.md in the codex/mac-build PR.
- T16 (2026-09-22): branch codex/t16-skill-tools rebased onto main bacac74 (commit 37a8a02, pushed, NO PR yet). 370 passed, ruff/format/mypy clean. Binding plumbing + tests work with fake tools, but PRODUCTION registry is EMPTY: none of the starter skills' 9 actions + 3 checkers has a real implementation (no T11 calendar/email content read, no filing rules/downloads/move, no step-to-step data passing in anorak.loop). Done-when NOT met for real runs. Waiting on Braden: open as plumbing PR? and scope T16b (which actions to build first).
- 2026-09-22 later: MERGED agent-core#11, project-swarm#18. OPEN: agent-core#12 (#46 no-token log), agent-core#13 (T16 hookup only, approved scope), project-swarm (require-model run in progress, worktree ~/Documents/repos-projects/project-swarm-model). Braden: T16b = make daily-summary real on his Mac (Outlook calendar + unread mail via T11, note to drawer) — Phase 0 finish line. Mac guide waits for T16b; build .app now. T16b design plan job (Opus, swarm CLI, output coordination/t16b-plan.md) running; worktree worktrees/connectors-t16b created. Mac .app building from worktrees/desktop-app-mac (updater artifacts off for local build; private key never read).
- Rule: workers run via swarm CLI (manifests in coordination/ with --root oasis for cross-repo read-only jobs; per-worktree .swarm-manifests/ for writing jobs).
- T16b plan done (coordination/t16b-plan.md, Opus via swarm, $1.58). Jobs J1 loop prior (expensive), J2 Graph read in connectors (mid), J3 wheel build (coordinator), J4 bindings+checker (expensive), J5 wiring+vendoring (mid), J6 skill.yaml (cheap, conditional). 15 design questions in §5 sent to Braden with recommendations; NOTHING dispatched until he answers.
- T16b APPROVED (decisions #48-#53). Worktrees: worktrees/agent-core-t16b (codex/t16b-daily-summary off main 9b6a8d2), worktrees/connectors-t16b (codex/t16b-outlook-read). Run 1 dispatched via swarm CLI: J1 loop prior (Opus) and J2 Graph read (Sonnet), manifests in each worktree's .swarm-manifests/. Next runs: J4 bindings + model summary (after J1), J7 POST /skills/<name>/run (after J1), J6 skills skill.yaml (schedule 30 7 * * 1-5, budget 0.05, summarize step, resources, version bump), J8 desktop-app docs/local-api.md run-now contract; J3 wheel build (coordinator) after connectors PR merges; J5 wiring + vendoring + TaskHooks + connector_limits.
- PR count for T16b is 4, not 2: agent-core, connectors, skills (skill.yaml lives there), desktop-app (local-api.md contract for run-now). Told Braden.
- T16b progress: J1 (loop prior) + J7 (run-now) committed on worktrees/agent-core-t16b (392 passed). J4 (bindings + model summary) committed, 429 passed. OPEN PRs: connectors#4 (J2 Graph reads, 214 passed), skills#4 (J6 daily-summary 1.1.0, 12 passed), desktop-app#5 (J8 run-now contract, docs). Next: after connectors#4 merges → coordinator builds gates 0.3.0 wheel from merge commit (J3) → J5 wiring + vendoring + TaskHooks + connector_limits + CHANGELOG → agent-core T16b PR → Mac guide + live run.
