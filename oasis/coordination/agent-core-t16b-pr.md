# T16b: daily-summary runs for real in rig-service

## Summary

- **J1**: `ActionContext` gains read-only `prior` mapping of earlier accepted step outputs, keyed by step id; failed attempts and gated steps still prompt.
- **J4**: Add `anorak.daily_summary` module with the four-action daily-summary contract and its `daily_summary_matches` checker; production `GatesOutlookReader` loads connectors lazily.
- **J5**: Wire daily-summary with production inputs — agent's `ModelClient`, drawer's `NoteStore`, and local-time clock; one note written per local day. Scheduler `connector_limits` for `connector:outlook` and `connector:outlook-calendar`. Each clock and run-now run gets its own `TaskHooks`, so it writes `log.jsonl`/`events.jsonl` (counts only; tests assert no subject or sender text). Version 0.5.0.
- **J7**: Expose `POST /skills/<name>/run` endpoint for "run now" requests, resolved through the clock's `DirectorySkillRegistry` and submitted through the scheduler.
- **Vendor**: connectors 0.3.0 wheel (built from connectors#4 merge fed1512) vendored with SHA256 hash pinning; installed `--no-deps` to avoid agent-core/connectors pin cycle.

## Ticket

**T16b**: daily-summary runs for real in rig-service

This PR covers the agent-core part. `rig-service` wires all production inputs and continues starting even if connectors cannot be imported or a token is missing, logging one fixed secret-free line per closed skill.

Done-when: daily-summary runs for real in rig-service → **not met yet**; it is met after the live Mac run (TASK step 4).

## Tests

```
uv run pytest -q → 436 passed, 2 skipped, 1 deselected
uv run ruff check . → All checks passed!
uv run ruff format --check <changed .py> → already formatted
uv run mypy --strict src → Success: no issues found in 33 source files
uv run mypy --strict --platform win32 src → Success: no issues found in 33 source files
git diff --check → clean
```

## Open for Braden

The `gates.graph_read` Graph query syntax is unproven until the live Mac run.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
