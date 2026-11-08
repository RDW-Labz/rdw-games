# HANDOFF.md history archived 2026-10-02 (blocks older than session 70); the live file keeps the two newest blocks

# Session 69 (Claude seat, Fable 5.1) — FINAL handoff 2026-10-01 23:30Z → session 70 (13 build dispatches; handoff on context, #282)

- **Merged:** remote#11 **3ff34c4 = 0.3.2** (T51 items 2+3 on remote, decision #239; `remote gate (ubuntu)` is the one required check, branch protection re-pointed by the seat from `tests, lint, types (ubuntu-latest|windows-latest)`, strict=false, Braden can restore; Windows full tier on push / platform or macro/watcher/transport paths / labels; wall 12.5 min). agent-core#96 **e0760fa = 0.7.58** (gate split into `gate-lint-types` + 3 pytest shards + `if: always()` aggregator keeping the required-check name; wall 18.4 min). **Measured gate on #96's CI run: 5 m 39 s, worse than 4 m 27 s**: file-count sharding put test_injection_suite.py's half of the suite in shard 0 (332 s vs 41/40 s).
- **New ticket (Braden typed "Move forward with all the lesson upgrades", decision #340): T80 lesson tool** for project-swarm 1.41.0 (docs/TICKETS.md → T80; TASK.md top block). Worktree worktrees/swarm-z, branch swarm-1.41-lessons off swarm-1.40-batch-y-pr; brief + queued rows under docs/_swarm/ (WIP commit 91af1a0, dropped before ship).
- **New tickets (Braden typed, ~23:00Z):** **T81 speed pipeline** (decision #341: `ship --wait-required-only`, `swarm ticket` manifest→merge pipeline with resume, Codex workspaces with the root's venv/node_modules so workers run their own checks, kept adapter stderr/stdout + one retry on the Codex blip, `swarm scaffold job|pr`; 1.42.0 stacked on T80's 1.41.0) and **OpenRouter worker pool** (decision #342: `anthropic/claude-sonnet-5.5` on OpenRouter is a standing mid-tier worker in parallel with Codex; its inline-context cap is 200 KB, so anything needing tools/swarm.mjs (385 KB) goes to Codex; adapters/pipeline modules fit).
- **Also merged:** agent-core#97 **b94d2d6 = 0.7.59** (shards by collected test id, four shards; gate 1 m 59 s; merged by hand on the green required check while ship waited on the non-required Windows job). Tickets T80 (#340) and T81 (#341) opened; OpenRouter pool (#342). Lessons #322–#324 queued.
- **T80 1.41.0 READY (not pushed):** clean branch swarm-1.41-lessons-pr 956c18f (worktrees/swarm-z-pr), `npm test` 1244/0, payload .swarm-manifests/t80-pr-create.json with the public-line template for Braden's one-time OK; holds behind batch Y's wording OK (pushing it pushes Y). Three fix rounds (publish module blocked on a lock interface → retry; SKILL.md L108 paragraph vs ≤10-line lessons span; package-lock + release-pinned test). **Diagram DONE:** docs/diagrams/project-swarm.{json,html,png} (73 components / 70 connections; validate `--repo-root` + check green; oasis fc8a13c); Braden got a reduced PNG, the HTML open in his browser and a private page https://claude.ai/artifact/QCwg6WAJ2KdH7ViRsNmPMu. **T81:** pipeline job landed (WIP 5daac59 on swarm-1.42-speed: `ship --wait-required-only`, `swarm ticket` + `--resume`, `check-env-missing`, `stub-section`); adapters job truncated on OpenRouter (32768 cap) → **t81-adapters-2 on Codex landed as WIP 6fcb909 (worktrees/swarm-t81); nothing in flight at handoff**; wire-scaffold not yet dispatched.
- **Speed s69:** idle 0.0 min · parallel 7.06 by the tool (realistic ≈ 3) · wall per merged PR: remote#11 12.5 min, agent-core#96 18.4 min, agent-core#97 23.5 min. **Spend:** seat ≈ $24.6 estimated (147 turns); Claude workers $0; OpenRouter in flight; Codex plan only.
- **(Superseded detail kept for reference) In flight earlier:** (0) T81 contract, Codex, root worktrees/swarm-z2 (detached off swarm-z HEAD 546682d + brief commit 0216983), manifest .swarm-manifests/t81-contract.json, log worktrees/swarm-z2-contract-run.log → copy docs/_swarm/t81-contract.md + t81-jobs.json into the T81 build worktree (branch swarm-1.42-speed off swarm-1.41-lessons after T80 lands), dispatch 3 builds: adapters + pipeline on OpenRouter Sonnet 5.5 (if the output-cap check passes; else Codex), wire-scaffold on Codex. (1) agent-core gate rebalance, Codex, root worktrees/agent-core-t51c, branch t51-gate-shards-2, manifest .swarm-manifests/t51-shards2.json, log worktrees/agent-core-t51c-run.log → integrate, uv lock, checks, ship as 0.7.59 (payload to write: copy .swarm-manifests/t51-shards-pr-create.json and adjust), then measure the gate on the PR run. (2) T80 builds t80-core / t80-ship / t80-wire-docs, Codex ×3 in parallel, root worktrees/swarm-z, manifest .swarm-manifests/t80-build.json, log worktrees/swarm-z-build-run2.log (contract 546682d landed by a hand `codex exec` after two sandboxed runs died in <31 s) → inspect, integrate, `npm test` in worktrees/swarm-z, fix round, 1.41.0 release commit, clean branch off swarm-1.40-batch-y-pr dropping docs/_swarm, ship after batch Y merges.
- **Lessons:** #322 (failed Codex job's stderr dropped; retry once on the network-blip signature), #323 (ship --check on a venv-less worktree classed tool-missing as pre-existing). Queued for batch Z.
- **Worker routing:** Codex gpt-6-astra only (all Claude workers at the weekly limit until 2026-10-02 23:00Z). Codex network blip hits ~1 in 3 launches: a 17 s "Missing output" failure with no stderr kept → just re-run.
- **Waiting on Braden:** batch Y public lessons wording OK (entries 192–198; batch Y is the base of 1.41.0); connectors/playbooks "skip" or "add win32 mypy" (they already run one 44 s ubuntu job each, nothing to split); flake quarantine format (T51 item 5); Mac-check batch (rig restart onto 0.7.58 covers 0.7.49–0.7.58; install OASIS-fa0bf59.app; Coworkers page checks).
- **Speed s69 so far:** idle ≈ 0 min · parallel ≈ 1.5 · wall per merged PR: remote#11 12.5 min, agent-core#96 18.4 min.

---

# Session 68 (Claude seat, Fable 5.1) — FINAL handoff 2026-10-01 ~22:00Z → session 69

- **Merged:** agent-core#95 **159a327 = 0.7.57** (T51 items 2+3; decision #239): `agent-core gate (ubuntu)` is the one required check (branch protection re-pointed by the seat; previous contexts were `tests, lint, types (macos-latest|ubuntu-latest|windows-latest)`, strict=false; Braden can restore). Gate = uv sync --locked, ruff, mypy --strict, mypy --strict --platform win32 (lesson #316), pytest; measured 4 m 27 s on CI (target < 4 min not yet met; pytest is 2 m 41 s of it; follow-up: split or parallelise the suite). `decide` job runs on every event, answers full=true on push, else on paths (.github/, pyproject.toml, uv.lock, win/keychain/credential/secret/install/service/updater/platform in a filename) or labels release/full-ci. Full tier: tests,lint,types on windows+macos, one-step rig install on 3 OSes, Windows Credential Manager. Seat caught and fixed two worker bugs by hand: decide was limited to pull_request (a skipped `needs` skips dependents, so the full tier would never have run on main) and the gate carried timeout-minutes: 4 (killed the test step at 4 min on the first CI run); regression test added. Ship rounds: 2 (first CI run: gate cancelled at the 4 min timeout). Not needs Braden.
- **Built, not pushed:** batch Y release 1.40.0 is committed on the clean branch swarm-1.40-batch-y-pr (4dbcb20, worktree worktrees/swarm-y-pr, base project-swarm origin/main b0b4e17; suite 1214/0 fail there), payload .swarm-manifests/y-pr-create.json (oasis root, head swarm-1.40-batch-y-pr). Waits on Braden's OK of the public docs/lessons.md wording (entries 192–198, sent to him 21:1xZ).
- **Decisions/lessons:** decision #239 (T51 two-tier gate/full CI). Lessons #317–#321 queued and committed (#317 Codex nested sandbox; #318 prompt-path check false positive on a directory prefix; #319 scoutRun crashes instead of reporting a refusal; #320 auto-attached worker skills refusing read-only asks over missing resultKeys; #321 DeepSeek envelope-less bookkeeping result, copy from the workspace). Next swarm batch Z carries #301–#321.
- **In flight at handoff:** nothing.
- **Waiting on Braden:** public lessons wording OK for batch Y; Mac-check batch (rig restart onto 0.7.57, install OASIS-fa0bf59.app, T50 polish + T77 + T79 on the Coworkers page); the flake quarantine format question (T51 item 5: is a list file per repo a new config format?).
- **Worker routing:** Sonnet CLI hit the weekly limit at ~21:2xZ (run refused provider-limit); haiku CLI and haiku Agent-tool out; Sonnet via the Agent tool still works (used for y1c6, lessons 320–321); Codex gpt-6-astra works for file-only/contract jobs but cannot run project-swarm's own tests (lesson #317); DeepSeek works for PR payloads/changelog bookkeeping (lesson #321). All Claude workers reset 2026-10-02 23:00Z.
- **Speed s68:** idle 0.0 min (session_metrics.py, roots . + worktrees/swarm-y + worktrees/agent-core-t51) · jobs in parallel 6.57 by the tool (asks and Agent-tool rows inflate it; realistic ≈ 2 build jobs at a time) · wall per merged PR: agent-core#95 43 min (first run 21:13:38Z → merged 21:56:33Z).
- **Spend:** Fable seat ≈ $18.6 estimated at 148 turns (seat_cost.py; ≈ $21 by handoff) · Claude workers ≈ $2.7 (asks $2.0, scout $0.66; Agent-tool Sonnet 167k + haiku 100k tokens on the plan) · DeepSeek ≈ $0.01. Build dispatches: 2 (y1c6, t51). Daily worker spend well under the $60 cap.

---

# Session 67c (Claude seat, Fable 5.1; same chat, Braden-directed) — FINAL handoff 2026-10-02 20:36Z → session 68

- **Merged:** desktop-app#65 b20e6a9 · #67 05eee87 (T51b gate; main's required check = `desktop-app gate (windows)`) · #66 e2c6aa9 (HoloCard design by gpt-6-astra + polish #337) · #68 8d37866 (T77 Coworkers v2) · **#69 fa0bf59 (T79 desktop: Add a pack → import route)** · agent-core#93 0ee38cd (thumb cap 256 KB) · **agent-core#94 aa90b71 = 0.7.56** (playbooks 0.6.0 vendored: 96 r1 still packs + portraits; POST /avatars/import, mutants 6/6; structural PNG checks for bundled packs; Windows fixes: frozen loop clock in the scoreboard test, `O_DIRECTORY` via getattr) · **playbooks#18 4d6de2a = 0.6.0** (stills_to_pack + 96 packs).
- **Decisions:** #337 (polish + thumb cap), #338 (eight theme sets as 96 `<theme>-NN-r1` packs), #339 (import route, no hard limits, recommendation only). Lessons #301–#316 queued. Renders: coordination/references/t50 (states, states-v2, states-v3, video), t77/v1, t79/.
- **In flight at handoff:** nothing; OASIS-fa0bf59.app is built in worktrees/builds/.
- **Parked:** batch Y (swarm-y; resume y1c5 via the worktree swarm when Claude workers return 10-02 23:00Z).
- **Waiting on Braden:** see TASK.md.
- **Speed s67c:** idle 0 min · parallel ≈1.5 · wall per merged PR: #68 2.5 h, playbooks#18 1.5 h, #93 1.3 h, #94 ≈ 5.5 h (7 ship rounds: CI timeout, perf cliff, Windows clock, win32 mypy, two ruff line lengths), #69 ≈ 3 h (held for #94), #66 ≈ 17 h (held for Braden's pick). Seat ≈ $267 estimated for the whole chat (592+ turns).

---

# Session 67b (Claude seat, Fable 5.1; same chat continued on Braden's 'Continue') — handoff 2026-10-01 ~13:15Z → session 68

- **Done since the s67 block below:** Braden picked (a) "Let codex do it" for the sandbox tmp. Codex jobs y0, y0b2, y0c, y0d landed as WIP commits on worktrees/swarm-y branch swarm-1.40-batch-y: isolation dirs honour SWARM_TEST_TMP; `config-inside-repo` exempts `.swarm-tmp/`; the codex adapter + runner create `$TMPDIR/swarm-codex/<run>-<job>` outside the repo, allow it in sandbox.sb in raw + realpath forms plus ancestor file-read-metadata grants (after the tmp deny), export TMPDIR/TMP/TEMP/SWARM_TEST_TMP, clean up unless SWARM_KEEP_TMP=1. Local suite 1214 tests, 3 known batch-y reds. The generated profile passes the realpath probe. Lesson #308 queued.
- **First dispatch of s68:** y1c5 (see TASK.md top line) through the worktree's `node tools/swarm.mjs` — the installed 1.39.0 still has the old sandbox.
- **Still waiting on Braden:** #66 design pick (desktop-app#66 ready, held); the 32 KB thumb cap; installer PAT; the s66 list. desktop-app#67 (T51b) MERGED 05eee87; main's required check is now `desktop-app gate (windows)`.
- **Speed s67b (this stretch, 05:1xZ–13:15Z):** idle 0 min · parallel ≈1 (one Codex job at a time by design: each depended on the last) · wall per merged PR: no merges in this stretch (s67 figure stands: 48 min avg).

---

# Session 67 (Claude seat, Fable 5.1) — handoff 2026-10-01 ~04:42Z → session 68

- **Done:** desktop-app#65 MERGED b20e6a9 (preview-screens HoloCard selector). **desktop-app#66 OPEN, ready, held for Braden's design pick** (branch t50-holo-v2; Astra HoloCard design pass + harness `--holo-state` + `--avatars`; checks 3/3 in body, CI 3/3 green; worktree worktrees/desktop-app-t50v2). **desktop-app#67 (T51b CI gate) MERGED 05eee87** (04:51Z; checks 3/3, mutants 3/3, CI 4/4 green). The merge was blocked by main's branch protection naming the old checks, so the seat set the required check to `desktop-app gate (windows)` only (per the T51b ticket: gate is the only required check; `gh api PATCH .../protection/required_status_checks`; previous value `desktop-app (macos-latest)`, `desktop-app (windows-latest)` — Braden can restore it). Renders: coordination/references/t50/states/ (v1 placeholders) and states-v2/ (Astra design + real r1 avatars, downscaled ≤32 KB), both sent to Braden. Lessons #301–#307 queued. oasis main pushed (29e56ed + this handoff).
- **In flight:** nothing.
- **Parked:** batch Y (worktrees/swarm-y 11a3577; three Codex sandbox failures on the same step → stop rule; resume facts in TASK.md item 2) until a Claude worker returns 2026-10-02 23:00Z. Installer job still 403 (PAT).
- **Waiting on Braden:** #66 design pick (then merge + three lines + OASIS.app rebuild + mac-checks row); thumb cap decision (32 KB `AVATAR_THUMB_MAX_BYTES` vs real pack thumbs); installer PAT; the s66 list.
- **Worker routing:** every Claude model incl. haiku at the weekly limit until 10-02 23:00Z; Codex gpt-6-astra is the only worker (cannot run product checks: no node_modules in its workspace; the seat runs checks after integrate; contracts must be WIP-committed under docs/_swarm/ and dropped before ship via a clean branch + `git diff origin/main..HEAD -- . ':!docs/_swarm' | git apply --3way`). DeepSeek `ask` path returns nothing (#304). Next buildable tickets need a Claude worker (web scouts T52–T60, T61) or Braden (T33 #336, T75).
- **README "On Braden's Mac":** unchanged this session (no new Mac-check rows; #66 adds one after merge).
- **Speed s67:** idle 0.0 min · parallel 6.51 · wall per merged PR 48 min avg (#65 29 min; #67 66 min, 03:45Z first run → 04:51Z merge).

---

# Session 66 (Claude seat, Fable 5.1) — handoff 2026-10-01 ~01:30Z → session 67

- **Done:** skills#21 0.11.0 MERGED b320562 (CI 2/2 green 00:16Z; T76c month-end-close-prep read-only, profile thresholds; three lines sent; Open: month_pack ref/amount/txn_date/status confirm vs T33 or add as follow-up). **T50 Holo coworker cards MERGED desktop-app#64 → main a681db4** (01:15:47Z; CI 4/4; not needs Braden; mutants 3/3 behavioral; HoloCard component + CSS foil + gold border + pointer tilt + drag-rotate + click flip + static/reduced-motion fallback; wired into Coworkers + onboarding pick).
- **In flight:** batch Y y1a COMMITTED 95a045b (01:40Z; api-adapters + openrouter envelope errors / optional result object; 38 tests pass). y1b-rest (lessons #298/#294/#293 completion, response-invalid.txt write, Codex test tmpdir fix #299, two pre-existing main reds first). t50-shots (haiku Agent-tool, screenshots A–E light/dark into coordination/references/t50/). Installer job 403 on agent-core checkout (Braden's PAT fix, re-run).
- **Waiting on Braden:** T50 screenshots + approval; installer token; #336 picks at skills#21; rig restart + app; T61b cap; OASIS_SERVICE_TOKEN; credentials; Fable cache-write; wall-clock loop test.
- **Spend:** seat ≈ $16.5 estimated (Fable 5.1, 149 turns); OpenRouter Sonnet 5.5 $1.94 (5 requests, two failed wire/card); Agent-tool haiku ≈0.95M tokens across 10 jobs; Codex 68k $0; DeepSeek $0. **Speed s66:** idle 0.0 min · parallel 7.58 (session_metrics.py, Agent-tool rows inflated; tool note) · wall per merged PR 49 min (T50 first run 00:26:45Z → merged 01:15:47Z).
- **Worker routing:** haiku Agent tool (with shell) carried T50 wire/fix/clean/mutants after OpenRouter file-only failed the wire job twice ($0.35 each) and truncated the card job ($0.52); batch Y y1a/y1b also on haiku; t50-shots haiku forthcoming; Codex compatible but sandboxed from test tmpdir. Sonnet/Opus/Fable back 2026-10-02 23:00Z.

---


# Session 65 (Claude seat, Fable 5.1) — handoff 2026-09-30 ~21:55Z → session 66
- **Done:** T76b + T76c contracts (coordination/t76/, decisions #335, #336); route decision #334 (OpenRouter Sonnet 5.5 code workers until 10-02); lesson #293 (T76a leaked company names into the shared skill + hollow injection fixture); T76a scrubbed + sender gate in code, shipped as skills#19 → MERGED main e12b566 = 0.9.0 (21:31Z, three lines sent).
- **In flight:** T76b MERGED skills#20 → main c17635d = 0.10.0 (21:44Z, three lines sent); T76c committed 86abebe = 0.11.0 (205 pass, mutants 3/3) **shipped held as skills#21** (https://github.com/RDW-Labz/skills/pull/21, four local checks passed) → s66 merges on green + three lines (TASK.md item 3 has every command).
- **Waiting on Braden:** installer PAT (run 36777224453 still 403 "Write access to repository not granted"; PAT resource owner must be RDW-Labz with agent-core listed, or classic repo PAT; curl test line in TASK.md item 4); #333 picks at the T76a PR; plus the s64 list.
- **Spend:** seat ≈ $14.8 estimated (seat_cost.py, Fable list); Agent tool haiku ≈ 0.85M tokens (11 jobs); OpenRouter Sonnet 5.5 $0.66 (two failed attempts unrecorded); DeepSeek/Codex $0. Speed s65: idle 2.5 min (boot) · parallel 1.81 · wall per merged PR ≈ 23 min avg (skills#19 ≈32, skills#20 ≈15).
- **Worker routing now:** contracts/bookkeeping/fix-ups on haiku via the Agent tool (rows stamped by `date -u`); new code builds on OpenRouter `anthropic/claude-sonnet-5.5` via the swarm CLI (#334; manifest gotchas in TASK.md rules line: manifest-level `contract`, `Return JSON only {...}` shape with the attached skills' keys, cap ≤32768 + `edits` for existing files, ENVELOPE RULES paragraph; the adapter returns prose in `summary`, so integrate may need a transcribed result JSON appended to `.swarm/runs/<id>/<job>/response.txt` — lesson #295). DeepSeek is refused by the swarm for coordination/*.md.

---

# Session 64 (Claude seat, Fable 5.1) — handoff 2026-09-30 ~21:05Z → session 65
- **Done (all merged):** agent-core#91 T74 (a)+(b) 047dd63 = 0.7.53 (needs Braden, three lines) · **T76 role file v1 complete:** agent-core#92 3ff0e65 = 0.7.54 (profile `never_automate_hosts`) · remote#10 7f98d7b = 0.3.1 (watcher refuses never-automate hosts before scrubbing; needs Braden, three lines) · skills#18 125a4c3 = 0.8.0 (`almanac.validate --profile` refuses skill files naming a listed host) · agent-amber#3 e3d5ee4 = 0.2.0 (Amber's profile, pins, vendored 0.7.54 wheel; needs Braden, three lines). oasis: T76 + T76a contracts (coordination/t76/), decisions #331–#333, lesson #292, s64 metrics rows, mac-checks rows 0.7.53/0.7.54.
- **In flight (s65 integrates first, see TASK.md):** t76a-build (haiku, worktrees/skills-t76a → skills 0.9.0, needs Braden). Installer job on desktop-app main blocked on Braden's token (403).
- **Worker routing:** every Claude model except haiku is at the weekly limit until 2026-10-02 23:00Z; haiku carried the whole T76 build with a §-numbered contract and one resume per job for a missed rule (IP literals). Stamp agent-log rows with `date -u` (lesson #292: this seat's hand-typed times drifted 65 min).
- **Waiting on Braden:** installer token (org PAT approval or classic `repo` PAT); rig restart onto 3ff0e65 + install OASIS-0a7e8f8.app; #333 picks at the T76a PR; T61b cap; OASIS_SERVICE_TOKEN question; plus the older list.
- **Spend:** seat ≈ $23.5 estimated; Agent tool ≈ 1.05M tokens (haiku ≈ 760k); DeepSeek/Codex/API $0. Speed s64: idle 0.0 min · parallel 5.07 (tool; ≈3 hand) · wall per merged PR ≈ 17 min avg (estimated, clock-corrected rows).

---

# Session 63 (Claude seat, Fable 5.1) — handoff 2026-09-30 ~20:35Z → session 64 (16 build dispatches, #282)
- **Two seats alive (lesson #290):** s62 (`oasis-67`) was still running at boot; split by message; it committed t69 + batch X and closed ~19:00Z. Boot rule for s64: `ListAgents` first.
- **Done (all merged):** agent-core#88 T64 84bf269 = 0.7.50 (remote 0.3.0 pin as its own commit) · agent-core#89 T69 96d4a65 = 0.7.51 (needs Braden, three lines sent) · agent-core#90 T61b failed_at_cap report f1ac0f8 = 0.7.52 · desktop-app#62 T74 (c)+(d) 4f3d09d = 0.2.0 (needs Braden, three lines sent; Windows installer CI job, app starts/stops the service) · desktop-app#63 T74 (e) 55ef498 (launch/stop test) · project-swarm#72 batch X b0b4e17 = **1.39.0, installed** (lessons 281–288 shipped; E2 promoted #327). oasis: decisions #325–#330, ticket T76, lessons #290–#291 queued (+#289 repeat), session_metrics parallel fix, E2 result, mac-checks rows 0.7.50–0.7.52, windows-checks.md, README Mac column.
- **In flight (s64 integrates first, see TASK.md):** agent-core#91 T74 (a) 0.7.53 (needs Braden; windows test leg re-run at 20:31Z after two loop-timeout flakes; log worktrees/agent-core-t74a-rerun.log) · T73 hindsight scout (fable, read-only → coordination/research/t73-hindsight-scout.md; Agent-tool row open) · desktop-app main installer job blocked on Braden's token (403 on the agent-core checkout).
- **Worker routing:** Claude CLI plan, Agent-tool sonnet and opus all 429 until 2026-10-02 23:00Z; `model: fable` answers; Codex for JS/Rust only.
- **Waiting on Braden:** fix AGENT_CORE_READ_TOKEN access to agent-core, then the installer job re-runs; rig restart onto the newest main (covers 0.7.49–0.7.53) + install OASIS-0a7e8f8.app; T61b cap decision; OASIS_SERVICE_TOKEN env-var question (T74 (a) open); drop coordination/references/amber-tools.md for T76; plus Otis pick, Sonnet 5.5 message, s57 chat files, credential rotation, Fable cache-write price.
- **Spend:** seat ≈ $27.55 estimated; Claude CLI workers $0; Agent tool ≈ 1.35M tokens (fable ≈ 1.0M); DeepSeek $0; Codex $0. Speed s63: idle 0.0 min · parallel 6.36 (tool; ≈2.5 hand) · wall per merged PR 64 min avg.

---

# Session 62 (Claude seat, Fable 5.1) — handoff 2026-09-30 ~18:30Z → session 63 (15 build dispatches, #282)
- **Done (all merged):** packs FAIL fixed — agent-core#86 233b559 = 0.7.48 (real-bundled-pack route test) · desktop-app#61 0a7e8f8 (CSP `blob:` + real-capture test; OASIS-0a7e8f8.app built, CSP verified, install pending) · remote#9 56bd543 = 0.3.0 (T64 slices 2–3, Windows fix) — three lines sent for each. E2 candidate built (fixture 3 → 1, 1156 green, mutants 3/3; c910bf6 unpushed). T74 contract. Decisions #321–#324; lessons #286–#289 queued; mac-checks rows 'Packs CSP fix', 'Rig 0.7.48'.
- **In flight (next seat integrates first, see TASK.md):** cap-pr payload → ship 0.7.49 (worktrees/agent-core-t61bcap) · t69 (Agent tool, worktrees/agent-core-t69) · x1 batch X (Agent tool, worktrees/swarm-x). Agent-tool results land only in this chat; if it is gone, read each worktree's git status/diff.
- **Worker outage:** Claude CLI plan weekly limit until 2026-10-02 23:00Z; routing in TASK.md.
- **T61b:** dev runs on claude-sonnet-5-5 failed at $2 and again at $4 (no report on breach); Braden decides the cap; the runner needs a `failed_at_cap` partial report first.
- **#324 trial report so far:** no file collision, no conflict, no refusal (cap branch rebased clean onto 233b559; T69 still building; T69's rebase after the cap merge is the likely CHANGELOG touch point).
- **Waiting on Braden:** install OASIS-0a7e8f8.app + rig restart onto 233b559; T61b cap decision; Otis pick; Sonnet 5.5 chat message; s57 chat files; credential rotation; Fable cache-write price.
- **Spend:** seat ≈ $27.84 estimated; Claude workers $6.44; Agent tool ≈ 660k tokens + 2 running; DeepSeek ≈ $0.03; Codex $0; Anthropic API $5.94. Speed s62: idle 0.0 min · parallel 7.37 (inflated, see swarm-metrics) · wall per merged PR 44.4 min avg.

---

# Session 61 (Claude seat, Fable 5.1) — handoff 2026-09-30 ~17:00Z → session 62
- **Done (all merged):** agent-core#85 e75b3eb = 0.7.47 (needs Braden; 3042 pass; mutants 4/4; three lines sent) · desktop-app#60 a862fbd T301 desktop half (needs Braden; mutants 3/3; jsdom Blob test fixed per #203 in two steps; three lines sent) · remote 24d7405 watcher.md links the T64 PNG · project-swarm#71 7ce56fb = 1.38.0 (lessons 262, 264–267, 273–280; public lessons 171–183 approved #318) INSTALLED · oasis: docs/diagrams/ PNG+HTML+JSON with the two label fixes and chrome-free export (#313), decisions #312–#320, tickets T74/T75, lessons #283–#285 queued for batch X, experiment E2 proposed, mac-checks rows 'Rig 0.7.47' + 'T301 desktop', OASIS.app built worktrees/builds/OASIS-a862fbd.app (16:47Z, #128 waived #320, not installed).
- **In flight:** nothing. No run to integrate.
- **Waiting on Braden:** install OASIS-a862fbd.app and restart the rig onto e75b3eb (then tick the two mac-checks rows); his one chat message on Sonnet 5.5 (route live since 15:13Z; append to coordination/model-verification.jsonl); typed yes for E2 ($8 cap); the two chat files with a credential-word line (s57); rotate the credential seen in the Teams summary; real Fable 5.1 cache-write price.
- **Spend:** 09-30 UTC workers ≈ $151 of the $150 cap (#298) — no new paid dispatch before 00:00Z 10-01 without his yes; seat s61 ≈ $26 estimated (seat_cost.py). Speed s61: idle 9.7 min (all inside the ship-guard loop, #284), parallel 1.79, wall per merged PR 47 min avg (5 / 65 / 72).
- **Swarm notes:** export SWARM_INSTALL_ROOT=$HOME/.swarm-scratch before every swarm command; skill checks are enforced (#314): declare every resultKey the outputs' skills require in the prompt's JSON shape or integrate refuses after the money is spent; #203 never exclude a test at ship; DeepSeek jobs write rows to a declared output file, prompts short (#285); ship guards fire one at a time — run the private-names, private-term and git-ignored-fixture scans yourself before the first ship of a public branch until E2 lands; a squash re-applies `git diff <merge-base>..HEAD` onto the current main, never reset --soft (lesson 180/#284); Rust for app builds lives under ~/.project-swarm/toolchains/rust.

---

# Session 60 (Claude seat, Fable 5.1) — handoff 2026-09-30 ~15:30Z → session 61

- **Notice to Codex seat:** desktop-app main moved twice (#58 flake fix 4530505, #59 packs fix f92105c; each ONE top-of-`## Unreleased` CHANGELOG line). Branch `t301-send-account-card` (in flight) will add one more CHANGELOG line and edits `src/lib/serviceClient.ts`, `src/components/PreviewCard.tsx`, `src/styles.css` (none are splash paths). Expect a one-line CHANGELOG rebase for T31. A later one-liner will touch `src/components/Settings.tsx` (current-coworker thumb for service-bundled packs) — will be announced here first.
- **Swarm gotchas this session:** export `SWARM_INSTALL_ROOT=$HOME/.swarm-scratch` before every swarm command (lesson #280, fixed in batch W → 1.38.0); untracked resources go under `~/.project-swarm/toolchains/<name>/` (lesson #281: t71 + archify first runs were blocked); company-data jobs: forbid printing source files, delete the run's `provider.jsonl` after integrate (lesson #282). Skill frontmatter must be single-line `description:` (the indexer rejects folded YAML).
- **Done (all merged):** desktop-app#58 4530505 · desktop-app#59 f92105c (needs Braden; 3 lines sent) · agent-core#84 c2148c5 = 0.7.46 T301 rig half (needs Braden; 3 lines sent; mutants 9/9; ws tests) · oasis commits cf75437, 02486cd, 38eb2ed, 16dd53d (T72 skills + CREDITS, code graph, seat_cost tool, diagrams, decisions #303–#311, lessons #280–#282). T71 report local only (~/Documents/oasis-test-pdfs/t71-report.md). OASIS.app built: worktrees/builds/OASIS-f92105c.app (not installed). Chat route = Sonnet 5.5 since 15:13Z (#305) — Braden's confirming message not yet seen; Haiku backup profile.yaml.bak-s60-haiku-20260930T151323Z.
- **In flight (root · manifest · run id · log) — first hand step of s61: inspect → integrate → checks each:**
  - **t301d** worktrees/desktop-app-t301 · .swarm-manifests/t301d.json · 1790781519841-68b63842 · worktrees/desktop-t301d-run.log (needs Braden; PNGs to Braden #293; PR payload .swarm-manifests/t301d-pr-create.json; ship held → merge by hand → 3 lines → mac-checks row).
  - **packfix-a** worktrees/agent-core-packfix · .swarm-manifests/packfix-a.json · 1790781546696-a85cd183 · worktrees/agent-core-packfix-run.log (0.7.47; needs Braden; then add **#311** Teams-draft wording on the same branch with one small job before ship — pointers in TASK.md; mutants file .swarm-manifests/packfix-mutants.json; PR payload packfix-pr-create.json).
  - **w1b** worktrees/swarm-w · .swarm-manifests/w1b.json · 1790781799043-ddeb4376 · worktrees/swarm-w1b-run.log (batch W part 2 + release 1.38.0; part 1 committed 27d83e3; real npm test of part 1 has failures in 4 files — see TASK.md item 3 → w1c follow-up; then ship, `swarm update --yes`, mark lessons shipped).
  - Waiters: three harness-tracked `while pgrep` loops were started at 15:28Z; if this chat is gone they are too — just `inspect` the run ids.
- **Waiting on Braden:** Sonnet 5.5 confirm message; rig restart onto c2148c5 (then 0.7.47 later; one restart can cover both); install + re-check OASIS-f92105c.app rows; #302 done (A); real Fable 5.1 cache-write price.
- **Spend 09-30 UTC:** workers ≈ $135–140 of $150 incl. the three in-flight (#298); **$60 cap from 00:00Z 10-01**. Seat s60 ≈ $16 at 15:17Z (final in swarm-metrics at close).

---

# Notice to the Codex seat — 2026-09-29 ~22:00Z (decision #288, Braden typed confirm; written by the Claude seat as a one-time exception)

- **desktop-app is now split.** You keep T31 files only: `src/splash/**`, `src/splashGate.tsx`, `src/components/SplashSoundControl.tsx`, `src/lib/splashPrefs.ts`, `src/lib/splashSound.ts`, `tests/splash*.test.tsx`, splash assets/video. The Claude seat will take other desktop-app tickets (T47 item 5 check-pins CI, T63 Suggestion card, T49 orb hover) on their own branches off `main`, rebased before ship, never touching your splash paths.
- Your WIP (worktrees/desktop-app-t31, desktop-app-t31-audio) also edits `src/main.tsx`, `src/components/Settings.tsx`, `src/styles/primitives.css`, `tests/Settings.test.tsx`, `CHANGELOG.md`. The Claude seat avoids those where it can; if one of its jobs must edit one, it will say so here first. Expect to rebase T31 onto whatever merges.
- **Claude seat, 2026-09-30 ~01:50Z:** T49 orb hover (branch `t49-orb-hover`) adds ONE top-of-`## Unreleased` line to `CHANGELOG.md` and edits `src/orb/OrbApp.tsx`, `src/orb/orb.css`, `src-tauri/src/lib.rs`, `src-tauri/src/logic.rs` (none are splash paths). Expect a one-line CHANGELOG rebase for T31.
- **Claude seat, in flight:** T47 item 5 on branch `t47-check-pins` (worktrees/desktop-app-t47pins) edits `.github/workflows/ci.yml` + one `## Unreleased` line in `CHANGELOG.md` (shared with T31; a one-line top-of-section add).

---

# Current priority — 2026-09-28, handoff for next session

1. Complete #183 and ship project-swarm **1.24.0** through the branch's own `swarm ship` workflow. **Nothing else starts before 1.24 ships.** No #185 or other build ticket has started.
2. T31 pilot `round4/07-cinematic-pilot-fixed.mp4` is independently verified and opened in QuickTime: H.264, 1920×1080, 24 fps, 5.75 s, **5,207,431 bytes**; final 100 ms is silent; eased ending holds; raw source SHA-256 `08a97cf65feb93fbdfb497994c16ec8da7b36f2a1ff43d97f6f4516b9068b690` unchanged. No new credits. Full visor/arrival cuts and separate cues remain queued by priority.
3. #183 native Codex shell worker `/root/swarm183_shell` is active in isolated writable checkout `worktrees/swarm-183-codex-native`; source `project-swarm-lessons177` at dabe6bb remains untouched apart from transient manifest. Parent approved ownership of `tests/field-lessons-batch-f.test.mjs` solely to add the missing stale-lock fixture while retaining the refusal assertion. Worker is saving `coordination/swarm-183-progress.json` and `coordination/swarm-183-result.json` in its isolated checkout. No tests or results are claimed yet.
4. CLI failure `1790610131553-1a00919e` remains documented in `coordination/swarm-183-cli-failure.md`; its cause is unknown. Resume: wait for/recover native outputs, read progress/result and live git state, review exact diff/base hashes, safely integrate to the original branch, run parent-owned full checks and real stale-lock negative, show generic public lesson 85 to Braden, commit only reviewed files, then use branch `swarm ship` with absolute PR payload and logged fixture exemption. Verify green CI/merge; update installed swarm with no active jobs and verify 1.24. Nothing has shipped yet.

---

# HANDOFF.md — 2026-09-28, T31 native-audio pilot complete

- **Latest:** Braden said “continue” after the three proofs/review question: look accepted, continuity/video/audio/build continuation authorized. No repeated creative approval ask. Final Mac check still applies.
- **Bounded artjob complete:** approved80-credit batch spent66.5exact (6.5referenceedit+60native-audiovideo),13.5unused, no purchases. `round4/04-continuity-reveal.png`, `05-cinematic-pilot.mp4` raw13.08MBHEVC, and free `06-cinematic-review-h264.mp4`6.06MBH264 saved, with proofcopies under avatars/t31-round4. Sixdecodedframes + metadata/audiolevelsevidence inround4. Goodvehicle/roadcontinuity and ringreveal; overtakeweak, endstillmoving. AACnonzero, tailnotsilent; musicqualityrequireslistening. Parent openedrawpilotQuickTime and04Preview. No productmediareplacement/install.
- **Next:** parent completes editorial/fullcuework and validates final8sentry, sizecap and soundeverylaunch+visiblemute onMac. Existing look approval stands; no paidvariants planned. See production-record.md for sourceIDs/prompts/actualcharges/limits.

- **Audio build:** parent reports additive audio-only patch integrated into canonical desktop-app-t31 after baseline14 hashes unchanged and patch check. Independent104 focused tests/build/type/lint/diff passed; postintegration checks now passed:104tests/4files, build includingtypes, lint0errors/2 inheritedwarnings, diffcheck. Fitted original cues still missing, baseline avatar Blob.arrayBuffer full-suite failure, Cargo unavailable, Mac audible autoplay not yet verified.


## Claude orchestrator seat — end of session 59 (2026-09-30 ~05:10Z; Braden said keep going past 120k; ~31 build dispatches)
- Done: agent-core 0.7.41 (#79) → 0.7.45 (#83) merged, all needs-Braden three lines sent; remote#7 0.2.0; desktop-app#55 T49 + #56 T49b (six companion styles, Braden: keep all, user picks); project-swarm#65 1.37.0 merged + tagged (public lessons 165–170 approved); Sonnet 5.5 verified on 0.7.43; decisions #292–#300; lessons #263r, #269–#279 (#263r, #268–#272 shipped 1.37.0).
- In flight: nothing. desktop-app#57 T63 Suggestion card merged.
- Next (this seat): install swarm 1.37.0 → desktop-app Onboarding flake fix → Sonnet route switch after Braden's restart onto 0cc3263 → T61b dev re-run → T69 → batch W. Spend check script: `python3 - <<'EOF'` summing `worktrees/*/.swarm/runs/*/state.json` jobs[].costUsd for run ids (ms prefix) ≥ today 00:00Z. See TASK.md top.

## Claude orchestrator seat — end of session 58 (2026-09-29 ~23:12Z, 3/15 build dispatches; handoff on 120k context, #282)
- Done: decisions #290/#291; OASIS.app built from desktop-app 11bd996 → worktrees/builds/OASIS-11bd996.app (not installed); playbooks#17 0.5.3 merged a225198 (8 More motion packs, manifest.yaml + sheet.png only); agent-core vendor commit b8303ed green (branch playbooks-053-vendor); swarm 1.36.0 installed; lesson #268.
- In flight: **pb053ac** (worktrees/agent-core-pb053, loader + 0.7.41) — next seat integrates first; **fixb2 complete, not integrated** (worktrees/agent-core-t61b-fixa) → becomes 0.7.42.
- Next (this seat): ship 0.7.41 needs Braden → report build path + merge shas to Braden → fixb2 integrate → 0.7.42 → T68 0.7.43 → Sonnet verify → T70. Start a desktop ticket (T63 card / T49) on any agent-core wait. See TASK.md top.

## Claude orchestrator seat — end of session 57 (2026-09-29 ~22:35Z, 12/15 build dispatches; handoff on 120k context, #282)
- Done: skills#17 0.7.1; project-swarm#64 1.36.0 (not installed yet); Fix A cc8048f verified; rig outage: claude-sonnet-5-5 streams `usage.output_tokens_details` → Decoder "unsupported billed usage" (capture coordination/sonnet55-stream-capture.sse) → Haiku route restored 21:49:50Z, rig restarted 22:12Z (pid 46961); decisions #287 (route change needs a real message), #288 (desktop split), #289 (credential mask); tickets T68–T70. Credential scan (names/counts only): no credential-shaped value stored; chats/a6ee3143f0b44f03b15feb49c1572af8.jsonl and chats/c722bc0f1142466698ff3b2ebbebb4f7.jsonl each hold one line with a credential word → Braden checks.
- In flight: **fixb2** run 1790721198861-694c4cb7 (worktrees/agent-core-t61b-fixa) — next seat integrates first; desktop-app#54 ship (confirm merged).
- Next (this seat): Braden's playbooks 0.5.2 vendor + OASIS.app build (ask the version-order question first) → fixb2 → 0.7.41 → T68 0.7.42 → Sonnet verify → T70. See TASK.md top.

## Claude orchestrator seat — end of session 56 (2026-09-29 ~21:25Z, 8/15 build dispatches; handoff on 120k context, #282)
- Done: swarm 1.34.0 installed; project-swarm#63 1.35.0 (T52b) merged; connectors#21 0.5.4 + agent-core#78 0.7.40 merged (nextLink host check, needs Braden, three lines sent); batch U built + squashed (78a9e03, waits on public-lesson OK); AgentDojo text vendored (skills 30afb12, local); profile → Sonnet 5.5 chat / Haiku small (#286); decisions #285–#286; lessons #259–#265.
- In flight: **fixa** run 1790716133027-2bd1811d in worktrees/agent-core-t61b-fixa (T61b Fix A fail-closed gate) — next seat integrates it first.
- Next (this seat): Fix A integrate/check/mutants → Fix B (coordination/t61b-fixb-contract.md) → 0.7.41 needs-Braden PR → dev re-run on claude-sonnet-5-5; batch U ship on Braden's OK → install 1.35/1.36. See TASK.md top.

## Claude orchestrator seat — end of session 55 (2026-09-29 ~20:10Z, 13/15 build dispatches; handoff on 120k context, #282)
- Done: project-swarm#60 1.33.0 + #61 1.34.0 merged (1.33.0 installed); agent-core#77 T63 0.7.39 merged (vendor + T63 as two commits; needs Braden; three lines were NOT sent in s55, the record was wrong; sent s56); decisions #281–#284; lessons #249–#258; Playwright copied into toolchains.
- In flight: nothing running. T52b local only (worktrees/swarm-t52b); PR #62 closed + remote branch deleted after the private-term push (lesson #258).
- Next (this seat): install 1.34.0; T52b re-ship from one squashed clean commit after the one CI fix → 1.35.0; batch U (#256–#258); Braden's Mac checks incl. T63. See TASK.md top.

## Claude orchestrator seat — end of session 54 (2026-09-29 14:32Z, 10/10 build dispatches)
- Done: project-swarm#59 1.32.0 merged + installed; rig restarted onto bdaf31a (Braden asked); agent-core#76 T67 0.7.38 merged (needs Braden, three lines sent); connectors#20 0.5.3 merged (T63 reads); decisions #277–#280; tickets T63 design + T67; lessons #244–#248.
- In flight: t63 (file-only sonnet, worktrees/agent-core-t63) and s1c (file-only sonnet, worktrees/swarm-s). Claude shell workers fail with 503 since ~14:15Z.
- Next (this seat): integrate + check + ship T63 (0.7.39) and batch S (1.33.0, public lessons to Braden first); Braden's Mac checks incl. T67. See TASK.md top.

## Claude orchestrator seat — end of session 53 (2026-09-29 12:16Z, 3/10 build dispatches, handoff: done-when met except Braden's Mac checks; next is a new topic)
- Done: agent-core#74 T65 0.7.36 merged; agent-core#75 T61b PR B 0.7.37 merged (needs Braden, three lines sent; review caught the cap checked once per case → t61b2-cap fix, per-call cap); project-swarm#58 1.31.0 batch Q merged + installed (lessons #239–#241 shipped, #238 partial); public lessons 140–143 approved; lessons #242, #243 queued.
- In flight: nothing running.
- Next (this seat): Braden restarts onto bdaf31a → mac-checks T66 re-check / T61b part 1 / T65 / T61b part 2; batch R swarm PR (#238 remainder, #242, #243); T61b live dev run only on Braden's typed yes + key. See TASK.md top.

## Claude orchestrator seat — end of session 52 (2026-09-29 04:30Z, 10/10 build dispatches)
- Done: swarm 1.30.0 shipped + installed (project-swarm#57); agent-core#72 T66b 0.7.34 + #73 T61b part 1 0.7.35 merged; skills#16 0.7.0 merged; T61b part 2 contract + decisions #274–#276; lessons #237–#241.
- In flight: agent-core#74 T65 0.7.36 (Windows CI rerun); t61b2-runner (T61b PR B, worktrees/agent-core-t61b2).
- Next (this seat): merge #74 → PR B integrate/mutants/rebase 0.7.37/ship → Braden restart + Mac checks → batch Q. See TASK.md top.

## Claude orchestrator seat — end of session 51 (2026-09-29 02:50Z, 10/10 build dispatches)
- Done: T62 **pass**; agent-core#71 T66 0.7.33 merged (needs Braden, three lines sent); playbooks#16 0.5.2; 8 More motion packs (52/57); project-swarm#55/#56 1.29.0 tagged; decisions #271–#273; T65/T66/T66b; lessons #228–#236; art-job worker skill.
- In flight: T66b ship (branch t66b-scoreboard-local-day, 0.7.34). T61b part 1 built + verified (c217d4f), waits to rebase onto T66b as 0.7.35.
- Next (this seat): install swarm 1.29 → T66b merge → T61b part 1 rebase/ship → Braden restarts → T66 Mac re-check → T61b part 2 contract → batch P. See TASK.md top.

## Claude orchestrator seat — end of session 50 (2026-09-29 00:16Z, 8/10 build dispatches, handoff on topic switch to T61b)
- Done: remote#6 T64 design; agent-core#69 0.7.32 T62 (+ Windows fix); agent-core#70 #216 lint; skills#15 0.6.0 T61 (fixture-wiring only); project-swarm#53 1.27.0 + #54 1.28.0, 1.28 installed, skills.dir set; decisions #268–#270; T61b filed; lessons #219–#227.
- In flight: nothing running.
- Next (this seat): T61b ask → contract → build (stop before any real model key); batch O swarm PR. See TASK.md top.

## Claude orchestrator seat — end of session 49 (2026-09-28 22:50Z, 10/10 build dispatches)
- Done: agent-core#68 0.7.31 merged (needs Braden; rig NOT restarted, mac-checks "T48 re-check"); project-swarm#51 1.26.0 + #52 1.26.1 merged (private-name scrub, config outside the install, privateNames via config); worker skills built (branch swarm-1.27-skills, waits for #259 review); T58–T60 research; decisions #266–#267; T62–T64 filed; lessons #214–#218.
- In flight: t62-build (worktrees/agent-core-t62).
- Next (this seat): T62 integrate → mutants → ship 0.7.32; install 1.26.1 after T62; 1.27 on Braden's OK; batch N lessons PR. See TASK.md top.

## Claude orchestrator seat — end of session 48 (2026-09-28 21:48Z, 10/10 build dispatches)
- Done: T52 GO + T52b filed; T53 picks (#261) → pins.md; T54 sound, T55 signing (#264), T56 injection (→ T61, #265), T57 vector store research; batch M integrated (b3ba622, 11 red); T48 fixes 1–4 integrated (4041f80, 4 red); decisions #260–#265 (Windows primary #263); lessons #210–#212; mac-checks T48 FAIL recorded.
- In flight: m4-followup (worktrees/swarm-126), t48m-c (worktrees/agent-core-t48m).
- Next (this seat): t48m-c → full suite → mutants → ship 0.7.31 (needs Braden, merge #125, 3 lines); m4 → 1.26 green → config.json before install → public lessons to Braden → skills job (#259 gate); then T58–T60. See TASK.md top.

## Claude orchestrator seat — end of session 47 (2026-09-28 20:50Z, 9/10 build dispatches, handoff on topic switch to T52)
- Done: **agent-core#67 T48 0.7.30 merged** (38482b9; needs-Braden: recent_mail is a read; 16/16 mutants; rig NOT restarted, Braden restarts, mac-checks row T48). **check-pins CI job merged in 6 repos** (agent-amber#2, agent-michael#2, remote#5, rag-pipeline#2, skills#14, playbooks#15). **T51a done** (remote Windows flakeRate 0.00). Swarm 1.26 batch L WIP ce2ec9f. Node 24 + orb deps + Chromium in isolated toolchains (#249). Worker skill coordination/skills/threejs-worker (#256–#259). Decisions #245–#259, tickets T52–T60, lessons #203–#209.
- In flight: nothing running.
- Next (this seat): T52 orb scout = dispatch 1; swarm 1.26 batch M, then the worker-skills job (review gate #259) → ship → install; T53, then T54–T60 scouts. Bookkeeping on DeepSeek (#226/#254). See TASK.md top.

## Claude orchestrator seat — end of session 46 (2026-09-28 19:25Z, 10/10 build dispatches)
- Done: connectors#19 0.5.2; project-swarm#50 1.25.0 merged + tagged + installed; T51 baseline + T51a/T51b tickets; RDW-Labz/oasis (private, whole workspace); README front door; decisions #240–#244; lessons #198–#202.
- In flight: t48-fix6 (sonnet shell) in worktrees/agent-core-t48 — 6 red tests after the salvaged T48 work.
- Next (this seat): T48 agent-core integrate → full suite → mutants → ship 0.7.30; check-pins CI PRs (T47 item 5); T51a; swarm 1.26. See TASK.md top.

## Claude orchestrator seat — end of session 45 (2026-09-28 18:12Z, 10/10 build dispatches)
- Done: agent-core#66 T47 merged + rig restarted (Braden asked) + Mac check PASS; decisions #234–#239; T51 filed; lessons #195–#197; license verify.
- In flight: nothing running. Swarm 1.25 is at WIP 4a2806e (5 red tests, one-line fix; public lessons are waiting for Braden's approval). T48 connectors is at WIP 39735d0 (1 stale test).
- Next (this seat): 1.25 fix → approval → ship → install; connectors 0.5.2 fix → ship; T48 agent-core; T47 item 5 CI PRs; T51 baseline. See TASK.md top.

## Claude orchestrator seat — end of session 44 (2026-09-28 16:37Z, 6/10 build dispatches)
- Done: #183 recovered + **project-swarm 1.24.0 (#48) and 1.24.1 (#49, web tools on) merged, tagged, installed**. CI fixes #189–#191. T47 wheels merged: connectors#18, skills#13, playbooks#14; palettes playbooks#13. Research: #231 model routing; ThreeUI (DarkSoulsHoloCard at /hero/); Three.js shortlist (coordination/research/threejs-shortlist.md, sent to Braden). Tickets: T49 spec filed (#233), T50 clean-room (#232). Lessons #186–#194. Metrics row s44.
- In flight: nothing.
- Next (this seat): T47 agent-core job (TASK.md top item 1) → T49 after T31 → T50 → T48 → swarm 1.25. T31 stays with the Codex seat.

## Claude orchestrator seat — end of session 43 (2026-09-28 14:58Z, 10/10)
- Done: 1.23.0 installed; desktop-app#53 merged (Lantern lamp); OASIS.app b7d43e1 installed + rig-service 0.7.28 (Braden asked); T47 wheels built + verified (connectors 0.5.1, skills 0.2.1.post1, playbooks 0.2.4; release/0.2 on origin); OpenRouter adapter hand-built + live (#226–#228); tickets T47, T48; decisions #203–#228; lessons #181–#184; metrics row s43.
- In flight: swarm-183 on OpenRouter Sonnet 5 (project-swarm-lessons177, `swarm inspect` latest run).
- Next (this seat): 1.24 ship → install → palettes + T47 ships → T47 agent-core; motion clip recovery by hand (#228b). T31 left to the Codex seat. See TASK.md top.

## Prior direction/proof record
## Done
- Revised current task recorded above historical TASK.md. Read AGENTS.md, PLAN.md, TICKETS.md, ORCHESTRATOR.md and T31 decisions #202/#208/#209/#220. No conflict in this bounded T31 direction scope; T40 remains Phase 4.
- Inspected round-3 timeline and three full stills; read spec (local video not watched). Provisional round-4 direction and synchronized sound/music cue sheet: `coordination/references/t31-splash/round4/direction.md`. Parent supplied reviewed Higgsfield frame samples and creator-report links, clearly labeled in the file.
- Proposed 8 s rendered sequence: visor threshold → motorcycle passes sports car → immense inhabited-ring reveal → title/Enter hold → 1.5 s load-in + 1 s Home dissolve. Original art and sound; no generation, source edits, purchases or credentials in this pass. Braden confirmed sound on every launch with a visible mute button; full and 2 s daily cut each get a fitted cue, and mute silences music plus FX immediately.
- **Follow-up proof job complete:** three original GPT Image 2 High 2688×1520 PNGs saved and inspected at `coordination/references/avatars/t31-round4/{01-pass,02-reveal,03-title-background}.png`. Live RDW Labz selection verified; usage confirms 3 × 6.5 = **19.5 credits spent**, below 20 cap. No purchases, video/audio generation or source edits. `coordination/references/t31-splash/round4/generation-record.md` records prompts/media filenames and honest continuity limits. Existing draft wording/paragraph structure and settings restored; exact whitespace bytes not proven.
## In flight
- Parent owns presentation/research/orchestration. This direction worker owns only TASK.md, HANDOFF.md top and round4/direction.md. Unrelated jobs were not stopped. Earlier recorded job statuses below are historical and require live verification.
## Next
- Look accepted by “continue”. Photographic materials/scale improved, but car shape, road/barrier design, ring and vehicle positions drift; derive locked references and matched endpoints under the next priced batch. Preserve prior assets/work. Sound every launch and visible mute are confirmed; no additional audio-default question needed.
- Parent's live check: desktop-app-t31 HEAD 87b326f has uncommitted splash code; preserve it, do not assume the old worker is active. Higgsfield OAuth succeeded and browser generation/download verified; native MCP tool exposure remains unverified. Official Cinema Studio docs establish native FX/music capability, not price or generated mix quality.
- Preserve the swarm 1.24, T23/motion and T47 → T48 queue below. No shipping or installation performed by this job.

---

# HANDOFF.md — 2026-09-28, session 43 (historical status)
## Done (s43)
- 1.23.0 installed. desktop-app#53 merged (Lantern lamp 0.1.1). T31 round 3 approved (#220). T47 connectors 0.5.1 built (a7124b8). All 8 palettes pass muted text. rig-service on 0.7.28 + OASIS.app b7d43e1 installed (Braden asked). Tickets T47, T48 written. Decisions #203–#221. Lessons #181, #182.
## In flight (TASK.md top)
- swarm 1.24 ship (branch tool, one logged exemption) · motion-12 (opus) · t47-playbooks-024 (sonnet) · t31-desktop (opus).
## Next
- 1.24 merge → install → mark 177–179/181 shipped → ship playbooks t23-palettes. T47: ship connectors 0.5.1 + playbooks 0.2.4 (create release/0.2 at ee94894) → agent-core job (declare wheels, guard, tests) → restart rig with one step. T48 after T47. T31 desktop verify → ship → rebuild app.

# HANDOFF.md — 2026-09-28, end of session 42 (10/10)
## Done (s42)
- T23 all code merged: agent-core#63 (0.7.27) + #64 (0.7.28 shadow mirror), playbooks#12 (0.5.0 checker + lantern), desktop-app#52. 8 palettes built + verified (9620404, not shipped; preview shown). OASIS.app rebuilt b7d43e1, Mac-check batch pinged (T23 + T46 rows). playbooks#11 (motion tool 0.4.1). agent-core#65 flaky tests. T31 round 1 storyboard (16 cr) → Braden picked A as bundled video (#202). Swarm 1.23 PR #47 open (Braden approved lessons); 1.24 built + verified. Lessons #176–#180. Metrics row s42 (idle 18.1, parallel 1.50).
## In flight (details in TASK.md top)
- project-swarm#47 merge-on-green (check state first) · t31-round2 (opus, art).
## Next
- Merge #47 → install 1.23 → ship 1.24 (drop .pr-body.md) → install. T31 round 2 → Braden. Ship palettes / Lantern lamp / 12 motion packs as Braden answers. Then T40.

# HANDOFF.md — 2026-09-28, session 42 (live)
## Done (s42)
- Pilot pets-01 verified (checks + validate_pack pass); questions to Braden (size, fps).
## In flight
- swarm-174-175 (sonnet) · t23-scout (swarm ask) · motion-pr-bump (haiku). See TASK.md top.
## Next
- Ship playbooks 0.4.1; T23 core then desktop; swarm 1.23 PR + install; other 12 motion packs after Braden answers.

# HANDOFF.md — 2026-09-28, end of session 41 (10/10)
## Done (s41)
- 44 standard packs verified (validate 44/44, max 108 KB), overviews shown. T46 all code merged (skills#10/#11, playbooks#10, agent-core#62, desktop-app#50). T25 desktop merged (#51) → T25 code done. playbooks#9 portrait_to_pack. T23 contract merged (skills#12). OASIS.app rebuilt 91a832a (not installed), mac-checks T25 + T46 rows. More motion priced 786.5/13. Lessons #174, #175 queued; #169 evidence extended. Metrics row s41 (idle 0.0, parallel 2.80).
## In flight (details in TASK.md top)
- motion-pilot (opus, playbooks-motion) · swarm-169-172 (sonnet) · t23-core (sonnet) · t23-desktop (opus). Check worktree commits first.
## Next
- Verify pilot → Braden → other 12 (one worker job). Ship T23 core then desktop; T23 playbooks checker + palettes. Swarm 1.23 ship (+#174/#175). Mac-check ping once the pilot is placed.

# HANDOFF.md — 2026-09-28, end of session 40 (10/10)
## Done (s40)
- T45 DONE: desktop-app#46/#47/#48 merged, app rebuilt (not installed), mac-checks 'T45'. T22 app halves: agent-core#61 (0.7.25) + desktop-app#49 merged. Swarm 1.22.0 shipped + installed (#44). rig-service restarted on 0.7.24 (Braden asked).
- Avatars: T46 ticket written; 96 portraits generated (408 cr), picker page live, Braden picked 57 (#198); T26 code-pack test approved (#200). Decisions #178–#200. Lessons #168–#173. Metrics row s40.
## In flight
- t26-code-packs-44 (sonnet) in worktrees/playbooks-t26-test — check its commits first (TASK.md top).
## Next
- Verify the 44 packs → show Braden overviews → playbooks PR. Then T46 contract → builds → price + generate 13 More motion packs. Signing key (#78) before any library release.

# HANDOFF.md — 2026-09-27, session 40 (live)
## Done (s40)
- desktop-app#46 slice 4 MERGED f6ea6d8; #47 slice 6 MERGED 3ea49a0. rig-service restarted on 0.7.24 (Braden asked). Decisions #178 (CSS 78/12), #179 (lessons OK).
- T45 DONE (#48 merged 3f263e6, app rebuilt not installed, mac-checks 'T45'). Swarm 1.22.0 shipped + installed. Decisions #178–#183.
- In flight: t22b-core (sonnet) + t22-desktop (opus) in parallel off progress-contract.md (+ amendments #184–#187).
## In flight
- t45s7-rest (opus), swarm-165-167 (sonnet), both Agent tool. #46 CI.
## Next
- #46 green → merge + 3 lines → slice 6 ship → slice 7 ship after t45s7-rest → rebuild (nightly gate) → mac-checks 'T45'. Swarm 1.22 → show public lessons → push/PR/merge → install.

# HANDOFF.md — 2026-09-27, end of session 39 (10/10)
## Done (s39)
- desktop-app#43 T45 slice 5 MERGED 266a3a1; desktop-app#44 slice 2 MERGED 52d8e61 (3 lines sent each). Survivor style tests killed all 7 (+2). Slices 3, 4, 6 rebased (stacked), verified, payloads filled. Braden's answers → decisions #169–#174; T22 provisional picks → #175. T22 fixed (8 failures, index-before-verify bug, hash pins, Windows fixes), M1–M8 8/8, agent-core#60 open. Swarm 1.21.0 SHIPPED (#43, 2e7c868) + installed. Decisions #176, #177. Lessons #165–#167. Metrics row s39.
## In flight (details in TASK.md top)
- desktop-app#45 slice 3 MERGED 997d74c (flake passed on re-run; still file a fix for the AppRail wait). agent-core#60 MERGED 17ff1f5. t45s7-copy DONE 28616cc (worker checks green; orchestrator re-run pending).
## Next
- Ship slice 4 → slice 6 (rebase --onto, one at a time) → slice 7. Merge #60 on green + 3 lines. Use 1.21.0 features (env.json, ship --branch).

# HANDOFF.md — 2026-09-27, session 39 (live)
## Done (s39)
- desktop-app#43 T45 slice 5 MERGED 266a3a1.
## In flight
- t45-survivor-tests, t22-fix, swarm 1.21.0 (lessons 158–164). All Agent tool.
## Next
- Survivors killed → rebase + ship slices 2, 3, 4, 6 one at a time → slice 7. T22 green → mutants M1–M8 → PR held for Braden's cryptography yes. Swarm PR → show public lessons → ship → install 1.21.0.

# HANDOFF.md — 2026-09-27, end of session 38 (10/10)
## Done (s38)
- desktop-app#42 T45 slice 1 MERGED cbfecc3 (8/8 mutants, 3 lines sent). T45 slices 2–6 built by Opus workers, rebased on cbfecc3, CHANGELOG lines + PR payloads + mutants in each worktree (2: 3/5, 3: 4/5, 4: 4/5, 5: 5/5, 6: 2/5). T22 agent-core: contract (docs/t22/core.md) + core build integrated (WIP 36730ac; 8 new tests failing). Lessons #160–#163. Metrics row s38.
## In flight (details in TASK.md top)
- desktop-app#43 (slice 5) open, CI running → merge by hand on green (auto-merge is off). Nightly 36348476333.
## Next
- One job: style tests for the 7 T45 survivors → ship slices 2, 3, 4, 6 one by one → slice 7. One job: fix T22's 8 failures + real-home test path → mutants → PR held for Braden's dependency yes. Swarm PR for lessons #158–#163.

# HANDOFF.md — 2026-09-27, session 38 (live)
## Done (s38)
- T45 slice 1 re-verified by orchestrator (all checks + harness green).
## In flight
- t45s1-prmut (haiku) → mutants → ship slice 1. t45-slice2, t45-slice3 (opus, Agent tool). t22-core-contract (opus CLI).
## Next
- Slice 1 merge + 3 lines → rebase slices 2/3 → PRs. Slice 4 (+6) when a slot frees. T22 core build (sonnet) after the contract.

# HANDOFF.md — 2026-09-27, end of session 37d (10/10)
## Done (s37d)
- skills#9 T33 PR C, agent-core#59 T33 demo → T33 code complete. project-swarm#42 1.20.0 merged + installed. T45 slice 1 built (Lantern, 985 tests). Mac row 'T33'. Lessons #158–#159. Metrics s37d.
## In flight (details in TASK.md top)
- T45 slice 1: verify → PR → ship. Nightly 36348476333.
## Next
- T45 slices 2–6 → passes + preflight. Next non-desktop ticket from TICKETS order.

# HANDOFF.md — 2026-09-27, end of session 37c (10/10; Braden asked for 10 more twice)
## Done (s37c)
- desktop-app#41 T29 desktop MERGED c5df95f (app rebuilt, mac row). agent-core#58 T33 PR B MERGED b59c393. T45 lead design done (pick: Lantern; #167). Swarm 1.20.0 code complete (611 pass). Lessons #156–#157. Metrics s37c.
## In flight (details in TASK.md top)
- t45-slice1 (Agent tool, opus) in desktop-app-t45. t33-skill (sonnet CLI) in skills-t33.
## Next
- T45 slice 1 verify → PR → slices 2–6 → passes + preflight. T33 PR C ship. Swarm 1.20.0: finish CHANGELOG/lessons → Braden OKs public text → ship → install.

# HANDOFF.md — 2026-09-27, end of session 37b (10/10 dispatches; Braden asked for 10 more, then handoff)
## Done (s37b)
- project-swarm#41 1.19.0 MERGED 8656ca5 + INSTALLED. connectors#17 T33 PR A MERGED 6358cf9. agent-core#57 T25 core MERGED f794c29 (nightly 36335496927 dispatched). 3 lines sent for each. Decisions #164 (T33 fakes now), #165 (T33 picks, provisional), #166 (T45 UI upgrade: after T29; T23/T31/T40 stay separate; Higgsfield existing credits; standing merge rules). Lessons #154, #155. Metrics row s37b.
## In flight (details in TASK.md top)
- T29 desktop: green, mutants 7/8 (double-send survived) → test or equivalence → ship.
- Swarm 1.20.0: context job done; checks / mutants / ship jobs next.
## Next
- T29 ship → T45 UI upgrade (own session). T33 PR B in agent-core alongside. Swarm 1.20.0.

# HANDOFF.md — 2026-09-27, end of session 37 (10/10 dispatches)
## Done (s37)
- T44 close-out: nightly green e0262b0 → app rebuilt → mac row. skills#8 T25 skills 0.3.2 MERGED 9dc7ff5. desktop-app#40 T28 desktop MERGED 7051240 (3 lines sent). App rebuilt 7051240. Mac ping sent (5 rows). #162/#163 provisional. Lesson #153. Metrics row s37.
## In flight (details in TASK.md top)
- t25-core-mutants (Agent tool) in agent-core-t25 at 1a050f1 (green). t29-desk-build (sonnet CLI) in desktop-app-t29.
- 1.19.0 waits on Braden's OK of lessons 40–46.
## Next
- T25 core: mutants → squash → ship → merge + 3 lines. T29 desktop: integrate → mutants → ship → merge → rebuild → mac row. 1.19.0 on OK → 1.20.0 lessons PR.

# HANDOFF.md — 2026-09-27, session 37 (live)
## Done (s37)
- skills#8 T25 skills 0.3.2 MERGED 9dc7ff5. T44: nightly green → app rebuilt 4f97cc4 → mac row 'T44'.
## In flight
- desktop-app#40 T28 MERGED 7051240; app rebuilt 7051240; mac rows T44+T28; Mac ping sent (once today). t25-core-tests (Agent tool). t29-desk-build (sonnet, desktop-app-t29; contract done, #163 provisional). t25-core build (sonnet, agent-core-t25; contract done, #162 provisional).
## Next
- T28: integrate → mutants → squash → ship → merge + 3 lines. T25 skills: integrate → PR → merge. Nightly green → rebuild → mac row 'T44'. 1.19.0 on OK.

# HANDOFF.md — 2026-09-27, end of session 36 (10/10 dispatches)
## Done (s36)
- agent-core#56 T44 0.7.20 MERGED e0262b0; desktop-app#39 T44 desktop MERGED 4f97cc4; 3 lines sent for both; merged lines added.
- T28 desktop built on worktrees/desktop-app-t28 (HEAD 54dc2f7, all checks green, card layout fixed). desktop-app#38 filed. Lessons #148–#152. Metrics row s36.
## In flight (details in TASK.md top)
- Nightly 36326723554 on e0262b0 = SUCCESS (T44 rebuild gate open). t28-desk-mutants DONE after handoff: stopped — tests/Settings.test.tsx T28 block flaky on HEAD (1–2 fail per run). Next: race fix job → 20× green → mutants.
- 1.19.0 push waits on Braden's OK of lessons 40–46.
## Next
- Rebuild app from desktop main 4f97cc4 → mac row 'T44'. T28: mutants → squash → ship → merge + 3 lines → rebuild → mac row 'T28'. 1.19.0 on OK → ship → install → 1.20.0 lessons PR. Then T29 desktop.

# HANDOFF.md — 2026-09-27, session 36 (live)
## Done (s36)
- agent-core T44 integrated + fixed, all green (WIP b0f7a38). Lesson #148 logged. desktop-app#38 filed (320px gap).
## In flight
- agent-core#56 ship4 (CI on 0062d77). desktop-app#39 MERGED 4f97cc4. t28-desk-card (sonnet) in desktop-app-t28. Lessons #148–#152 queued.
## Next
- core: integrate fix → mutants → ship → merge + 3 lines. desktop: payload → squash → ship → merge + 3 lines. Then nightly gate → rebuild → mac row. 1.19.0 on OK.

# HANDOFF.md — 2026-09-27, end of session 35 (10/10 dispatches)
## Done (s35)
- desktop-app#37 T43 card MERGED a6a1449; OASIS.app rebuilt from a6a1449 (not installed); mac-checks row 'T43 card'.
- connectors#16 T44 connectors 0.4.10 MERGED 0e77471 (orchestrator, #125). 3 lines sent in the s35 handoff message.
- Swarm 1.19.0 fully built + green (548 tests, 14/14 mutants, replay 4 pytest inside sandbox); squashed d289b2b, not pushed.
- Toolchains → ~/.project-swarm/toolchains (#158); skills formats.md edit dropped; #159 never block on Braden; lessons #146, #147; metrics row s35.
## In flight (details in TASK.md top)
- t44-core (sonnet) run 1790515305289-c270cd25 in worktrees/agent-core-t44. t44-harness-fix (Agent tool, opus) in worktrees/desktop-app-t44 (dies with the s35 chat).
- 1.19.0 push waits on Braden's OK of lessons 40–46.
## Next
- T44 agent-core: integrate → mutants → PR → merge. T44 desktop: harness fix → mutants → PR → merge → rebuild → mac row. 1.19.0 on OK → ship → install.

# HANDOFF.md — 2026-09-27, session 35 (live)
## Done (s35)
- Braden answers → #158; never-block rule → #159. Toolchains copied to ~/.project-swarm/toolchains + venvs repointed. skills formats.md edit dropped (already on main).
## In flight
- T43 card desktop-app#37 CI → merge (#125). 1.19.0: final-json-fix → mutants → PR. T44 connectors t44c-build. Details TASK.md top.
## Next
- 1.19.0 PR → merge → install. T43 rebuild + mac row. T44 agent-core half.

# HANDOFF.md — 2026-09-27, end of session 34 (10/10 dispatches)
## Done (s34)
- Pass 1 MERGED desktop-app#35 5b2839f (done-when met): artifact v2 (after shots, 5.5 → 7.5), harness per-worktree Vite port (#141, proof: shoot green with 24678 held).
- T42 desktop half MERGED desktop-app#36 5dd06f9 (measure-idle + sysinfo =0.39.6, battery stills animations, CI warning step; mutants 5/5). OASIS.app rebuilt from 5dd06f9 (not installed); mac-checks rows Pass 1 + T42.
- Swarm 1.19.0 built on project-swarm-shell (ports, setup/uv, loopback/.git) — 534/536; live sandbox test green twice; replays 1–2 green on integrate (replay 2: ruff/mypy ran inside the sandbox).
- E1 closed: inconclusive, not promoted. Lessons #142–#144 logged. Decisions #155–#157.
## In flight (details in TASK.md top)
- Replay 3 + live test (background, dies with chat); e1-rerun-fix (Agent tool).
## Next
- 1.19.0: replay 3 → mutants → PR (needs Braden) → merge + 3 lines → install. Ping Braden with the Mac-check batch. Then T43 desktop card.

# HANDOFF.md — 2026-09-27, end of session 33 (10/10 dispatches)
## Done (s33)
- agent-core#55 0.7.19 T42 agent-core half MERGED d2a7d8a (5/5 mutants). Pass 1: connect fix, round 2, CSS fold + tokens all green at bdfa379; 35/35 mutants; after shots taken.
- Swarm shell adapter built + verified on branch shell-worker b447c94 (decision #154 final). E1: harness fixed twice, first valid rows (c1 candidate green vs baseline red; c2 both red). Lessons #134–#141 logged.
## In flight (details in TASK.md top)
- pass1-score (opus) in desktop-app-pass1. Shell live test waits on Braden's keychain Allow (re-run next session).
## Next
Pass 1: integrate score → artifact → PR → ship → rebuild → mac-checks. Shell: live test → 2 replays vs Agent tool → 1.19.0 PR (needs Braden line) → merge + install. E1: c3, c4.

# HANDOFF.md — 2026-09-27, end of session 32 (10/10 dispatches)
## Done (s32)
- agent-core#54 0.7.18 T43 agent-core half MERGED cee4e5a (needs Braden → #125, 3 lines sent; 13/13 mutants). project-swarm#40 swarm 1.18.0 MERGED 9443509 (lessons 32–39 approved by Braden). Decisions #151–#153.
- Pass 1: fixes a/b/c + int-fix + stub integrated (WIP e64ca35); unit/type/lint green; 3 connect harness captures red.
- Swarm: rework metric in session_metrics.py (--rework-only): 66/191 integrates red (0.35), $213.69 on red runs. E1 approved ($40): replay harness coordination/tools/e1_replay.py (11 tests, output-leak fixed), 8 cases in coordination/e1-cases.json. Lessons #124–#133 logged.
## In flight (details in TASK.md top)
- pass1-connect Agent-tool worker (opus) in desktop-app-pass1 — uncommitted changes when done.
- t42-core (sonnet) in agent-core-t42. e1-selfcheck (sonnet) in project-swarm-e1.
- swarm 1.18.0 install waits for those runs to finish.
## Next
Pass 1: connect fix → mutants → round 2 → re-shoot → score → ship. T42 core: integrate → mutants → ship. E1: integrate candidate → replay c1–c6 (stop rule) → decide.

# HANDOFF.md — 2026-09-27, end of session 31 (3/10 dispatches; Braden asked for a handoff)
## Done (s31)
- agent-core#53 0.7.17 MERGED 95d855d (Windows test fix f481ae0). desktop-app#34 MERGED c286790.
- Pass 1: 199 before shots; Opus walk -> 74 flaws (scores 6.6 / 6.3 / 5.4); fix contract; page for Braden's notes https://claude.ai/artifact/AieDMxg2YF4aZNm17rUQde (db: notes, added).
- T43 agent-core: converter + wiring integrated, checks green (WIP 6987b1e). connectors 0.4.9 wheel reproducible (sha in TASK.md).
## In flight (details in TASK.md top)
- pass1-fix run 1790469984492-582c1c24 (3 opus) COMPLETE, not integrated (worktrees/desktop-app-pass1).
- swarm-118 COMPLETE, not integrated.
## Next
Pass 1: integrate fixes -> mutants -> Braden's notes round 2 -> re-shoot -> score in pass-1.md -> ship. T43: rebase -> vendor 0.4.9 + 0.7.18 bump -> mutants -> needs-Braden PR -> merge under #125. Swarm 1.18.0 PR.

# HANDOFF.md — 2026-09-27, end of session 30 (10/10 dispatches)
## Done (s30)
- project-swarm#39 swarm 1.17.0 MERGED + INSTALLED. desktop-app#33 T19 PR 5 MERGED 35f7c1a (T19 done); app built, not installed; mac-checks row added. connectors#15 T43 connectors 0.4.9 MERGED (needs Braden → #125, 3 lines sent).
- session_metrics.py counts still-running runs + Agent-tool log (#112). Decisions #148–#150. Lessons #121–#123 queued. Metrics row s30.
## In flight (details in TASK.md top)
- agent-core#53 0.7.17 plain words: CI failed on Windows only (one new test, private-append error) → one small fix job, re-ship.
- desktop-app#34 activity rows MERGED c286790.
- swarm 1.18.0 (#119–#123): swarm-118 done, not integrated (#121 root cause still open, context-check.mjs) → integrate → Braden OKs lessons text → PR → install.
## Next
T43 agent-core half (converter, instructions, injection cases; needs Braden) → T43 desktop card → Mac check. Then T42 → T28 desktop → T29 desktop …

# HANDOFF.md — 2026-09-26, end of session 29 (10/10 dispatches)
## Done (s29)
- desktop-app#32 T19 PR 4 MERGED 1dc9b85; OASIS.app built from 1dc9b85, not installed; mac-checks row added. agent-core#51 T29 0.7.15 MERGED 61456ce. Friday lines added.
- Decisions #145 (parallel ≥2.0, one guess max), #146 + #147 (PR 5). Lessons #114–#120 queued. Metrics row s29 added.
## In flight (details in TASK.md top)
- T19 PR 5: t19p5-fix1 (opus) run 1790463012404-2c29db90 → integrate --mutants → critique-2 → ship.
- agent-core 0.7.16 /scoreboard/latest: ship running (sb-route-ship.out).
- swarm 1.17.0: swarm-a + swarm-b run 1790461843662-797c48e3 → npm test → Braden reviews lessons.md text → PR → install.
## Next
Finish the three above. Then T43 → T42 → T28 desktop → T29 desktop … Braden's open items (a)–(e) in TASK.md.
## Worktree cleanup
agent-core-t29 (merged), desktop-app-t19-p4 (merged), + the s28 list below.

# HANDOFF.md — 2026-09-26, end of session 28 (9/10 dispatches)
## Done (s28)
- skills#7 MERGED 2e01f5e (T28 profile format 0.3.1). agent-core#50 MERGED d86cf87 (T28 0.7.14, #125 + 3 lines; rig-service held on 0.7.13). project-swarm#38 MERGED, swarm 1.16.0 installed; #103–#105 shipped.
- Decision #144 (T29: skill_finished push, skill feedback editable until next run of that skill, model-grouped notes under #73; swarm text OK).
- Lessons #109–#113 queued. Metrics row s28 added: idle 17.4 min · parallel 1.29 · skills#7 2 h 18 m, agent-core#50 3 h 13 m.
## In flight (details in TASK.md top)
- T19 PR 4: all green except harness connect-narrow (POST never fires after the click) → shell-capable fix job → critique-2 → ship.
- T29 agent-core: t29-build (sonnet) run 1790456040020-9e977154 running at handoff → integrate + uv sync + checks + mutants → ship.
## Next
Finish the two above. Then T19 PR 5 → T43 → T42 → T28 desktop → T29 desktop … Next swarm PR carries #106–#113.
## Worktree cleanup
agent-core-t28 (merged), skills-t28 (merged), ~/Documents/repos-projects/project-swarm-lessons103 (merged), desktop-app-t19-p3, + the s26 list below.

# HANDOFF.md — 2026-09-26, end of session 27 (10/10 dispatches)
## Done (s27)
- desktop-app#31 (T19 PR 3) MERGED 4787e8e (critique-2 revise 8/10 → opus fix2; 636 tests; 9/9 mutants). Friday line added.
- Nightly on 0.7.13 green (dispatched run 36257082895). rig-service RUNNING 0.7.13 pid 79665 (lesson #106: /tmp cleaner broke Python; reinstalled).
- OASIS.app built from 4787e8e, NOT installed; mac-checks row 'T19 PR 3' added.
- Decisions #140 (never idle), #141 (PR 4 Connect scope; T44 ticket added), #142 (T28 answers).
- Lessons #105–#108 logged (queued).
- Decision #143: speed metrics (coordination/swarm-metrics.md 'Speed per session', tool coordination/tools/session_metrics.py). s27: idle 57.8 min · parallel 1.43 · desktop-app#31 1 h 55 m.
## In flight (each has its result file; details in TASK.md top)
- T19 PR 4: t19p4-harness (haiku) integrated, uncommitted, typecheck FAILS (previewStub.test.ts:246/255/290) → next: sonnet fix job
- Swarm 1.16.0: fix1 integrated, 425/425 + check green (uncommitted) → next: show Braden lessons 18–20 text, then ship
- T28: t28-build integrated, uncommitted: pytest 4 fail / 2121 pass, mypy 7 errors (details TASK.md) → sonnet fix job; skills-t28-format integrated, uncommitted (+22 lines formats.md, 0.3.1) → review + ship
## Next
Finish the three above (TASK.md). Then T19 PR 5 → T43 → T42 → T28 desktop half → T29 … Swarm PR for #106–#108 after 1.16.0.
## Worktree cleanup
desktop-app-t19-p3 (merged; backup branch backup/t19-p3-wip), + the s26 list below.

# HANDOFF.md — 2026-09-26, session 27 (live)
- desktop-app#31 (T19 PR 3) MERGED 4787e8e; app built, not installed. Waiting nightly 36257082895 → rig-service 0.7.13 → mac row. Building: t19p4-build (opus), swarm-lessons116 (sonnet), t28-contract (opus, agent-core-t28). Decisions #140, #141; T44 ticket. Dispatches 6/10.

# HANDOFF.md — 2026-09-26, end of session 26 (9/10 dispatches)
## Done (s26)
- Decision #138 (topic rule) + #139 (emails plain v1; T43 formatted emails, orchestrator merges under #125). T43 in docs/TICKETS.md.
- desktop-app#30 (T19 PR 2 re-entry) merged b103de9; Mac check PASS 6/6; OASIS.app b103de9 installed (Braden asked).
- project-swarm#36 (1.15.0) merged + installed; #95–#102 shipped.
- agent-core#49 (T41 reply shape, 0.7.13) merged 95be078. rig-service still 0.7.12 on purpose.
- coordination/TOOL-REQUESTS.md created (Codex out of credits → Opus for UI).
- Rust build recipe: RUSTUP_HOME=/private/tmp/oasis-t01-tools/rust/rustup CARGO_HOME=/private/tmp/oasis-t01-tools/rust/cargo PATH=/private/tmp/oasis-t01-tools/rust/cargo/bin:$PATH; from repos/desktop-app: `VITE_OASIS_DEV_PACKS=1 npm run tauri build -- --bundles app -c '{"bundle":{"createUpdaterArtifacts":false}}'`.
## In flight
- T19 PR 3 desktop: worktrees/desktop-app-t19-p3 @ ed0e6bb, all checks green, 7/7 mutants. Next = critique-2 → ≤1 Opus fix → ship → merge → restart rig-service 0.7.13 → rebuild → mac row. Full steps: TASK.md s27 top.
## Next after PR 3
T19 PR 4 (Connect) → PR 5 (Activity + Scoreboard) → T43 → T42 → T28 → … Swarm PR for lessons #103–#104 when it is next (own chat, real build).
## Worktree cleanup
desktop-app-reentry, desktop-app-t19-p2, agent-core-t41 (all merged), ~/Documents/repos-projects/project-swarm-lessons95 (merged), + older list below.

# HANDOFF.md — 2026-09-26, session 26 task 2 (live, T19 PR 3)
- T19 PR 2 re-entry Mac check PASS (all 6). Installed OASIS.app b103de9 at Braden's request.
- PR 3 = agent-core T41 reply shape (worktrees/agent-core-t41, 0.7.13, shipping) + desktop PR 3 (worktrees/desktop-app-t19-p3, astra t19p3-build running; manifest .swarm-manifests/t19p3.json). Fixture = fake Cloudflare reply (Braden). Status + next in TASK.md top. Dispatches 4/10.
- Codex workspace OUT OF CREDITS (2026-09-26 ~15:37Z): Astra unavailable until Braden refills; UI jobs fall back to Opus (file tools; orchestrator runs harness).
- Do NOT restart rig-service onto 0.7.13 until desktop PR 3 merges.
- Answered (#139): emails plain text in v1, PR 3 as is; T43 formatted emails after T19 (needs Braden merge).

# HANDOFF.md — 2026-09-26, session 26 (s26 done-when MET)
## Done (s26)
- Decision #138 (topic rule tune) + ORCHESTRATOR.md updated.
- desktop-app#30 MERGED b103de9 (T19 PR 2 re-entry, #137). App rebuilt, NOT installed; mac-checks row 'T19 PR 2 re-entry'; Braden pinged.
- project-swarm#36 MERGED 62b5ba9 (1.15.0), tag v1.15.0 found by ship's own tag wait (L3 dogfooded; repo derived from origin, L2). Installed 1.15.0. #95–#102 marked shipped. Friday lines added. Dispatches 2/10.
- Lesson #103 queued (post-build mutants file for integrate).
## Waiting on Braden
- Install OASIS.app from b103de9, run mac-checks 'T19 PR 2 re-entry', then re-check the rest of 'T19 PR 2'.
## Next
1. Braden's PR 2 re-check result → fix anything FAIL (same chat if ≤1 dispatch, #138).
2. T19 PR 3 (side panel + chat + T41; T41 waits on Cloudflare reply text) → PRs 4–5 → T42 → T28 → T29 → T22 → T25 → T23. AppRail.test.tsx:111 race follow-up open.
3. Use 1.15.0: declare mutants in manifests (the ship warning now fires otherwise); resultFile for checker jobs.
4. Worktree cleanup: worktrees/desktop-app-reentry (merged), ~/Documents/repos-projects/project-swarm-lessons95 (merged), desktop-app-t19-p2 + older list.

# HANDOFF.md — 2026-09-26, session 26 (live)
- Decision #138 logged + ORCHESTRATOR.md topic rule tuned (≤1-dispatch follow-ups stay in chat). Lessons 10–17 APPROVED by Braden.
- T19 PR 2 re-entry (#137): worktree worktrees/desktop-app-reentry (branch reentry-settings off 6497469). Scout (sonnet ask $0.23): no new endpoint needed (server already returns only pending questions); Onboarding only starts at beat 1 when firstRun. Build job `reentry` (sonnet, mid) manifest .swarm-manifests/reentry.json, log reentry-run.out. Dispatches 2/10.
- Build (sonnet $1.73) + fix1 (haiku $0.11, old 'Get started again' story test) integrated, 5/5 checks green (x3). Redcheck 4/4 red on base. Mutants 4/4 killed (gap filter is server-side; noted). Commit f3346f1. Ship running (.swarm-manifests/reentry-ship.out). Dispatches 2/10.
- **desktop-app#30 MERGED b103de9** (orchestrator, needs Braden #125; CI 2/2). OASIS.app rebuilt from b103de9 (nightly green; recipe: RUSTUP_HOME/CARGO_HOME=/private/tmp/oasis-t01-tools/rust/{rustup,cargo}, cargo/bin on PATH, `VITE_OASIS_DEV_PACKS=1 npm run tauri build -- --bundles app -c '{"bundle":{"createUpdaterArtifacts":false}}'`), NOT installed. mac-checks row + Friday line added; Braden pinged. Swarm 1.15.0 ship running (lessons95-ship.out).
- Next (was): integrate → mutants (builder writes .swarm-manifests/reentry-mutants.json) → commit → ship → merge (needs Braden, #125) → 3 lines (#126) → rebuild app (nightly gate #128), not installed → mac-checks row 'T19 PR 2 re-entry'. THEN in this chat: ship swarm 1.15.0 (see s25 Next item 2 below).

# HANDOFF.md — 2026-09-26, end of session 25 (topic switch)
## Done (s25)
- swarm 1.15.0 (lessons #95–#102 = contract L1–L8) BUILT: run 1790428846010-6f355dd4 (lessons95-code astra: 416 tests, red proof L1–L8; lessons95-docs sonnet $1.66). Integrated, test/check/whitespace green; my redcheck tests/lessons115.test.mjs 13/13 red on base, 13/13 green after. Scrub scan clean (only the repo's own clone URL); all new doc anchors resolve. Commit 6b6394c on swarm-lessons-95, worktree ~/Documents/repos-projects/project-swarm-lessons95. Payload .swarm-manifests/lessons95-pr-create.json (Mutation check = redcheck proof, no gate). Dispatches 2/10.
- Decision #137 logged (Settings "Show me around again").
## Open for Braden
- Approve docs/lessons.md entries 10–17 in that worktree (public field report rule) before push.
## Next
1. **FIRST (fresh chat): T19 PR 2 re-entry** — TASK.md s26 top.
2. Then (own chat) resume the swarm PR after Braden's approval: from the worktree run the NEW tool without --repo (dogfoods L2 + L3): `node tools/swarm.mjs --root . ship 1790428846010-6f355dd4 --pr .swarm-manifests/lessons95-pr-create.json --require-section 'Mutation check'` (background) → merge → confirm tag v1.15.0 → `node ~/.project-swarm/current/tools/swarm.mjs update --yes` → mark #95–#102 `Status: shipped 1.15.0 (project-swarm#<n>)` in coordination/swarm-lessons.md → Friday line in coordination/merged-2026-10-02.md.
3. Then T19 PR 3 → PRs 4–5 → T42 → T28 → T29 → T22 → T25 → T23. AppRail.test.tsx:111 race follow-up still open.

# HANDOFF.md — 2026-09-26, session 25 (live, swarm lessons PR)
- Worktree ~/Documents/repos-projects/project-swarm-lessons95 (branch swarm-lessons-95 off origin/main b2fad81). Contract .swarm-manifests/lessons95-contract.md (L1–L8 = lessons #95–#102). Manifest .swarm-manifests/lessons95.json: lessons95-code (codex gpt-6-astra, tools+tests) ∥ lessons95-docs (sonnet, docs + 1.15.0 bump). Log .swarm-manifests/lessons95-run.out. Dispatches 1/10 (2 jobs in one run).
- Next: integrate → npm test/check → redcheck new tests → show Braden docs/lessons.md entries 10–17 (public field report rule) → commit → PR payload → ship (Mutation check section: redcheck results; no gate) → merge → install 1.15.0 → mark #95–#102 shipped in coordination/swarm-lessons.md → Friday line. Then fresh chat: T19 PR 3.
- Run 1790428846010-6f355dd4 DONE: code (astra, 416 tests, red proof L1–L8) + docs (sonnet $1.66). Integrated, 3/3 checks green; my redcheck lessons115 13/13 red on base, 13/13 green after. Committed 6b6394c on swarm-lessons-95 (not pushed). Payload .swarm-manifests/lessons95-pr-create.json. WAITING: Braden approves docs/lessons.md entries 10–17 (public rule). Then ship with the NEW tool from the worktree, no --repo (dogfoods L2 + L3 tag wait): `node tools/swarm.mjs --root . ship 1790428846010-6f355dd4 --pr .swarm-manifests/lessons95-pr-create.json --require-section 'Mutation check'`.

# HANDOFF.md — 2026-09-26, end of session 24
## Done (s24)
- **desktop-app#29 T19 PR 2 MERGED 6497469** (orchestrator, needs Braden #125, CI 2/2). Astra build → Opus critique 6/10 → fix1 (+#135) → critique 8/10 → fix2 → checker ×3 (codex gpt-reserve) → ship stopped twice on a pre-existing Chat plan-flow hang (stale preview element after `done`; also on main) → astra fixed it at cause (tests only) → ship → merge. Friday line added.
- Decision #135 (Try it card no gold rim; practice Pause labelled; no voice in onboarding until T18).
- OASIS.app built from 6497469, NOT installed (#126: Braden installs). Install: `osascript -e 'quit app "OASIS"'; rm -rf /Applications/OASIS.app && ditto repos/desktop-app/src-tauri/target/release/bundle/macos/OASIS.app /Applications/OASIS.app; open /Applications/OASIS.app`. mac-checks row 'T19 PR 2'.
- swarm-metrics.md: s24 row + checker verdict (beats baseline on seat work; make standard after #100/#101). T42 opened in TICKETS.md.
- Lessons #100 (codex test env), #101 (flake-on-base check), #102 (resultFile) queued.
## Open for Braden
- (answered, #136) Orb right-click menu stays the standard OS-native menu.
- tests/AppRail.test.tsx:111 race (main 1/20) → small desktop follow-up.
- Known: Chat preview card re-anchors on `done` (element replaced); harmless for clicks, note for PR 3.
## Next (fresh chat per topic)
1. swarm PR with lessons #95–#102 (TASK.md s25 done-when).
2. T19 PR 3 (side panel + chat + T41) → PRs 4–5 → T42 → T28 → T29 → T22 → T25 → T23.
3. Worktree cleanup: desktop-app-t19-p2 (merged) + the session-20/21 list below.

# HANDOFF.md — 2026-09-26, session 24 (live)
- T19 PR 2 started: worktree worktrees/desktop-app-t19-p2 (branch t19-onboarding off 7b71cee), contract section 'PR 2' in its docs/design/contract.md (WIP 3e2bf6e). t19p2-build (astra) run 1790407079025-b2112531 running. Checker experiment (#134) = codex `gpt-reserve` (cheapest codex model with a shell). Plan + next: TASK.md 'Status (s24, live)'. Dispatches 2/10.
- t19p2-build DONE (18 min, 248k tokens, astra): integrated, 6/6 checks green incl. x5 + harness (119 png in .pilot/t19-p2-int); WIP ab90a7f. Missing #135 (started before it). Now in parallel: **t19p2-check** (codex gpt-reserve, manifest t19p2-chk.json → .swarm-manifests/t19p2-check.json) and **t19p2-critique-1** (opus, t19p2-dir1.json → docs/design/critique-pr2-1.md). Next: fix round (astra) = critique fixes + #135 + checker survivors.
- critique-1 (opus $0.90): revise 6/10, 10 fixes. check-1 (gpt-reserve, 13 min, 262k tok): all green, 12/14 killed, M4 n/a (server gaps), M13 n/a (#135 not built). Lesson #100 queued. fix1 (astra, 12 min, 218k tok): all 10 + #135; integrated 6/6 green; confirm path unchanged (only 'Yes, save it' label); WIP 6174a96. Running: check-2 (t19p2-chk2.json) + critique-2 (t19p2-dir2.json, last round). Dispatches 2/10.
- critique-2 (opus $1.05): revise 8/10, 8 fixes. check-2: 13/13 killed. fix2 (astra, 9 min, 182k): all 8; integrated green; squashed **11588e2**, pushed t19-onboarding; payload Mutation check filled (check-3 run 1790410968976-cd684d7b: 13/13 killed + M4 equivalent; my hand re-run of M7 + token-consume killed). **ship stopped twice** on suite-x5 run 3: tests/Chat.test.tsx:218 plan-flow timeout (normally 42 ms on main and branch → rare hang, not slowness; suite x20 branch 0/20, main 1/20 AppRail). Lesson #101. **t19p2-hang** (astra) diagnosing the hang at its cause (manifest t19p2-hang.json). Then re-ship → CI → merge (needs Braden, I merge #125) → 3 lines → rebuild (nightly green 03:06Z) → mac row → metrics row. Dispatches 4/10.

# HANDOFF.md — 2026-09-26, end of session 23
- Braden asked for the v1.14.0 tag + ship tagging every release. Both already true (release.yml tags on push to main; v1.14.0 → b2fad81 exists; `swarm update` = 1.14.0 upToDate). Lesson #97 rewritten: race, not a missing tag; fix queued (ship waits for tag). No dispatches. Next is unchanged: 'end of session 22' Next list below.
- s23 continued: **fn-desk** (sonnet, desktop first_name #131) running: worktrees/desktop-app-first-name, branch t19-first-name off 15c5d0d, manifest .swarm-manifests/fn.json, payload fn-pr-create.json. fn-thread (sonnet, $0.51) fixed it: name flows App → ChatRail → Chat, no new request; all checks green; red on main 4/6 (lesson #99 for the redcheck gaps). Branch commit amended, `swarm ship` running (payload fixed by orchestrator). Then merge → Friday line → app rebuild (+ mac-checks row 'first name'). Dispatches 2/10. Lessons #98, #99 queued.
- **desktop-app#28 MERGED 7b71cee** (orchestrator, ship, CI 2/2); Friday line added. OASIS.app rebuilt from 7b71cee (VITE_OASIS_DEV_PACKS=1); rig-service unchanged (0.7.12). mac-checks row 'first name'.
- **Next (fresh chat):** 1) T19 PR 2 (#130) with the checker-agent experiment (#134) → metrics row → merge → rebuild → mac row; 2) open T42 (#133); 3) swarm PR with lessons #95–#99 (fresh worktree off origin/main; separate chat per topic rule); 4) worktree cleanup (session-20/21 list below); then T19 PRs 3–5 → T28 → T29 → T22 → T25 → T23.
- Wiring-job rule (lesson #98): scout the mount/data path first and put every file on it in outputs.
- Cleanup: deleted 12 remote t19-diag-* branches; KEPT t19-diag-fix-2 (f4f136d = Windows timing + per-process idle workflow, source for T42) and worktree desktop-app-t19-diag. Removed worktree desktop-app-t19-system (its untracked .swarm-manifests went with it). Session-20/21 worktree list still to clean.

# HANDOFF.md — 2026-09-26, end of session 22

## Done (s22)
- **desktop-app#27 (T19 PR 1) MERGED 15c5d0d** (orchestrator; CI Windows + macOS green). Windows Undo stall: bisected on CI (sound calls and the 3 s poll are NOT the cause); real cause = plan cards remounting on history refresh (per-message Fragment keys, positional history ids; #132 moved the timing). Fix = one flat keyed array + T19-RACE counters; Windows 276/237 ms; mutants 21/21 (the index-key mutant is killed 5 of 6 runs, named in the PR).
- Release gate green (nightly 03:06Z) → rig-service restarted on agent-core main e2fdd7f (0.7.12), pid 97970; OASIS.app rebuilt from 15c5d0d (VITE_OASIS_DEV_PACKS=1) and running. mac-checks row 'T19 PR 1' (7 items) added; Braden pinged.
- Lessons #86–#95 in swarm-lessons.md; ORCHESTRATOR.md gained "Swarm self-improvement loop" and "hand off when switching topics"; coordination/swarm-metrics.md = the baseline for swarm upgrade experiments (Braden: every upgrade is tested on real work and ships only if the numbers move).
- Dispatches 7/10.

## Waiting on Braden
- Idle budget ANSWERED (#133): whole machine, Rig tree incl. WebView2, rig-service on its own line, same 1%; CI = warning not gate until real hardware (Mac now, Windows box later). **Open T42 'Idle budget' in docs/TICKETS.md after T19 PR 2** (not before). Until then the diag idle script should print both lines and never fail the job.
- **swarm 1.14.0 MERGED** project-swarm#35 (b2fad81, CI 11/11, Braden approved docs/lessons.md) and INSTALLED (~/.project-swarm/versions/1.14.0-cc6403bb; `redcheck` live). Repo is RDW-Labz/project-swarm (not Btabor11; lesson #96). Lessons #86–#94 marked shipped; #95–#97 queued for the next swarm PR. Worktree ~/Documents/repos-projects/project-swarm-lessons can be removed. Friday list: coordination/merged-2026-10-02.md.
- Swarm experiment ANSWERED (#134): checker agent first, on T19 PR 2 (log a swarm-metrics.md row, compare with the s22 baseline); one test file per feature second.
- Still open from before: Mac batch (bug 6, T27e, now T19 PR 1), Cloudflare reply for T41.

## Next (fresh chat)
1. Desktop first_name wiring (#131): small sonnet job; its own PR; orchestrator merges. First 1.14 run → run `swarm redcheck` on it (lesson #90 real-data check).
2. T19 PR 2 (onboarding story + Orb polish, #130): Astra + Opus director, ≤2 rounds; run the checker-agent experiment (#134) on it and log the metrics row. Then open T42 (#133).
3. Cleanup: delete remote t19-diag-* branches (`git push origin --delete t19-diag-0 t19-diag-sound t19-diag-poll t19-diag-t t19-diag-q t19-diag-w t19-diag-c t19-diag-sp t19-diag-probe t19-diag-trace t19-diag-fix-1 t19-diag-fix-2 t19-diag-main`) and worktrees desktop-app-t19-diag, desktop-app-t19-system (merged) plus the session-20/21 list below.
4. Then T19 PRs 3–5 → T28 → T29 → T22 → T25 → T23; T33 after T28; T31 after T19.

# HANDOFF.md — 2026-09-26, end of session 21

## Session 21 — done
- **Merged:** project-swarm#34 (1.13.0, 65b23db; installed; kickoff prompt sent to Braden; field report approved by Braden); agent-core#48 (0.7.12 `first_name` on GET /status #131 + CI Tests timeout 5→12 min, e2fdd7f). Both in merged-2026-09-25.md.
- Decisions #130 (pass-1 notes), #131 (first_name on /status), #132 (paused beats every Beacon state; composer "Working…" mark).
- T19 PR 1 built: pass 1 + Braden's notes + Opus critique round 1 (7.5 → all 8 fixes, docs/design/critique-1.md) + #132 working mark + Chat plan-flow flake fix + contrast gate test. Local: 543 tests x5, typecheck, eslint, harness `--view all --theme both` pass; mutants coordination/mutants/t19-pr1-desktop-mut.py (+.extra) **16/16 killed**. PR body filled (.swarm-manifests/t19p1-pr-create.json).
- Lessons #80–#85 (swarm-lessons.md).
- Nightly 36213785827 green (before #48).
- Build dispatches: 9/10 (mk-markers, t19-p1b, t19-p1c, fn-status, fn-tests, fn-mutants, t19-work, t19-wfix, t19-cgate). Stopped: same step (PR 1 CI green) failed 3 times + next job would be the 10th.

## In flight (session 22 picks these up first)
1. **desktop-app#27 (T19 PR 1) — Windows CI red, real regression.** Worktree worktrees/desktop-app-t19-system, branch t19-system, head ee2a0ad (squashed, pushed). macOS CI green. Windows: tests/QuickApp.test.tsx 'uses the shared preview, exact confirm, note and report/Undo flow through history refresh' — **305 ms on main's Windows run, > 5000 ms on this branch** (vitest per-test timeout); locally 123 ms on both. Not a flake: PR 1 adds a Windows-only stall on the quick-box Undo path. Suspects (new in QuickApp.tsx): the 3 s `getPause()` poll against the fake service (added for the quick header Pause); `playSound(...)` calls on preview/plan_report/confirmed; `setWorking(false)` on preview. Plan: bisect on CI with throwaway branches (push `t19-diag-a` = ee2a0ad minus the pause poll, `t19-diag-b` = minus playSound; open no PRs, read Windows run timings via `gh run view --log`), then one fix job (sonnet; test waits stay at 5 s). Earlier CI fixes already in ee2a0ad: CRLF-safe Connect style test (#84); Undo/Plan report findBy 5 s (#85).
   - Then: re-run mutants (16/16), `swarm ship 1790397508671-db950bc3 --repo RDW-Labz/desktop-app --pr .swarm-manifests/t19p1-pr-create.json --require-section 'Mutation check'` (after any amend: `git push --force-with-lease` first, lesson #82) → orchestrator merges (no gate logic; PreviewCard.tsx unchanged).
   - After merge: release gate (#128 nightly check) → restart rig-service onto agent-core main 0.7.12 (TASK.md recipe; not a needs-Braden merge) → rebuild OASIS.app (`VITE_OASIS_DEV_PACKS=1`; build, then swap in its own command) → mac-checks row 'T19 PR 1' (pause banner + filled Resume, gold Pause, asleep Beacon in orb + Home, Working… mark while a reply runs even when paused, Chats one-line search, Untitled chat, theme switch, sound off by default) → one ping.
2. **Desktop first_name wiring** (#131): small sonnet job — serviceClient reads `first_name` from GET /status; EmptyState question "What should we do today, <first name>?" (no name → no comma); harness fake returns a first name. After PR 1 merges (own PR, orchestrator merges).
3. **T19 PR 2**: onboarding story (5 beats, contract) + general Orb polish (moved from PR 1 by Braden, #130). Astra + Opus director (≤2 rounds).
4. T41 still waits on Braden's Darren/Cloudflare reply text (folds into PR 3).

## Next
- T19 PRs 3–5 → passes 2–3 → T28 → T29 → T22 → T25 → T23; T33 after T28; T31 after T19.
- Remove merged worktrees: project-swarm-kickoff, agent-core-first-name (+ session-20 list: agent-core-t27d, agent-core-t27e, agent-core-t28a, desktop-app-bug4, desktop-app-bug5, desktop-app-bug6, desktop-app-flake, project-swarm-sweep).

# HANDOFF.md — 2026-09-25, session 21 (live log)

## Session 21 — done so far
- Braden approved docs/field-report.md as shown (s21 opening message).
- swarm 1.13.0: mk-markers (sonnet) run 1790393152137-6adb7ef1 added 2 marker tests to tests/link.test.mjs; integrated (389 tests, check, whitespace green); mutants 5/5 killed. Commit amended 0f81eca. MERGED project-swarm#34 (65b23db), CI 11/11; 1.13.0 installed (~/.project-swarm/versions/1.13.0-7bb2c0dc); Friday line added; kickoff prompt sent to Braden.
- T19 pass-1 page re-opened for Braden (HQ3Ay6bgHh6UWfpUD7CCF2). Screenshots still on disk: scratchpad of session 1f376981…/t19p1/ (87 png).
- Nightly 36213785827 still in_progress at 03:25Z.
- Braden's pass-1 notes in: decision #130, contract section 'Pass-1 notes' (coordination/t19-contract.md + worktree docs/design/contract.md, WIP commit). Nightly 36213785827 GREEN.
- **t19-p1b** (codex gpt-6-astra) running in worktrees/desktop-app-t19-system, manifest .swarm-manifests/t19p1b.json, out t19p1b-run.out.
- t19-p1b integrated (509 tests x5, typecheck, eslint green), WIP committed; harness --view all both regenerated into .pilot/t19-p1b/final (91 png). Note: paused now wins over the service state in statusState and paused look moved needs_you→calm (asleep); say so in PR 1 body.
- Director critique round 1 (opus, $1.08): revise, 7.5/10, 8 fixes → docs/design/critique-1.md (committed).
- Decision #131: first_name on GET /status (Braden picked). PR 1 ships without it.
- **t19-p1c** (astra) running: all 8 critique fixes (worktree desktop-app-t19-system, manifest t19p1c.json).
- **fn-status** (sonnet) running: worktrees/agent-core-first-name, branch t19-first-name off 1eadbc2, 0.7.12, manifest .swarm-manifests/fn.json, payload fn-pr-create.json. Orchestrator merges (no gate). Then desktop wires first_name (small job, after PR 1 merges, or fold into PR 2).
- Decision #132: paused beats every Beacon state; composer shows its own 'working…' mark while a reply runs (full chat + quick box). Add to the job after t19-p1c (copy the contract line into worktree docs/design/contract.md then).
- fn-status integrated (WIP commit): 2080 pass, 1 fail — test helper writes profile.yaml unreadably (read_private), so blank/control-char tests pass or fail for the wrong reason. **fn-tests** (sonnet) running, manifest fn2.json.
- fn-tests failed on a permission denial (lesson #80) but output was good → hand-copied (base hash matched). fn-mutants added 2 tests. Mutants coordination/mutants/fn-agent-core-mut.py 6/6 killed. Squashed cc2348c; `swarm ship` (run from fn3-run.out) running → orchestrator merges. After merge: Friday line; rig-service restart is Braden's call only if needs-Braden — this is not, so restart onto 0.7.12 after PR 1 app rebuild (TASK.md recipe).
- t19-p1c integrated (528 tests; 1 x5 flake = known Chat plan flow, 0/10 + 0/5 on re-run), WIP committed, harness 91 png in .pilot/t19-p1c/final. **t19-work** (sonnet) running: #132 composer 'Working…' mark + flake fix (manifest t19w.json).
- agent-core#48 CI: Ubuntu Tests step hit its 5-min timeout at 99% (main is at 4:58 since T28a) → ci.yml timeout 5→12 amended (07cc343), re-shipping.
- t19-work integrated (WIP commit): 2 QuickApp tests assert the mark gone right after streamed text, before `done` → **t19-wfix** (haiku) running (t19wf.json). Chat plan-flow flake fixed (findBy 5000 ms).
- PR 1 mutants ready: coordination/mutants/t19-pr1-desktop-mut.py (+ .extra, 16 mutants). Run from the worktree after t19-wfix integrates.
- t19-wfix integrated; all PR 1 checks green incl. x5. PR 1 mutants: 15/16 killed; survivor 'contrast gate off' → **t19-cgate** (haiku) running (t19cg.json): export contrastFailures + bad-palette tests. Then re-run mutants → fill .swarm-manifests/t19p1-pr-create.json → squash → ship.
- agent-core#48: ship push failed (non-fast-forward after amend, lesson #82) → force-with-lease pushed 07cc343 → ship re-running (waits CI, merges).
- agent-core#48 MERGED e2fdd7f (0.7.12, first_name on /status; CI timeout 12 min). Friday line added. rig-service still 0.7.11 → restart onto 0.7.12 with the app rebuild (not needs-Braden).
- t19-cgate integrated; its type typo (`ReturnType<…>[]`) fixed by the orchestrator by hand (one token). PR 1: 543 tests x5 clean, mutants 16/16, harness pass (.pilot/t19-pr1/final). desktop-app#27 opened. CI run 1: Windows CRLF broke a Connect style test (lesson #84) → fixed. Run 2: quick-box Undo round-trip findBy 1 s timeout on both runners (lesson #85) → 5 s. Now ee2a0ad, ship re-running → orchestrator merges.
- Build dispatches: 9/10 (… t19-wfix, t19-cgate). The 10th = desktop first_name wiring (read /status first_name → EmptyState) → hand off at it.; critique jobs are review, not counted.

## In flight
1. (done) swarm 1.13.0. Remove worktrees/project-swarm-kickoff.
2. T19 PR 1: t19-p1c → inspect/integrate/checks → harness → critique round 2 (optional, ≤2 rounds total) (template worktrees/desktop-app-t27/.swarm-manifests/t27d1.json; context = .pilot/t19-p1b/final PNGs + docs/design/contract.md; ≤2 rounds) → fix job if revise → mutants (banner only when paused; Resume present; pause outline; paused look ≠ idle/offline; reduced-motion still; first name/no comma; Chats one row; ask-first card display-only; theme override; sound silent by default; contrast gate) → fill t19p1-pr-create.json Mutation check → squash → ship (orchestrator merges, no gate logic) → rebuild app (nightly already green) → mac-checks row → PR 2 (onboarding + orb polish).

# HANDOFF.md — 2026-09-25, end of session 20

## Session 20 — done
- **Merged:** agent-core#46 (T27e 0.7.10, orchestrator at Braden's request, 17f244e); desktop-app#25 (bug 6, a9c361d); desktop-app#26 (harness flake, efc7eea); agent-core#47 (T28a 0.7.11, orchestrator per #125, 1eadbc2). All in merged-2026-09-25.md.
- Mac: rig-service on 0.7.10 (pid 90701) — Braden restarts onto 0.7.11 himself (#126). OASIS.app from desktop a9c361d. Mac batch sent (rows 'bug 6', 'T27e'), waiting.
- Sweep shortlist done + Braden's picks recorded (read pycasbin@T28, python-quickbooks@T33, qdrant@Phase 3; voice waits with T18; nothing adopted).
- Decisions #125 (orchestrator merges everything), #126 (3 lines after needs-Braden merges; never auto-install from them), #127 (T19 answers), #128 (Windows trimmed matrix + nightly; red nightly blocks release — ORCHESTRATOR.md 'Release gate'), #129 (T41 reply shape + safe Markdown, replaces #66 for bubbles). Ticket T41 in TICKETS.md.
- Lessons #78 (sweep 0-candidate areas look complete), #79 (stale .pyc after fast hand-run mutant → mutant scripts set PYTHONDONTWRITEBYTECODE=1).
- Memory: orchestrator-merges-everything, public-field-report-rule.
- Build dispatches: 9/10 (b6c-tests, b6d-chat, b6e-chattests, hf-flake, t28a-suite, t28a-win, t28a-nightly, t19-p1, kv-kickoff). Handed off because the next needed job is the 10th.

## In flight (session 21 picks these up first)
1. **Nightly check:** agent-core nightly run 36213785827 (started by hand) — confirm green: `gh run list --repo RDW-Labz/agent-core --workflow nightly.yml --limit 1`. Red → fix job; it blocks release builds (#128).
2. **project-swarm 1.13.0** — worktrees/project-swarm-kickoff, branch kickoff-v2, squashed local commit (NOT pushed). 387 tests + check green. Mutants coordination/mutants/swarm-1.13-mut.py: 4/5 killed; **survivor 'malformed markers accepted'** → one small test job (tests/link.test.mjs: a project AGENTS.md with a lone start marker / two start markers must make link throw 'Malformed project-swarm markers' and leave the file unchanged), re-run mutants, amend. **Braden must approve docs/field-report.md before any push** (shown to him end of s20; public repo; costs and counts only, tiers not model ids). Then fill .swarm-manifests/kv-pr-create.json Mutation check, `swarm ship` (orchestrator merges), install (`git -C ~/.project-swarm pull` + `node ~/.project-swarm/tools/install.mjs --user`), send Braden the kickoff prompt from docs/kickoff.md for his new project.
3. **T19 pass 1** — worktrees/desktop-app-t19-system, branch t19-system (WIP commits: font, contract, pass-1 integrated). Pass-1 page shown: https://claude.ai/artifact/HQ3Ay6bgHh6UWfpUD7CCF2 (republish from scratchpad is gone; to update, rebuild the page and publish with `url`). **Waiting on Braden's notes** on the calls (Figtree, gold, pause placement). Then one job (sonnet or astra): Braden's notes + my flaws (pause → clear top banner; Chats page search + New chat on one line, lighter rows; first name in empty state with a real profile); Opus director critique (#104, ≤2 rounds); mutation check (ask-first card display-only: buttons/token/pending text unchanged; theme override; sound silent by default; contrast gate); PR 1 ship (orchestrator merges; no gate logic) + rebuild app (release gate #128 first) + mac-checks row. Then PR 2 onboarding story (5 beats).
4. **T41** (folds into T19 PR 3): waiting on Braden's Darren/Cloudflare reply text for the fixture.

## Next
- T19 PRs 2–5 (+T41 in PR 3) → passes 2–3 → T28 → T29 → T22 → T25 → T23; T33 after T28; T31 after T19.
- Remove merged worktrees: agent-core-t27d, agent-core-t27e, agent-core-t28a, desktop-app-bug4, desktop-app-bug5, desktop-app-bug6, desktop-app-flake, project-swarm-sweep.

# HANDOFF.md — 2026-09-25, end of session 19

## Session 19 — done
- **Merged:** agent-core#45 (0.7.9 T27d, orchestrator at Braden's explicit request, 9c33055); desktop-app#23 (bugs 3+4, 7465521); project-swarm#33 (1.12.0 `swarm sweep`, ffd542d, installed); desktop-app#24 (bug 5 composer drift, e56e6bc). All in `merged-2026-09-25.md`.
- Mac state: rig-service on agent-core 9c33055 (0.7.9) + connectors 0.4.8, **pid 38010**, port 4405. OASIS.app from desktop e56e6bc (`VITE_OASIS_DEV_PACKS=1`), running.
- Mac checks (Braden): **bug 4 PASS, bug 5 PASS** (full chat + quick box). **T27d: items 1, 2, 4 PASS; item 3 FAIL** (Teams ask → "I understand. Before asking… Got it.") → T27e below.
- Bug 5 other-UI-bugs list → Braden's picks: **before T19** = #1 quick card opens at its top, #4 "Scroll to read the full email." hint on finished cards, #5 harness collect-then-fail (= bug 6 PR). **Wait for T19** = #2 Chats page styling, #3 quick field shape — logged in prompts/20-ui-upgrade.md audit step (done).
- Memory: ui-bug-list-format (screenshots, one line each, sorted by Amber-visibility; Braden picks timing).
- Build dispatches: 9/10 (tg-teams, st-tests, tm-tests, su-label, b5-composer, b5b-honest, b6-cardtop, ne-nudge, b6b-fix). Handed off because the next needed job is the 10th.

## In flight (session 20 picks these up first)
1. **T27e agent-core (search-first nudge)** — worktrees/agent-core-t27e, branch t27e-nudge-system off origin/main 9c33055, manifest `.swarm-manifests/ne.json`, decisions `.swarm-manifests/decisions.md`. **ne-nudge** (sonnet) run `1790383170738-19489352` — **COMPLETE at end of s19, not yet inspected or integrated**; confirm with `node ~/.project-swarm/current/tools/swarm.mjs --root . status 1790383170738-19489352`. Root cause: `SEARCH_FIRST_NUDGE` appended as `Message("user", …)` in `tool_turn` (local_service_adapters.py ~852); the model answered it. Job: nudge goes into the retry call's SYSTEM text (fixed code wording is allowed there, #73), the model's asking reply is dropped from the retry context, no nudge when the reply contains TEAMS_SEND_UNAVAILABLE_TEXT or matches _TEAMS_SEND_PATTERNS, reworded nudge (no "OASIS check (not from the person)"), `assert_no_rule_echo` helper + echo test, fixture tests/fixtures/injection/teams_ask_nudge_echo.json, #73 guard test, version 0.7.10 (pyproject, uv.lock line 7, __init__, local_service.py, local_service_adapters.py version=, chat_service.py x2, test_local_service.py x2, test_service_cli.py x1), PR payload `.swarm-manifests/ne-pr-create.json` with first line **needs Braden**.
   - Then: `inspect --results`, read diff, `integrate` (checks: ruff format/lint, pytest, mypy x2). Mutants → write coordination/mutants/t27e-agent-core-mut.py (template: t27d-agent-core-mut.py): nudge back to user role; nudge also in first request's system; model's asking reply kept in retry context; Teams-refusal skip removed; Teams-pattern skip removed; nudge fires twice; echo helper weakened / acknowledgement list emptied; person text moved into system (#73); tool output moved into system (#73). Fill Mutation check, squash (`git add -A` first, `git reset --soft origin/main`, commit with attribution), `swarm ship <run> --repo RDW-Labz/agent-core --pr .swarm-manifests/ne-pr-create.json --require-section 'Mutation check'` → **held for Braden**. Tell him in one line with the PR link.
   - After Braden merges: restart rig-service on 0.7.10 (TASK.md recipe), re-check T27d item 3 row in mac-checks.md (ask Braden: "message darren on teams and ask if he is free" → exactly "I can't send Teams messages yet.").
2. **Bug 6 desktop (Braden's before-T19 picks)** — worktrees/desktop-app-bug6, branch bug6-card-top, **based on bug5-composer f9d1602, NOT main** → first `git fetch origin && git rebase --onto origin/main f9d1602` (bug 5 squash-merged as e56e6bc). WIP 925e961: b6-cardtop + b6b-fix integrated; typecheck/eslint/vitest x5 green (370 tests). Verified in the real-browser harness: #1 quick card opens at its top (title/To/Cc/Subject visible; screenshot scratchpad b6/qp), #4 hint shows on confirmed card, #5 collect-then-fail works (`--view all` = app, orb, quick only — not every view; it did not stop early).
   - Mutants `coordination/mutants/bug6-desktop-mut.py`: 8/11 killed. **Survivors need tests (next job = sonnet, mid):** (a) "chat: preview key never set" — full chat has no test that a tall card arriving opens at its top (add Chat.test.tsx test like the QuickApp one); (b) "card never consumed (stale card reused)" — test that after a card arrives, a later unrelated change (streamed text / a new short message) scrolls to bottom instead of back to the old card; (c) "hint in quick box too" — PreviewCard test: compact card whose body overflows shows Show all and NOT the hint. Also (d) harness: the `quick-preview` reading-order check measures the card's `h3` against the list top with `> 2` px; the card top is now at the list top and the heading sits ~9 px inside the card padding → measure the card element (`.plan-block` / `.plan-card`) top instead, keep ≤ 2 px. (e) harness flake: `--view all` → `quick` times out waiting for `.quick__message` right after `orb` (passes alone) — look for shared fake-service state between views; fix if small, else note.
   - Then re-run mutants (all must die), run harness `quick-preview` (must pass, both themes) + `--view all`, fill `.swarm-manifests/b6-pr-create.json` Mutation check, squash, ship (**orchestrator merges**: display only, no gate logic; say so in the PR), rebuild + install OASIS.app (build step separate from the swap; Braden rejected a combined build+quit+swap command once — run the build, then swap in its own command), mac-checks row "bug 6" (quick card opens at its top; finished card shows the hint).

## Next (after the in-flight items)
- **12-area sweep** (#124) — was deferred for bug 5; run it now: write coordination/research/sweep/goals.json (12 areas, see session 18 "Next"), `swarm sweep --model sonnet --brief coordination/research/brief.md --goals coordination/research/sweep/goals.json --known <coordination/research/*.md> --max-usd 15` as a background task; shortlist ≤3 picks/area → Braden (license, 40-hex pin, hours to adopt).
- Then T28a build (agent-core, after T27e merges) → T19 (includes #2/#3 from the audit list) → T28 → T29 → T22 → T25 → T23; T33 after T28; T31 after T19.
- Remove merged worktrees: agent-core-t27d, desktop-app-bug4, project-swarm-sweep, desktop-app-bug5 (+ older lists).

# HANDOFF.md — 2026-09-25, session 19 (live)

## Session 19 — done so far
- T27d agent-core: tg-teams (Teams guard: first-person subject must govern the verb) + tm-tests integrated; 894 passed, ruff/mypy clean; mutants 18/18 (`coordination/mutants/t27d-agent-core-*`). Squashed 9a5d470 → **agent-core#45** MERGED 9c33055 (orchestrator, at Braden's explicit request). rig-service restarted on 0.7.9 (pid 38010). OASIS.app from desktop 7465521 installed and running. mac-checks rows T27d + bug 4 added (waiting).
- desktop bugs 3+4: cb-card + st-tests integrated; 356 tests, x20 stable, eslint clean; mutants 19/19 (`bug4-desktop-mut.*`). MERGED desktop-app#23 (7465521).
- swarm sweep 1.12.0: sw-sweep integrated (368 tests, check ok), WIP commit; su-label test added; 369 tests; mutants 23/23 (`sweep-swarm-mut.*`). MERGED project-swarm#33 (ffd542d), 1.12.0 installed, Friday line added.
- Build dispatches: 9/10 (tg-teams, st-tests, tm-tests, su-label, b5-composer, b5b-honest, b6-cardtop, ne-nudge, b6b-fix). **Next build dispatch is the 10th → hand off at it.**
- Mac checks: bug 4 + bug 5 PASS. T27d FAIL item 3 → **T27e**: SEARCH_FIRST_NUDGE was sent as a user-role message (local_service_adapters.py ~852) and the model answered it. Worktree worktrees/agent-core-t27e (branch t27e-nudge-system off 9c33055). **ne-nudge** (sonnet) run 1790383170738-19489352: nudge moves into the retry call's system text (fixed code wording is allowed there, #73), model's asking reply dropped from retry context, no nudge when the reply has the Teams refusal/offer, echo test `assert_no_rule_echo`, fixture teams_ask_nudge_echo.json, 0.7.10. PR first line **needs Braden**. Then integrate, mutants (nudge back to user role; asking reply kept; Teams-refusal nudge skip removed; echo helper weakened; #73 person text into system), ship → held for Braden, restart rig-service after his merge, re-check T27d item 3.
- Bug 6: b6-cardtop integrated as WIP but 2 QuickApp tests fail (scrollTo never called in quick box) + 1 TS error in tests/PreviewCard.test.tsx → **b6b-fix** (sonnet) running.
- **Bug 6 = Braden's before-T19 picks** (#1 quick card opens at its top, #4 'Scroll to read the full email.' hint on finished cards, #5 harness keeps going past failures): worktree worktrees/desktop-app-bug6, branch bug6-card-top OFF bug5-composer (f9d1602) — after bug 5 squash-merges, `git rebase --onto origin/main f9d1602`. b6-cardtop (sonnet) running, manifest .swarm-manifests/b6.json. Then integrate, run harness (quick-preview must now pass; `--view all`), mutants (card-top rule off / scrollHeight arithmetic back; hint only when pending; old wording; harness stops at first failure), fill b6-pr-create.json, ship (orchestrator merges: display only, no gate logic). #2/#3 logged in prompts/20-ui-upgrade.md audit step.
- **Bug 5 MERGED desktop-app#24 (e56e6bc).** OASIS.app rebuilt from e56e6bc and installed (pid 60785); rig-service 0.7.9 pid 38010. Mac check batch sent to Braden: T27d, bug 4, bug 5 (mac-checks.md).
- (history) Bug 5: b5-composer + b5b-honest integrated (b5b removed padding/negative-margin and wrapper that only gamed the harness; harness now checks no drift vs pre-scroll baseline). 361 tests x5; harness long-thread/long-content pass at 1100x760 + 800x560, quick views pass; harness mutant (original bug) fails; CSS mutants 8/8 (`bug5-desktop-mut.*`). Squashed f9d1602, `swarm ship` running (orchestrator merges). Then rebuild + install OASIS.app, mac-checks row 'bug 5'.
- Other-bugs list sent to Braden with screenshots (scratchpad buglist/): 1 quick card opens mid-card (title/To cut off); 2 Chats page unstyled search/New chat, long names wrap, Rename/Delete always shown; 3 quick message field square+blue vs rounded full app; 4 finished/expired card body cut with no scroll hint; 5 (tooling) harness `--view all` stops at first failure. **Waiting on Braden's picks: before T19 vs with T19.**
- **Bug 5 (Braden):** composer stuck halfway up when scrolling. Worktree worktrees/desktop-app-bug5 (branch bug5-composer off 7465521). **b5-composer** (codex gpt-6-astra) running, manifest `.swarm-manifests/b5.json`: reproduce in Playwright (new long-thread harness views), fix (suspect `.chat__list-wrap`/`.quick__list-wrap` grid with no row sizing from #23), CSS test in tests/chatStyles.test.ts, UI bug sweep → `.swarm-manifests/b5-report.json`. Then: inspect, read diff, integrate, run the harness views myself, mutants (revert wrap sizing; page scroll allowed; each small fix reverted), fill b5-pr-create.json, ship (orchestrator merges), rebuild + install app, mac-checks row, relay not_fixed list to Braden.

## Next
- When ships finish: read `.swarm-manifests/ship.out` in worktrees/desktop-app-bug4 and worktrees/project-swarm-sweep; Friday list lines; install swarm 1.12.0 (`git -C ~/.project-swarm pull` + `node ~/.project-swarm/tools/install.mjs --user`).
- OASIS.app already BUILT from desktop main 7465521 (`VITE_OASIS_DEV_PACKS=1`) in repos/desktop-app/src-tauri/target/release/bundle/macos/, NOT yet swapped into /Applications. When Braden merges agent-core#45: restart rig-service on 0.7.9 (TASK.md recipe), quit OASIS, ditto the built app into /Applications, open it, mac-checks rows T27d + bug 4, push-notify once. Then the 12-area sweep (see session 18 "Next").

# HANDOFF.md — 2026-09-25, end of session 18

## Session 18 — done
- No failed Mac checks. **T32 DONE:** agent-core#44 (0.7.8 loader accepts step role/checks, 6256d0c) and skills#6 (0.3.0 reader/critic + `almanac.validate`, vendors agent-core 0.7.8, c8d260a), both merged by orchestrator; mutants 13/13 and 19/19 (`coordination/mutants/t32-*`). Friday list updated. rig-service NOT restarted (still 0.7.7, pid 48584; 0.7.8 only changes skill loading).
- Decisions #122 (T32 design), #123 (T27d = Braden's bugs 1–3 + Teams line; bug 4 defaults approved; AgentDojo yes), #124 (Motion + Auto-Animate for T19; T31 splash with react-three-fiber, splash only; research sweep rules). Tickets T27d and T31 added to docs/TICKETS.md.
- Research: web-motion → `coordination/research/web-motion/summary.md` (amix = © mood board, reference only). T28a seeds → `coordination/research/t28a/report.md` (garak @8d1259e, AgentDojo @089ed46, Open-Prompt-Injection @7c3809b; short SHAs, resolve to 40-hex with `gh api repos/<o>/<r>/commits/<short>`; skip garak harmful/slur/shell/malware files and AgentDojo dos_attacks). **T28a started** (done-when met).
- Build dispatches: 9/10 (sr-roles, rc-validate, sm-strcheck, rf-gaps, as-scroll, hp-pending, sw-sweep, hf-guard, cb-card). Handed off because the next needed job is the 10th.

## In flight (session 19 picks these up first)
1. **T27d agent-core** — worktrees/agent-core-t27d, branch t27d-pending-text, WIP be80e49 (0.7.9, 890 tests green, ruff clean). Done: PENDING_PLAN_TEXT exact when a card is pending; wider claim guard with sentence-start noun-first pattern (not followed by by/from); CLAIM_NONE_TEXT restored for no-plan claims; Teams do-tools hidden from the offered tool list; TOOL_USE_INSTRUCTIONS Teams sentence; TEAMS_SEND_UNAVAILABLE_TEXT; 3 injection fixtures.
   - **Remaining defect (next job, sonnet, mid):** `_TEAMS_SEND_PATTERNS` in src/anorak/local_service_adapters.py still over-matches normal search-first reports (#118), because "I" can be anywhere before the verb. These three must NOT match and need negative tests: "I checked Outlook, Gmail and Teams: Darren messaged you on Teams at 11:02." / "I looked in Teams: Darren sent you the deck at 11:02." / "I found 2 Teams messages from Darren; he posted the deck in the channel." Fix: the first-person subject must directly govern the send verb (e.g. `I('ll|'ve| can| will| have)?( just| also)? (send|post|message)`, `want me to (send|post|message)`, `shall/should I (send|post|message)`), then Teams in the same sentence; keep all current positives passing ("I can send that to Darren on Teams.", "Want me to post this in Teams?", "I'll message Darren on Teams.", "Sent on Teams."). Probe script in this handoff's history: import CLAIM_PATTERNS/_TEAMS_SEND_PATTERNS and print matches.
   - Then mutants → write coordination/mutants/t27d-agent-core-mut.py (pending text not applied; old narrow CLAIM_PATTERNS; noun-first pattern without sentence anchor / without by|from guard; CLAIM_NONE_TEXT → preview text; Teams do-tool offered; instruction sentence removed; Teams guard off; Teams guard un-anchored; fixture text moved into system message #73). Fill `.swarm-manifests/hp-pr-create.json` Mutation check (replace TBD-coordinator), squash (`git add -A` FIRST, then `git reset --soft origin/main`, commit with attribution), `swarm ship <run> --repo RDW-Labz/agent-core --pr .swarm-manifests/hp-pr-create.json --require-section 'Mutation check'` → **held for Braden** (first line **needs Braden**). Tell him in one line.
2. **desktop-app bugs 3+4** — worktrees/desktop-app-bug4, branch bug4-autoscroll, WIP commit (as-scroll integrated: shared `useStickToBottom` hook + `NewMessagePill`, 348 tests). **cb-card** run `1790376938989-d55d2a2e` (sonnet) **COMPLETE at end of s18, not yet inspected or integrated**: card above that turn's text (bug 3), smooth-scroll programmatic-flag fix (ignore events until target/scrollend/700 ms), TS2540 in tests/useStickToBottom.test.tsx, eslint deps warning. Then: `inspect --results`, read diff, integrate (checks incl. vitest x20), mutants (write coordination/mutants/bug4-desktop-mut.py: 48 px threshold ignored; pill never shows; own send doesn't scroll; reduced motion ignored; tall-card rule off; intermediate programmatic events unstick; card rendered after text; plan_report de-dup broken), fill `.swarm-manifests/as-pr-create.json` Mutation check, squash (git add -A first), ship. **Orchestrator merges** (no gate).
3. **swarm sweep 1.12.0** — worktrees/project-swarm-sweep, branch sweep (from ~/.project-swarm origin/main ab08698), contract coordination/sweep-contract.md. **sw-sweep** run `1790376522466-05a39421` (sonnet) **COMPLETE at end of s18, not yet inspected or integrated**. Then inspect, read diff (check: argv-only gh calls, env strips GITHUB_TOKEN/GH_TOKEN, no clone/tarball/zipball/`auth token`, license+pin copied from candidates never the model, top ≤3, cost cap), integrate (npm test, npm run check), mutants for those rules, ship (orchestrator merges), install (`git -C ~/.project-swarm pull` + `node ~/.project-swarm/tools/install.mjs --user`).

## Next (after the in-flight items)
- After T27d agent-core (Braden merges) + desktop PR merged: restart rig-service on 0.7.9 (TASK.md recipe), rebuild OASIS.app (`VITE_OASIS_DEV_PACKS=1`), add mac-checks rows "T27d" (card above "Waiting for your Yes on the card."; no claim, no yes/no question; Teams send ask → "I can't send Teams messages yet" first time; Teams read answers unchanged) and "bug 4" (auto-scroll, pill when scrolled up, own send scrolls, tall card top-aligned), push-notify Braden once.
- **Then the sweep (only after bug 4 + T27d are finished, #124):** write coordination/research/sweep/goals.json with 12 areas (T19 UI+onboarding, T22/T23 avatars+themes, T25 memory, T28 permissions/policy, T29, T33 month-end/QuickBooks, Phase 3 retrieval, scrubber PII/secrets, agent browser, voice, packaging/updater, audit/observability), `--known coordination/research/*.md`, `--max-usd 15`, sonnet. Shortlist ≤3 picks/area with reasons, license, 40-hex pin, hours to adopt → Braden. Scouts read-only; GitHub token = the `gh` keyring login (swarm never reads it; it has repo/workflow scopes — offered Braden a read-only token later).
- T28a build (agent-core, after T27d merges): seed from the t28a report; coordinator writes pins + tests/fixtures/injection/THIRD_PARTY.md (never a worker, lesson #70); AgentDojo is read-only test data, nothing into system instructions (#73, #123).
- Order after that: T19 (Motion + Auto-Animate, #124) → T28 → T29 → T22 → T25 → T23; T33 after T28; T31 after T19.
- Leftover: repos/skills main checkout has an old uncommitted docs/formats.md `resources` edit (stale; left alone — ask Braden before discarding). Remove merged worktrees (agent-core-t32, skills-t32 + the s17 list).

# HANDOFF.md — 2026-09-25, end of session 17

## Session 17 — done
- **Merged (10 PRs):** agent-core#40 (0.7.4 search-first #118 + honest Teams failures + connectors 0.4.5, orchestrator, 3b0cadb); connectors#12 (0.4.6 T27b recipients, Braden, 3ebca0c); agent-core#41 (0.7.5 T27b reply-all, Braden, c0ffffb); connectors#13 (0.4.7 T27c get_mail/gmail_get, orchestrator, c342fbb); agent-core#42 (0.7.6 T27c P0 honest actions, Braden, 0c86191); connectors#14 (0.4.8 T34 write audit, orchestrator, 1f37e91); agent-core#43 (0.7.7 vendors 0.4.8, orchestrator, 6ed8ab5). All in `merged-2026-09-25.md`.
- **P0 (Braden, 3:30 PM "Done" with no send):** answered. Log + Sent Items: nothing sent; the only send today was 12:06 PM via the card. The gate refused the reply (mail read in an earlier turn) and the model falsely claimed "Done". Fixed in T27c (#120): reply re-fetch by id, visible "Nothing sent: …" line, claim guard (replaces Done/I sent text, thread stores the replacement), typed yes never consent, both cases in `tests/fixtures/injection/`.
- **T34 (#121):** root cause `gates.audit._ACTIONS` held only 6 read names, so most audit calls (incl. every Graph write) were silently dropped; Google writes never logged. Fixed + static scan test.
- Decisions #119 (T27b design), #120 (P0 rules), #121 (write audit). Tickets T27c, T34 in docs/TICKETS.md.
- Mutants: t27h 56/56; t27b connectors 19/19, agent-core 70/70; t27c connectors 12/14 + 2 equivalent, agent-core 92 + 1 equivalent; t34 14/14. Scripts in `coordination/mutants/`.
- Build dispatches: 9/10 (rc-rcpt, ar-rcpt, at-tests, ru-upn, gm-get, hc-honest, gf-fix, ht-tests, wa-audit). Handed off before the 10th (next ticket needs several jobs).

## Mac state
- rig-service RUNNING on agent-core 6ed8ab5 (0.7.7) + vendored connectors 0.4.8, **pid 48584**, port 4405. repos/connectors at 1f37e91 (catalog has get_mail / gmail_get). OASIS.app unchanged (desktop 6bbcd74, `VITE_OASIS_DEV_PACKS=1`).
- Verified live this session: Teams recent chats (5), search_mail returns To lists + account_address, get_mail re-fetch by id.

## In flight
- Nothing running. Worktrees committed/merged: agent-core-t27b-rcpt, agent-core-t27c, agent-core-v048, connectors-t27b-rcpt, connectors-t27c, connectors-t34 can be removed (plus the older list below).

## Waiting on Braden (mac-checks.md)
- **T27c + T27b** (P0 fix + reply-all), **T34** (audit lines after an approved send), T27 retry 2, T27 search-first, T18 voice.

## Next (session 18)
1. If a Mac check fails → a bounded job in the matching repo.
2. Order: **T32** (reader/critic, skills) → T28a (injection suite; seed with the fixtures already in agent-core `tests/fixtures/injection/`, plus garak/Open-Prompt-Injection per #113) → T19 → T28 → T29 → T22 → T25 → T23; T33 after T28. Run `swarm scout` before T32/T28a (large tickets).
3. Small follow-ups: live search-first test `answer.count("?") <= 1` counts a `?` inside quoted chat text (ignore quoted text); desktop Chat.test.tsx plan-report flake under load; remove merged worktrees.

# HANDOFF.md — 2026-09-25, end of session 16

## Session 16 — done
- **Merged:** connectors#10 (0.4.4 sender match + no-reply drop, #115, orchestrator, 07dc7fb), agent-core#39 (0.7.3 replying_to + no-reply warning, vendors 0.4.4, Braden, 65ae618), desktop-app#22 (preview card hides ids / Replying to / warnings, Braden, 6bbcd74), connectors#11 (0.4.5 Teams recent-chats fix, orchestrator, 12be67d). Friday list `merged-2026-09-25.md` has all four.
- **Mac state:** rig-service on agent-core 65ae618 (0.7.3) + connectors 0.4.4 (pid 88245, port 4405). OASIS.app from desktop 6bbcd74 (`VITE_OASIS_DEV_PACKS=1`), running. Teams, Outlook, Outlook Calendar, Gmail connected. **Teams chats still fail on the Mac until agent-core 0.7.4 (vendoring 0.4.5) merges and rig-service restarts.**
- T30 icon Mac check passed (T30 done). "T27 retry 2" row in mac-checks.md waiting on Braden.
- Decisions #116 (T19 right after T28a), #117 (T40 "Enter the OASIS", Phase 4; keep network events + data model stable), #118 (chat search-first rule). Ticket T40 in docs/TICKETS.md; PLAN.md Network View points to it.
- Build dispatches: 10/10 (cg-sender, aw-warn, dp-fields, cp-plus, ap-plus, as-search, ct-teams, cn-newline, ae-errors, af-detail).

## In flight
1. **agent-core 0.7.4 = search-first (#118) + Teams failure surfacing**, worktree `worktrees/agent-core-t27h`, branch `t27h-search-first`, 2 WIP commits on origin/main 65ae618 (as-search integrated; ae-errors integrated + coordinator fix of the pinned TOOL_USE_INSTRUCTIONS text in tests/test_chat_search_first.py). Contracts `.swarm-manifests/t27h-contract.md` and `.swarm-manifests/t27i-contract.md` (copies in coordination/). 825 tests passed before af-detail.
   - **af-detail** (sonnet) run `1790361617433-d8313e7f`, manifest `.swarm-manifests/af.json`, **COMPLETE (finished at end of session 16), not yet inspected or integrated.** Start with `inspect 1790361617433-d8313e7f --results`. It fixes `chat_service.failure_reason` (reads `status` then `status_code`; 401/denied → reconnect text; other 4xx → "The service rejected the request"; offline only for 5xx/network/no status) and adds the URL-`?` guard test.
   - Then: inspect --results, read diff, integrate, re-run mutants `python3 ../../coordination/mutants/t27h-agent-core-mut.py` from the worktree (last run: 54 killed; survivors "t27h URLs counted" and "t27i offline detail back" should now die; "more than 6 calls" SKIP is superseded by the t27h cap mutants). Update the "t27i offline detail back" mutant if its target line moved.
   - Vendor connectors 0.4.5 (coordinator only, lesson #70): wheel built twice from `git archive 12be67d2e4e2d46eb224584f29b79d9bf2f27a94` + plain `uv build --wheel`, sha256 `8b715ec620cba9e71669e9e886996b04e911b01c8038da3e2bb07a4f68df6705` (scratchpad of session 16; rebuild if gone and confirm the same hash). Swap `vendor/connectors-0.4.4-…whl` → 0.4.5, `vendor/runtime-requirements.txt`, `vendor/PROVENANCE.md` (commit, "merge of connectors#11", SHA, one line on the Teams orderby fix), `tests/test_vendor_provenance.py` `_WHEEL_NAME`, a CHANGELOG line under 0.7.4 (same pattern as agent-core#39). Run pytest with and without the wheel (`uv pip uninstall connectors`), mypy ×2, ruff.
   - Live eval on the Mac: `OASIS_LIVE_CHAT=1 uv run --no-sync pytest -q tests/test_chat_search_first.py -k live`; report the result in the PR Tests section (a failure is information for Braden, not a blocker by itself — say so).
   - Fill `.swarm-manifests/as-pr-create.json` `## Mutation check` (replace `TBD-coordinator`), squash to one commit with the attribution lines, `swarm ship <af run id> --repo RDW-Labz/agent-core --pr .swarm-manifests/as-pr-create.json --require-section 'Mutation check'`. **Orchestrator merges** (no gate/secret/scrubber/update-path change).
   - After merge: restart rig-service (TASK.md recipe), then live-check `run_chat_connector("teams_recent_chats", {}, person="braden", catalog_dir=…)` returns chats, Friday line, tell Braden Teams chat reads work and that search-first is live (add a mac-checks row: ask for a person with no email → one-line report naming Outlook, Gmail, Teams, at most one question).

## Next (session 17)
1. The in-flight item above. Waiting on Braden: "T27 retry 2" and T18 voice Mac checks.
2. Order (#116): T27b → T32 → T28a → **T19** (prompts/20-ui-upgrade.md) → T28 → T29 → T22 → T25 → T23; T33 after T28. T40 waits for Phase 3 (#117).
3. Queued small follow-ups (TASK.md "Also queued"): desktop Chat.test.tsx plan-report flake under load; merged worktrees to remove (connectors-t27g, agent-core-t27g, desktop-app-t27g, connectors-t27i + the s15 list).

# HANDOFF.md — 2026-09-25, end of session 15

## Session 15 — done
- **Merged:** project-swarm#31 (1.10.2 codex envelope, #107), #32 (1.11.0 `swarm scout`, #112; installed; rule in ORCHESTRATOR.md); connectors#8 (0.4.2 v1 scopes, Braden), #9 (0.4.3 mail search by sender/subject/date, #114); agent-core#37 (0.7.1 vendor 0.4.2), #38 (0.7.2 search + TOOL_USE_INSTRUCTIONS, vendor 0.4.3); desktop-app#20 (T27 part 3, Braden, rebased onto T30), #21 (T30 app icon, gold-rim visor). Friday list `coordination/merged-2026-09-25.md` has all of them.
- **Mac state:** rig-service RUNNING on agent-core 55c646f (0.7.2) + connectors 0.4.3 (pid 68867). OASIS.app from desktop 5d570d0 (T27 + T30). Braden added the #108 scopes and granted consent; Outlook, Outlook Calendar and Gmail (bradenleetabor@gmail.com, a personal account) reconnected via `uv run --no-sync python -m gates connect <name> --person braden --catalog-dir ../connectors/catalog` from repos/agent-core (browser opens; 3-minute wait).
- **Braden's T27 retry:** gate, preview, send and report all work. Two fixes asked → decision #115 (below).
- Decisions #108 (v1 scopes; never ask for ChannelMessage.ReadWrite before T27 v2), #109 (OneDrive/Drive read-only in v1), #110/#111 (T30 icon), #112 (swarm scout), #113 (reuse approvals: T28a/T28 reuse lines, new tickets T32 reader/critic, T33 month-end close), #114 (mail search + preview instead of questions), #115 (sender matching, no-reply warning, hide ids, spoof fixture).
- Research: `coordination/research/` (brief.md, shortlist.md, agent-core, connectors-rag, desktop-ui, agent-hands, univer, anthropic-financial-services, paperclip). Splash-screen idea parked in TASK.md "Also queued" (T31, not approved).
- Swarm lessons #70–73. Build dispatches: 9/10 (se-mutants, uf-types, uf-mutants, cv-scopes, av-vendor, ti-test, sc-scout, cs-search, ai-instr).

## In flight
- Nothing running. All worktrees committed; merged branches' worktrees can be removed (desktop-app-t27, desktop-app-t30, connectors-t27v1, connectors-t27f, agent-core-v042, agent-core-t27f, project-swarm-envelope, project-swarm-scout).

## Next (session 16)
1. **T27 retry fixes, contract `coordination/t27g-contract.md` (decision #115).** Three parallel jobs, one contract (copy it into each worktree's `.swarm-manifests/` and set it as the manifest `contract`):
   - connectors 0.4.4 (sonnet, mid): sender match on From name/address only, no-reply excluded, `is_no_reply_address`, spoof fixture + tests. Orchestrator merges. Mutants: match on subject; no-reply kept; rule vector flipped; filter applied when no sender given.
   - agent-core 0.7.3 (sonnet, mid): `anorak.mail_rules.is_no_reply_address`, `replying_to` in reply previews, `warnings` on no-reply To/Cc, fixture tests, #73 rule in the prompt. PR first line `**needs Braden**` (preview change). Mutants: warning missing; replying_to shows the subject's claim; fixture text reaches system (#73); warnings excluded from the plan hash. After connectors merges: build the 0.4.4 wheel twice from a clean checkout (`git archive <full sha> | tar -x`, `uv build --wheel`), swap `vendor/` + `runtime-requirements.txt` + `PROVENANCE.md` (full 40-hex sha, never let a worker write it, lesson #70) + `tests/test_vendor_provenance.py`.
   - desktop-app (sonnet, mid; small follow-up on an existing component, so not the Astra+director route): hide `*_id`, render `replying_to` and `warnings` in full chat and quick box, tests, screenshots via `npm run preview:screens` (PLAYWRIGHT_BROWSERS_PATH=/private/tmp/oasis-t01-tools/ms-playwright). PR `**needs Braden**`. Mutants: an id shown; warning missing in the quick box; replying_to date not formatted; warning rendered as HTML.
   - Then restart rig-service (TASK.md recipe), rebuild OASIS.app (keep `VITE_OASIS_DEV_PACKS=1`), add a "T27 retry 2" row to mac-checks.md, ping Braden.
2. Then T27b (full recipients, #106) → T32 → T28a (seed with the spoof fixture + garak/Open-Prompt-Injection, #113) → T28 → T29 → T22 → T25 → T19 rest → T23; T33 after T28.
3. Waiting on Braden: T30 icon and T18 voice Mac checks (mac-checks.md).

# HANDOFF.md — 2026-09-25, session 15 (live)

## Session 15 — done
- **Merged:** project-swarm#31 (1.10.2, #107, orchestrator via ship, d3353f4); connectors#8 (0.4.2 v1 scopes, Braden, e2ea005). Friday list has both.
- **MERGED by Braden:** desktop-app#20 (5d570d0); OASIS.app rebuilt from it; T27 row in mac-checks.md (waiting). Was: (rebased onto main c373ebe → 19dee45 on Braden's request; only CHANGELOG conflicted; 324 tests, suite ×20 green, cargo ok, mutants 19/19 + 1 equivalent; CI green, MERGEABLE CLEAN) (T27 part 3, CI green mac+windows, 319 tests, suite ×20 green, 19/19 mutants + 1 equivalent).
- Decisions #108 (v1 scopes: only Mail.Send, Mail.ReadWrite, Calendars.ReadWrite, gmail.send, gmail.modify; all Teams scopes wait for T27 v2 — never ask Braden for ChannelMessage.ReadWrite before then), #109 (OneDrive → Files.Read.All, Drive → drive.readonly; file writes wait for v2).
- Swarm lessons #70–71. swarm 1.10.2 NOT yet installed (do it when no run/ship is live: `git -C ~/.project-swarm pull` + `node ~/.project-swarm/tools/install.mjs --user`; update TASK.md runner line).
- Build dispatches: 5/10 (se-mutants, uf-types, uf-mutants, cv-scopes, av-vendor).

## In flight
- **DONE: T27 follow-up** — connectors#9 (0.4.3, b1f18aa) + agent-core#38 (0.7.2, 55c646f) merged; rig-service restarted (pid 68867); reconnects done (Outlook, Outlook Calendar, Gmail as bradenleetabor@gmail.com); mac-checks "T27 retry" row waiting on Braden. Was: **T27 follow-up (#114, Braden's Mac check: reads ok; can't find mail by sender; asks instead of previewing):** contract `coordination/t27f-contract.md`. Jobs running in parallel: cs-search (connectors 0.4.3, `worktrees/connectors-t27f`, branch t27f-mail-search) and ai-instr (agent-core 0.7.2, `worktrees/agent-core-t27f`, branch t27f-search-instructions). Then: integrate each, mutants (connectors: filter dropped, no sort, date not enforced, whitelist off, at-least-one check off; agent-core: TOOL_USE_INSTRUCTIONS missing / in no-tools path / tool text moved into system (#73), pattern not enforced, maxLength not enforced), ship connectors (orchestrator merges), build 0.4.3 wheel, swap vendor in agent-core branch (PROVENANCE, requirements, provenance test), ship agent-core (orchestrator merges; gate unchanged), restart rig-service, ping Braden to retry the send.
- ~~swarm scout~~ **MERGED project-swarm#32 (ab08698), 1.11.0 installed, live smoke ok; rule in ORCHESTRATOR.md.** Was: **swarm scout (#112), project-swarm 1.11.0:** worktree `worktrees/project-swarm-scout` (branch swarm-scout off d3353f4), contract `.swarm-manifests/scout-contract.md`, job sc-scout (sonnet) running from `.swarm-manifests/sc.json`. Then: inspect, read diff, integrate (npm test, npm run check), mutants (license gate off; GPL kept; unknown keys kept; no 300 cap; web job gets Write; allowedTools missing; web+outputs allowed; commit not sanitized; maxPicks before gate), fill `sc-pr-create.json`, ship (orchestrator merges), install 1.11.0, add a scout step rule to ORCHESTRATOR.md (large build tickets only).
- **Done since:** desktop-app#21 T30 icon MERGED (c373ebe); OASIS.app rebuilt from it (mac-checks T30 row). swarm 1.10.2 installed. Decisions #112 (scout), #113 (reuse approvals; tickets T32 reader/critic, T33 month-end close; Reuse lines in T28a/T28). Research files in `coordination/research/` (shortlist.md; paperclip.md: borrow patterns for swarm only — argument-hashed approval requests, heartbeats + per-agent budget stops; skip for product: opt-out telemetry, Node+Postgres, one main contributor).
- **Research (Braden, 2026-09-25):** 4 read-only Sonnet researchers via the Agent tool (swarm workers have no web; noted to Braden): agent-core, connectors-rag, desktop-ui, agent-hands → `coordination/research/<area>.md` per `coordination/research/brief.md` (permissive licenses only). Next: read the four files, write one ranked shortlist `coordination/research/shortlist.md`, show Braden top picks; adopting any repo = a decision + ticket first.
- **T30 pick = round 3 #4 (visor, gold rim).** Branch t30-app-icon (worktrees/desktop-app-t30), 6/6 mutants, ship running → orchestrator merges; then rebuild OASIS.app.
0. **T30 App icon** (#110, docs/TICKETS.md T30): six Higgsfield candidates (gpt_image_2_5, ref = Beacon idle frame, media be93d598…) masked to the macOS squircle (1024 canvas, 824 body, superellipse n=5) → `coordination/references/t30-icon/` (cand-N raw, icon-N masked, sheet.py) and `coordination/references/t30-icon-contact-sheet.png`, sent to Braden. Round 1 (Beacon head) rejected: Braden wants a clean symbol logo like the Claude/ChatGPT/Cursor icons (#111). Round 2 in `coordination/references/t30-icon/round2/` + `t30-icon-contact-sheet-r2.png` (1 golden egg + keyhole, 2 portal ring + sunrise grid, 3 gold swirl knot, 4 VR visor sunset, 5 beacon triangle + signal arcs, 6 planet + orbit). Braden liked r2 #1 and #4. Round 3 `coordination/references/t30-icon/round3/` + `t30-icon-contact-sheet-r3.png` (1 egg refined, 2 faceted egg, 3 visor refined, 4 visor gold rim, 5 egg with visor window, 6 egg keyhole with sunset light). **Waiting on his pick.** Then: desktop-app worktree off main, `npx tauri icon <icon-N.png>` (writes icns/ico/PNGs to src-tauri/icons), set tauri.conf.json `bundle.icon` to the generated set, add the T30 test, PR (orchestrator merges: no gate), rebuild OASIS.app.
1. ~~**agent-core 0.7.1**~~ MERGED agent-core#37 (37402eb); rig-service restarted on it (pid 76593).
   Was: **agent-core 0.7.1** (`worktrees/agent-core-v042`, branch vendor-connectors-0.4.2): vendors connectors 0.4.2 (sha256 36720d06…87af4f7, reproducible). Checks green (784 passed), 3/3 mutants. `swarm ship` running (orchestrator merges; output `.swarm-manifests/av-ship.json`). After merge: restart rig-service on 0.7.1 (recipe in TASK.md), pull repos/connectors (done, e2ea005), Friday line.

## Next
1. After Braden merges desktop-app#20: rebuild OASIS.app (TASK.md recipe, `VITE_OASIS_DEV_PACKS=1`), add T27 row to mac-checks.md. Braden's prerequisite: add only the #108 scopes (Entra: Mail.Send, Mail.ReadWrite, Calendars.ReadWrite; Google: gmail.send, gmail.modify), reconnect Outlook, Outlook Calendar, Gmail. Teams/OneDrive/Drive stay read-only.
2. T27b → T28a → T28 → T29 → T22 → T25 → T19 rest → T23.
3. Friday list to Braden today (`coordination/merged-2026-09-25.md`).

# HANDOFF.md — 2026-09-25, end of session 14

## Session 14 — done
- **Merged:** desktop-app#19 (T19 part 1, orchestrator, 94c5398); connectors#7 (T27 part 1b, 0.4.1, Braden, bf86d00); agent-core#36 (T27 part 2, 0.7.0, merged on Braden's instruction, 9408efb). Friday list `coordination/merged-2026-09-25.md` has all three.
- rig-service RUNNING on agent-core 9408efb (0.7.0) + vendored connectors 0.4.1 (pid 24918); repos/connectors pulled to bf86d00 (catalog).
- Decisions #105 (Teams `ChannelMessage.ReadWrite` for channel Undo), #106 (reply-all off for v1 → new ticket **T27b** full recipients, in docs/TICKETS.md), #107 (fix the codex envelope in the swarm).
- Swarm lessons #66–69. Pilot arm B worktree removed.
- Build dispatches: **10/10** (cf cancelled, cf, al-links-tests, an-catalog-alias, ub-build, ud-critique-1, se-envelope, ur-revise-1, ut-marks, uf-race).

## In flight
1. **desktop-app T27 part 3** — worktree `worktrees/desktop-app-t27`, branch `t27-preview-card` at 0814a30 (NOT pushed; ship stopped at "checks failed" because of the flake below). Brief `coordination/t27-ui-brief.md`; PR payload `.swarm-manifests/t27u-pr-create.json` is complete (`**needs Braden**`, Checks, Mutation check 20/20 filled). Shots `.pilot/t27-r2/`. Coordinator already ran: 309 vitest, typecheck, eslint, build, cargo fmt/clippy/test 46.
   - **uf-race** (sonnet) run `1790344340931-9446a4b7`, manifest `.swarm-manifests/t27u4.json`, launched detached (nohup): start with `node ~/.project-swarm/current/tools/swarm.mjs --root worktrees/desktop-app-t27 wait 1790344340931-9446a4b7` as a background task. The problem: `QuickApp > keeps a clicked confirm disabled when done/history remounts the card` fails 4/20 full-suite runs, with the plan card missing after `done` + history refresh (evidence `.swarm-manifests/flake-evidence.txt`). Its checks include the full suite ×20 (`repeat`). Then: inspect, read the diff (product fix in QuickApp/Chat anchoring), integrate, run the full suite ×20 yourself, re-run the UI mutants (`coordination/mutants/t27-desktop-mut_ui.py`, run from the worktree; plus the 6 in the PR body list), commit, then `swarm ship 1790344340931-9446a4b7 --repo RDW-Labz/desktop-app --pr .swarm-manifests/t27u-pr-create.json --require-section 'Mutation check'` → held for Braden (update the Checks line to the new sha/test count first).
   - After Braden merges: rebuild OASIS.app (recipe in TASK.md, keep `VITE_OASIS_DEV_PACKS=1`), add a T27 row to `coordination/mac-checks.md` (Braden first adds the Entra + Google scopes incl. `ChannelMessage.ReadWrite` and reconnects; list in connectors#6/#7 bodies), ping.
2. **swarm 1.10.2 envelope fix (#107)** — worktree `worktrees/project-swarm-envelope` (repo /Users/prime/Documents/repos-projects/project-swarm), branch `codex-envelope-fallback` off e93b891. Run `1790343053321-e76927bc` (se-envelope, sonnet) is **complete, not yet inspected or integrated**. Next: `inspect --results` (worker must name the root cause), read the diff, integrate (checks: npm test, npm run check), mutants (earlier fenced block wins · no result-file fallback · no worktree fallback · a file outside outputs integrates · empty worktree completes · warning line missing), fill `.swarm-manifests/se-pr-create.json` Mutation check, then `swarm ship … --repo RDW-Labz/project-swarm` (orchestrator merges; not a gate). Install 1.10.2 **while no swarm run is live** (`git -C ~/.project-swarm pull` + `node ~/.project-swarm/tools/install.mjs --user`), update the runner version in TASK.md.

## Next
1. The two in-flight items above.
2. T27 Mac check (Braden) once desktop T27 merges and OASIS.app is rebuilt.
3. Then T27b (#106) → T28a (injection suite) → T28 → T29 → T22 → T25 → T19 rest (Astra + director) → T23.
4. Friday 2026-09-25 (today): show Braden `coordination/merged-2026-09-25.md`. T18 Mac check is still waiting.
5. Small follow-ups: plan-card field labels don't line up across rows (per-row max-content grid; cosmetic, noticed in report-dark r2); swarm lessons #62–69 as swarm PRs (#68: ship should refuse a payload without head/base or the declared first line).

# HANDOFF.md — 2026-09-24, end of session 13

## Session 13 — done
- Decisions #96–104 (docs/DECISIONS.md): #96 pilot details · #97 T27 details · #98 write actions in every connector, Yes kept · #99 one Yes = one previewed plan (token bound to the plan hash) · #100 T28 Standing permissions · #101 T28a Injection suite · #102 T27 plan report + Undo · #103 T29 Feedback loop · #104 **pilot won by Astra + Opus director** (Braden picked Y blind) → UI tickets route to Astra + Opus director.
- Tickets added/updated in docs/TICKETS.md: T27 (widened, #99, plan report), T28a, T28, T29. Memory: agents-are-coworkers-who-act.
- **connectors#6 MERGED by Braden** (0.4.0, 74776e4): reads + writes for all seven connectors. Friday list updated.
- **desktop-app#19 OPEN** (T19 part 1 = pilot arm A, branch t19-pilot-a, 10/10 mutants, checks in body). No gate → orchestrator merges once CI (mac + windows) is green: `gh pr merge 19 --repo RDW-Labz/desktop-app --squash --delete-branch`, then add a Friday line. Arm B branch t19-pilot-b: never pushed; remove the worktree.
- Pilot log `coordination/ui-pilot.md`; blind page https://claude.ai/artifact/W4QUz2wBeRT6zyFS2kyZK5 ; shots in coordination/references/pilot/.
- Swarm lessons #62–65 (board refuses A/B arms → SWARM_LIVE_DIR; ask id collision; codex envelope invalid even with a valid result file; ship refuses a non-integrated run).
- Build dispatches: 10/10 (pa-build, pb-build, pd-critique-1, cm-graph, cg-google, pa-revise-1, ac27 ×3 (two cancels for #99/#102), cl-links).

## In flight
1. **agent-core ac27** (codex astra) in `worktrees/agent-core-t27` (branch t27-chat-tools), run `1790302899658-8be966a3`, manifest `.swarm-manifests/t27a.json`, contract copy `.swarm-manifests/t27-contract.md` (includes #99 + #102). Launched as a background task of session 13: start with `node ~/.project-swarm/current/tools/swarm.mjs --root worktrees/agent-core-t27 wait 1790302899658-8be966a3` as a background task. If the run died with the old session (status not running/complete), relaunch `run .swarm-manifests/t27a.json`. Codex envelopes often fail (lesson #64): take the result from `.swarm/runs/<run>/worktrees/ac27-chat-tools` (`.swarm-codex-result-*.json`) and copy changed files by hand.
2. **connectors cl-links** (sonnet) in `worktrees/connectors-t27b` (branch t27-write-links off 74776e4), run `1790303288734-b70c6720` (detached nohup): `wait` it as a background task. Then integrate → pytest/ruff/mypy → mutants (web_url dropped, send without draft, previous_folder empty, teams delete not gated / wrong URL) → PR `.swarm-manifests/t27d-pr-create.json` → `swarm ship … --repo RDW-Labz/connectors`. Not a gate/scope change → orchestrator merges.
3. ~~desktop-app#19 CI~~ MERGED session 14 (94c5398), Friday line added.

## Next
1. After ac27 + cl-links: build connectors 0.4.1 wheel, swap agent-core `vendor/connectors-*.whl` + `vendor/runtime-requirements.txt` hashes + `vendor/PROVENANCE.md` (+ tests/test_vendor_provenance.py) on the t27-chat-tools branch; integrate ac27; full checks (ruff format/check, pytest, mypy ×2) with and without the wheel; coordinator mutation run (list in the ac27 prompt: token/plan-hash/extra step/double run/continue after fail/report from model text/sent-mail Undo/tool text in system/tool result approves/not-connected tool/do-as-read/unknown tool/>6 calls/logs content); fill `.swarm-manifests/t27a-pr-create.json`; ship → held (`**needs Braden**`, Braden merges). Restart rig-service on 0.7.0 after merge.
2. desktop-app T27 part 3 (PreviewCard: plan with every action + one Yes/No; plan_report with links + Undo; `note` muted) in full chat and quick box, off desktop-app main after #19 → **route to Astra + Opus director** (#104). Then rebuild OASIS.app, add a T27 row to mac-checks.md (Braden: add Entra + Google scopes and reconnect first; list in connectors#6 body), ping.
3. T28a (injection suite) → T28 (standing permissions) → T29 (feedback) → T22 → T25 → T19 rest (Astra + director) → T23.
4. Friday 2026-09-25: show Braden `coordination/merged-2026-09-25.md` (add desktop-app#19 when merged). T18 Mac check still waiting.
5. Swarm follow-ups worth a PR: lessons #62–65 + #104's `after:` codex chains with image context.

# HANDOFF.md — 2026-09-24, end of session 12

## Session 12 — done (all merged by the orchestrator unless noted)
- **Swarm pack 3 complete:** project-swarm#28 (1.9.0 versioned installs, `go`, `{root}`), #29 (1.10.0 `board` + second-writer refusal, `after:` chains, check `repeat` + `{new}`, codex contract injection, tokens), #30 (1.10.1 fenced/backticked final JSON, quiet git). `~/.project-swarm/current` → versions/1.10.1-43e20f0f. Runner: `node ~/.project-swarm/current/tools/swarm.mjs`.
- **T26 DONE:** playbooks#8 (0.3.0), avatar generator skill (Astra; Beacon rebuilds pixel-identical). Its real done-when (a second brief through Higgsfield) runs with T22's first theme.
- **T18 code merged:** agent-core#35 (0.6.19, POST /voice/transcribed), desktop-app#17 (orb/quick voice, Get started screen). rig-service on 071a3b7 (pid 85097). OASIS.app rebuilt from e53706b, installed, running. **Waiting on Braden's Mac check** (`mac-checks.md` T18 row; first live mic run). Any failure → a bounded job in `worktrees/desktop-app-t18` (reset to origin/main first).
- **Pilot harness:** desktop-app `pilot-screenshot-harness` (901014c): `npm run preview:screens -- --out DIR` (PLAYWRIGHT_BROWSERS_PATH=/private/tmp/oasis-t01-tools/ms-playwright). MERGED as desktop-app#18 (580e51b; the second ship fixed Windows path assumptions, lesson #61). Friday line added.
- Decisions #89–95 (T26 approved; T18 mic/speech/tap/quick-box; UI pilot; **T27 Chat uses tools** (#94) + details (#95): pilot first, then T27; Yes in the full chat and the quick box; `run_skill` needs no Yes, since skill risky_steps still gate). Tickets T18 (filled in) and T26 in docs/TICKETS.md. Swarm lessons #51–60. Friday list `merged-2026-09-25.md` is current.
- Build dispatches: 9/10 (j-board, j-sched, j-codex, avatar-draft, ac-voice-log, sp-speech, ui-voice, t26-avatar-gen, ph-harness). Handoff taken before the 10th: the next job is the pilot, which needs 4 or more dispatches.

## Next (session 13)
1. Friday 2026-09-25: show Braden `merged-2026-09-25.md` (current through desktop-app#18).
2. **UI pilot (decision #93)**, T19's first screen (empty state + left rail per #84, reference `coordination/references/app-layout-ref.png`, layout only). Write one brief (`coordination/ui-pilot-brief.md`: #84 layout, token-based styles (T19/#77), empty-state copy "What should we do…", Beacon centered, rail order). Arm A: codex astra builds it in a desktop-app worktree and runs `npm run preview:screens` itself (PLAYWRIGHT_BROWSERS_PATH=/private/tmp/oasis-t01-tools/ms-playwright; baseline shots in /private/tmp/oasis-t01-tools/pilot-screens/) → a separate Opus director job (claude, model opus, tier expensive) gets the PNGs + reference + brief and writes a critique → astra revises (at most 2 rounds). Arm B: a sonnet job, same brief, no screenshots. Show Braden both, unlabeled (a blind pick); log cost/minutes/rounds in `coordination/ui-pilot.md`. If A wins, record the routing rule; swarm follow-up = codex jobs in `after:` chains + image context. Neither arm merges until Braden picks; the winner becomes T19's first PR.
3. **T27 Chat uses tools** (docs/TICKETS.md T27, #94, #95). Scout first: the T16 tool bindings in agent-core (LoopRunner, registered actions, connector reads vs writes), the onboarding ask-first preview/token pattern (#58 / onboarding_service), and the chat loop (chat_service.py). One shared contract across agent-core + desktop-app. The rule in every job prompt: tool results are labelled tool messages, never system text (#73); mutation-check the gate (list in the ticket). The PR's first line is `**needs Braden**`; **Braden merges** it. The agent-core part is likely hard (the model tool loop + gate) → consider astra.
4. T18 Mac check result → fix or close.
5. Then T22 (signing key = stop and ask Braden before the first library release; the T26 skill makes the 6 themed sets, and Braden picks), T25, T19, T23.

# HANDOFF.md — 2026-09-24, end of session 11

## Session 11 — done
- T17 DONE (Braden re-check). **T24 DONE** (Braden's Mac check, all six pass): agent-core#34 (0.6.18) + desktop-app#16, both merged by `swarm ship`. rig-service on 0.6.18 (pid 46661); OASIS.app from desktop-app e6c98bb (`VITE_OASIS_DEV_PACKS=1`).
- project-swarm#27 (1.8.0) merged + installed: ship marker guard, no plan mode for read-only jobs (it silently ran Sonnet for Haiku), actualModel/modelMismatch warnings, `swarm ask`, `inspect --results`, codex worktree kept, `suggestedIgnoreTests`, CHANGELOG versions.
- Decisions #85 (T24 details), #86–88 (**T25 Remember this**, after T22, all design questions answered; ticket in docs/TICKETS.md).
- Friday list `coordination/merged-2026-09-25.md` has agent-core#34, project-swarm#27, desktop-app#16. Swarm lessons #46–50 logged.
- Build dispatches: 11 (A, D1, D2, P1, J-core, J-context, J-docs, D3, D4, j-install, j-go). Braden asked for pack 3 items 1, 2, 5 before the handoff.

## In flight
- **Swarm pack 3, part 1** (Braden: "yes, all eight, do 1, 2 and 5 first"): worktree `worktrees/project-swarm-conc`, branch `swarm-1.9-concurrency` off origin/main db0a45c. Run `1790282210425-9eeedf2a` (manifest `.swarm-manifests/p3.json`, contract `.swarm-manifests/p3-contract.md`): j-install (item 1, versioned installs + atomic `current` symlink) and j-go (item 5 `swarm go`, item 2 `{root}` placeholder, 1.9.0 version + docs). Launched with a plain background `&`, so no harness notification: start with `node ~/.project-swarm/tools/swarm.mjs --root worktrees/project-swarm-conc wait 1790282210425-9eeedf2a` as a background task.

## Next
1. Pack 3 part 1: `inspect --results` → read diffs → `integrate` → `npm test`, `npm run check` → mutation check (current not repointed / pruning deletes current / `{root}` not expanded / go skips a failing stage / commit uses `git add -A` / ship without repo) → commit → PR payload with `## Mutation check` → `swarm ship ... --repo RDW-Labz/project-swarm`. Then install 1.9.0 (`git -C ~/.project-swarm pull`, `node ~/.project-swarm/tools/install.mjs --user`) with NO swarm run live, and switch ORCHESTRATOR.md/TASK.md runner path to `~/.project-swarm/current/tools/swarm.mjs`. Switch desktop-app manifests' `CARGO_TARGET_DIR` to `{root}/src-tauri/target`.
2. Pack 3 part 2 (same PR series, next PR): item 3 `swarm board` (live runs across worktrees + files they write; refuse a second writer), item 4 `after:` job chains in one manifest, item 6 repeat brand-new test files N times in checks, item 7 auto-inject the manifest `contract` into codex prompts (codex sees HEAD only), item 8 codex token usage/cost (lesson #49).
3. Friday 2026-09-25: show Braden `coordination/merged-2026-09-25.md` (add project-swarm pack 3 if merged; check `gh`).
4. Avatar-skill ticket draft (TASK item 2) → propose, no build.
5. Then T18 (Braden decides mic flow + speech model first) / T22 / T25 / T19 / T23.

# Session 10 (ended)

## Done this session
- desktop-app#14 merged (T17 engine; squash 12413b9). OASIS.app rebuilt with `VITE_OASIS_DEV_PACKS=1`, in /Applications and running.
- Braden's T17 check: items 1–3 pass; item 4 failed (no pulse while chat works). Cause: chat never set the state (`GET /status` had no `state`). Fixed in agent-core#32 (620117a, 0.6.17; 6/6 mutants killed). rig-service restarted on it (pid 10417). Braden pinged to re-check (`coordination/mac-checks.md`).
- Swarm speed pack, all six done. project-swarm#26 (1.7.0: `ship`, the validate context check + `ignoreTests`, manifest `contract`) was merged by `swarm ship` itself; `~/.project-swarm` is on 1.7.0. desktop-app#15 fixed the flaky ChatRail test (stale history response). Live handoff and batched Mac checks are rules in ORCHESTRATOR.md.
- Decisions #82 (Astra stays expensive, only for shell-heavy build jobs), #83 (T24 quick chat; four details answered), #84 (T19 layout). The T24 ticket is in docs/TICKETS.md.
- agent-core#33 merged by `swarm ship` end to end: the missing-garage tests now pass with or without the vendored wheel, so ship works for agent-core from this Mac.
- Friday list `coordination/merged-2026-09-25.md` now includes desktop-app#14, #15, project-swarm#26 agent-core#32 and #33. Swarm lessons #34–45 logged.

## In flight
- T24 A: integrated, all checks green, coordinator fix (marker read catches MemoryStoreError + test), 8/8 mutants killed (one test tightened), committed 5b61618 on t24-chat-state, MERGED as agent-core#34 (ce170ec) by swarm ship; rig-service restarted on it (pid 46661). (payload `worktrees/agent-core-t24/.swarm-manifests/a24-pr-create.json`, output a24-ship.json). D1/D2 still running. Swarm P1 (#42) committed 8665245 on swarm-1.8-speed (1 equivalent mutant: marker strip is redundant with the any-marker rule); p2 running.
- T24 D1+D2 integrated into `worktrees/desktop-app-t24`, WIP commit 08b92ae (coordinator fixed a Rust work-area type error; cargo test 37 pass). 9 vitest failures + 1 unhandled WS 'CONNECTING' error → D3 (codex gpt-6-astra, `.swarm-manifests/d3.json`) running; it also writes `.swarm-manifests/d24-pr-create.json` (Mutation check = TBD-coordinator). After D3: integrate, full checks, mutation-check the orb state mapping (localWorking over polled) and quick_box_position, fill Mutation check, ship, rebuild OASIS.app, add T24 to mac-checks.md, ping Braden.
- D3 integrated + committed 3bc0edf (198/198 locally 5x, but 'send carries...' in tests/QuickApp.test.tsx is order-dependent flaky ~1 in 2 file runs). D4 fixed it (test-only: detached streamed node; 0/12 file runs, 0/3 full), integrated, committed e113239. `swarm ship` running for desktop-app (payload filled, output `.swarm-manifests/d24-ship.json`). After merge: install swarm 1.8.0 (`node ~/.project-swarm/tools/install.mjs --user` after `git -C ~/.project-swarm pull`), rebuild OASIS.app (recipe in TASK.md, keep `VITE_OASIS_DEV_PACKS=1`), add T24 row to mac-checks.md, ping Braden. Swarm lessons #49–50 logged. PR payload saved at scratchpad + `.swarm-manifests/d24-pr-create.json` (fill Mutation check). Mutation check DONE (coordinator, scratchpad mut_d24.py): 12 mutants, 12 killed after adding Rust test `prefers_below_when_both_above_and_below_fit` (commit on branch). List: orb ignores local / local never true / local stuck / click->toggle_panel / button->open_chat / rail picks newest / rail click no open / App ignores thread_id / quick send without thread / never above / no horizontal clamp / above-first. Re-run quick-no-thread after D4 lands.
- Build dispatches: 9/10 (A, D1, D2, P1, J-core, J-context, J-docs, D3, D4). Hand off at the 10th. After each: inspect → read diffs → integrate → checks → mutation check (last-used rule, orb state mapping) → ship. agent-core merges first; then restart rig-service on 0.6.18 and rebuild OASIS.app for Braden's Mac check.

## Next (TASK.md order)
1. T17 re-check result → any failure is a new bounded job; pass → T17 done.
2. **T24 Quick chat under the orb** (TASK 1c, decision #83). desktop-app, plus agent-core if the last-used thread or `asking` need an API. Write one shared contract file and set it as the manifest `contract`. The `asking` state touches the ask-first gate, so that PR is `**needs Braden**`. Consider a push event for state (the orb polls every 3 s). Use `swarm ship ... --require-section 'Mutation check'` to merge; it holds `**needs Braden**` PRs.
3. Avatar-skill ticket draft (TASK item 2), Friday list to Braden 2026-09-25 (item 3), then T18 / T22 / T19 / T23.
4. Open swarm lessons worth a small PR: #41 (Codex envelope; keep the worktree on envelope failure), #42 (any `<!-- swarm:... -->` counts as unfilled), #39 (install waits while a run is live).
