T14 adds `anorak.scoreboard`: a nightly skill (`0 2 * * *`) that reads one agent's drawer (`log.jsonl` and `events.jsonl`, the exact shapes T09 writes) and computes the ten PLAN.md measures with measured / derived / not-measured status each. It writes `scoreboard/YYYY-MM-DD.json` nightly and `scoreboard/weekly.md` on Mondays, using T09's atomic-write and private-directory primitives for all writes.

v1 measures and reports only—no model switching, no proposal stopping. The skill runs through `LoopRunner` with zero-cost budget and a separate checker that re-reads and validates the JSON from disk. Of the ten measures, two are structurally unmeasurable today (hours given back per week: no duration data in T09's log; ask-first friction: gate-stage logs never written to `log.jsonl`), and three depend on log conventions (`proposal`, `answer`, `checkin` actions) nothing in this repo writes yet and report `"not_measured"` with a reason when absent. Every measure reports measured / not measured with a reason, never a zero. Tests: a two-week synthetic fixture (tests/fixtures/scoreboard/two_weeks.json) with known answers matched exactly, weekly report naming the lowest-success-rate skill, empty/partial log handling, and a real `LoopRunner` run.

Validation:
```
.venv/bin/pytest -q
330 passed, 2 skipped, 1 deselected in 2.62s
.venv/bin/ruff check .
All checks passed!
.venv/bin/mypy --strict src/
Success: no issues found in 25 source files
.venv/bin/mypy --strict --platform win32 src/
Success: no issues found in 25 source files
```

The done-when (runs nightly on Braden's agent, produces correct numbers from his real log) is pending an external scheduler (cron/launchd/Task Scheduler) waking it at 2am—the T07 loop itself has no wall-clock trigger. `skill.yaml` documents the `0 2 * * *` schedule as metadata for that external process. The module documents the exact log conventions it reads (`proposal`, `answer`, `checkin` actions), so future components can write them without changes here. No version bump, no new dependencies. Base branch main (T02–T09).
