# Shell adapter vs Agent tool (decision #154)

Same task, same base commit, same done-when. Agent-tool numbers from session 33 task notifications (Agent tool reports tokens + wall, not $).

| Case | Base | Agent tool (model · wall · tokens · $) | Shell adapter (preset · wall · tokens · $) | Same outcome? |
|---|---|---|---|---|
| T42 red-check fix | agent-core t42-idle 0072414 | sonnet · 226.7 s · 65,175 · n/a | sonnet-shell · 418 s (incl. keychain prompt wait) · n/a · $1.25 (run 1790479138681-92732a23) | Yes: same 3 files, first integrate green (pytest/ruff/mypy). BUT the worker could not run any check: uv needs ancestor dirs the sandbox hides (lesson #142), so it fixed by reading only. |
| T42 red-check fix, replay 2 (with `setup`) | agent-core 0072414 | (same) | sonnet-shell · 579 s (incl. keychain wait + setup) · n/a · $1.01 (run 1790481611974-68ee75c3) | Yes, green on integrate. Inside the sandbox ruff + mypy PASSED (uv now works, #142 fixed); pytest still blocked: loopback socket bind and git discovery of the root `.git` (lesson #143). |
| T42 red-check fix, replay 4 (after #145 scratch dir) | agent-core 0072414 | (same) | sonnet-shell · 361 s (12:41:11Z→12:47:12Z, incl. keychain wait + setup) · n/a · $0.43 (run 1790512871853-2966177b) | **Yes, and checks ran inside:** pytest 2263 passed / 5 skipped, ruff + mypy PASSED in the sandbox; orchestrator re-ran outside after uv sync: identical (2263 passed, ruff clean, mypy 48 files). Replay 3 (run 1790499860626-b0313d45, $1.04): ruff+mypy passed, pytest blocked by TMPDIR-in-repo (#145). Parser bug: inspect showed result = last checksRun entry (#146). |
| Pass-1 Connect 3-capture fix | desktop-app pass1 e64ca35 (+ .swarm-manifests/pass1-connect-fail.txt) | opus · start 01:53:04Z (s32 chat), end/tokens TBD | | |
| (extra) E1 red-test fix | project-swarm e1-selfcheck fb14078 | sonnet · 225.0 s · 100,171 · n/a | | |

Replays run in fresh worktrees off the base commit, never the live one. Outcome = same checks green (pytest/ruff/mypy; vitest + 3 harness captures).
