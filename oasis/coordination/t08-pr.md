T08 adds the asynchronous model interface (`complete`, `stream`, `tools`) with adapters for Anthropic, OpenRouter, and local Ollama. Model identity is selected via configuration per agent and per skill, never hard-coded in implementation. Prices are loaded from the existing `profile.yaml`; sensitivity classification gates restrict and owner-only requests to the local machine only.

Per-agent spend accounting uses a durable ledger and exact price tables computed from usage. Every cumulative $500 crossed triggers an optional alert hook. Audit events are metadata-only and append-only with no prompt or completion text. Secrets are revealed only at the HTTP send boundary. Requests and responses respect 8 MiB total size and 64 KiB per line; tool JSON is combined until one tool call is complete. Streaming preserves backpressure; early close, timeout or cancellation closes the HTTP connection and retains uncertainty for reconciliation.

Validation:
```
.venv/bin/pytest -q
299 passed, 2 skipped, 1 deselected in 2.61s
.venv/bin/ruff check .
All checks passed!
.venv/bin/mypy --strict src/
Success: no issues found in 14 source files
.venv/bin/mypy --strict --platform win32 src/
Success: no issues found in 14 source files
```

All provider exchanges in tests use controlled fake HTTP transports and injected fake keys; no live Anthropic, OpenRouter or Ollama call was made, so real-provider behaviour remains unverified until the configured keys are used. The done-when requirement (T07 test skill runs unchanged on two providers with cost in the log, and the $500 alert fires with a fake price table) is covered by tests/test_models_t07_acceptance.py. Package version bumped to 0.4.0 with httpx 0.28.1 and PyYAML 6.0.3 pinned; no release published. Model routes and prices read from existing profile.yaml keys under preferences.models; no new YAML format introduced. Base branch is main, which includes T07.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
