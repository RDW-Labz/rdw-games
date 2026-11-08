# T15: skill clock and complete task telemetry

Branch: `codex/t15-clock`  
Base: `main`  
Repository: `agent-core`

## Problem and result

T07 schedules resources but does not wake installed skills from their `skill.yaml` schedules or record the proposal and task timing needed by T14. This PR adds an injected-clock service that dispatches due skills through T07 with scheduled priority, performs one bounded catch-up after sleep, avoids duplicate dispatch, and preserves pause, resources, and ask-first gates. It adds proposal shown/answered and task start/end telemetry with actor, data, model, time, and cost fields, and updates Scoreboard producers/consumers to compute available measures while reporting missing data honestly.

T15 stays independently releasable and does not depend on unreleased T12b.

## Validation

Pending worker completion and coordinator rerun:

```text
uv sync --locked
uv run --no-sync pytest -q tests/test_clock.py tests/test_telemetry.py tests/test_memory_loop.py tests/test_scoreboard.py
uv run --no-sync pytest -q
uv run --no-sync ruff check .
uv run --no-sync mypy --strict src
git diff --check
```

Real user-drawer nightly operation remains an acceptance check after release; no provider or secret data is used by the fixtures.
