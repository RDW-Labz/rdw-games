# agent-core T16b follow-ups (0.6.0)

## Summary

- **Decision #54 accounting:** Model-call accounting distinguishes calls refused before running from uncertain outcomes; failed calls cost $0 and never block later calls.
- **Model audit failed stage:** Terminal `failed` stage with fixed `reason` (provider_refused, provider_error, timeout, no_response, dependency) and HTTP status, never message or body.
- **Ledger settle CLI:** New operator command `ledger settle <agent> --amount <usd> --drawer <path> [--call <call_id>]` to record verified costs of leftover uncertain calls.
- **Vendor path fix:** `vendor/runtime-requirements.txt` now uses repo-root path `vendor/connectors-0.3.0-py3-none-any.whl` and must be run from repo root.
- **Drawer message:** Plain message when the drawer folder is not private (chmod 700).
- **Version 0.6.0:** Release bump for agent-core.

## Why

A call refused for low credit left an uncertain charge that blocked every later model call until the ledger was repaired by hand. Decision #54 fixes this by classifying refused calls as terminal failures with zero cost, eliminating the blocking behavior.

## Tests

```
uv run pytest -q → 467 passed, 2 skipped, 1 deselected
uv run pytest -q -k refused_call_then_good_call → 2 passed (memory and file ledger)
uv run ruff check . → All checks passed!
uv run ruff format --check <changed .py> → 15 files already formatted
uv run mypy --strict src → Success: no issues found in 34 source files
uv run mypy --strict --platform win32 src → Success: no issues found in 34 source files
git diff --check → clean
ledger settle braden --amount 0 --drawer ~/OASIS/drawers/braden → nothing to settle (live drawer)
```

## Open for Braden

nothing

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
