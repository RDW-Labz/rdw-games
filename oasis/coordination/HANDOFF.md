# HANDOFF — s95 → s96 (2026-10-13 ~23:40Z)

**Done this chat (s95):**
- desktop-app **#79 MERGED** a75630c (T109 UI; CI green at f1b025a, Braden's "merge 79").
- desktop-app **#80 MERGED** 6d5fe02 (T103 attachments; rebased twice — onto 0.7.83-era main, then onto #79; Braden typed "merge 80"). Local full vitest flaky: avatarRelay fails on clean main too; tasksPage/Coworkers fail only under full-suite load, pass alone. CI green.
- desktop-app **#81** (CI macOS gate) rebased onto #80 (changelog only), pushed b215e6c. CI ALL GREEN at b215e6c (full mac+win pass). **MERGED 06165e0 on Braden's "merge 81"** (2026-10-14): Changed/Could break/Proof (Changed: every PR runs the desktop gate on macOS too · Could break: CI time/cost per PR · Proof: tests/ciWorkflow.test.ts 25/25 + CI run).
- oasis **#9** (Hermes dev2): round 4 squashed + pushed d9cc38f (prebuilt bundle, PrivateIPC, proxy role+text allow-list, forwarder half-open timeout, watchdog write check, test-hook stripping, pre-flight FAIL without e2e, hermes-bundle.yml static test). 165/165 local tests. **4th independent review: CLEAN** (2 LOW, not fixed: nft egress-only; sudoers stop has no arg pattern) — posted as PR comment. **MERGED ec517b9 on Braden's "merge 9" (2026-10-14).** setup-dev2.sh is his to run (needs the hermes-bundle CI artifact first; see RUNBOOK.md).
- **Swarm 1.51.1 installed** (Braden's yes); `current` → versions/1.51.1-93df662d.
- "merge 89" was a typo for #80 (Braden, 2026-10-14) — closed.

**In flight / half done:**
- **T116 → agent-core #125 MERGED 837446a on Braden's "merge 125" (2026-10-14); release gate nightly success 10-14 12:53Z; rig restarted by Braden on 0.7.84 (pid 53963 on :4405, verified).** Was: OPEN, HELD (0.7.84, head e053113, branch t116-injection-leak-suites). Braden typed "fix all four" 2026-10-14. All 4 leaks fixed (each was strict xfail first), full 5082 passed, ruff+mypy clean, **22/22 mutants killed** (16 leak + 6 ask-first/browser gate; log worktrees/agent-core-t116-mutants-final-s95.log). CI 18/18 green (Windows shard 0 needed one rerun: 30 s timeout in memory/_storage.append, the known Windows timing flake from #120). Merge only on his "merge 125"; then release gate #128 + he restarts the rig (#126).

**Next (start here):** 0000) oasis #17 MERGED 8d6bb0d, #18 MERGED a829543 (2026-10-15); Braden copies folder to dev2, re-runs setup + preflight. 000) oasis #16 MERGED 420d32d (no /dev/stdin installs); Braden re-runs real dev2 setup; if it fails again, his trace → new fix. 00) oasis #15 MERGED c1fd545 (Braden "merge 15", 2026-10-14); Braden re-copies hermes-dev2 folder to dev2 + dry run (8 steps) before real setup. 0) oasis #14 MERGED 5d34bca (Braden "merge 14", 2026-10-14); then Braden re-copies folder to dev2 + re-runs dry run (8 steps) before any real setup. 1) #125: if CI green, Braden has the 3 lines; merge on "merge 125"; then rig restart `!` command for him. 2) (#81 merged.) 4) After T116: T117, then T119 (each needs his typed go).

**Waiting on Braden:** oasis #11 MERGED b664f4c (drops UV_NO_CONFIG). Bundle on main run 38618248632 green, sha 3a350815dd10db5bf0e14091e975cd45474be5f3c8f2bb5aa86aa6ed2c955119 — differs from branch run 38615546661 (76e2099…) ONLY by hermes_agent dist-info uv_cache.json timestamp + its RECORD line. oasis #12 MERGED 424bef2; main build run 38623310580 = SAME sha 60d82af5a21aa122133ea4718a6941844f69bdaeb6579c7d3df1bea4f29ba9ba (3 builds agree). oasis #13 MERGED (config.conf BUNDLE_SHA256). Setup steps 3–9 read to Braden 2026-10-14; they are his to run on dev2 (steps 3–9; download bundle from run 38623310580). Then his typed go for setup-dev2.sh (read him RUNBOOK steps first; never run it ourselves). Option A parked on branch hermes-bundle-psutil-optA. Done: #125, #9, #11 merged; rig on 0.7.84 (pid 53963). Older: 3 Apple signing secrets, T118 retention periods, T120 on-prem, T125 tunnel vs LAN listener, routing tests go (caps $15 / $12).

**Spend s95 (estimated):** swarm t116-build $4.06 (inspect costUsd); Agent-tool workers (haiku #80 rebase ×2, sonnet T116 fix, sonnet Hermes round 4, sonnet Hermes review) not costed — Claude plan.

**Gotchas this chat:**
- Swarm Claude CLI workers have no shell: their tests failed 7/91 on first run (all test bugs). For test-writing jobs on security code, use an Agent-tool sonnet worker with shell for the fix-up pass, or give the first job a shell.
- Haiku reported "107 tests" for desktop-app (a subset); always ask for the full suite and check counts (~1777).
- desktop-app worktrees share node_modules by symlink from desktop-app-t103-pr (desktop-app-main-s95 and desktop-app-ci-macos); untracked, do not commit.
- Pasted-only messages: use facts, wait for his own typed go.
- Mutation checks only AFTER commit, restore from cp backups.
- Hand mutation loops: clear `__pycache__` / PYTHONDONTWRITEBYTECODE=1 between mutants (lesson 425: a same-size mutant's .pyc survived restore and faked a gate failure).
