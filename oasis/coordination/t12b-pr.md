# T12b: local loopback service for the Rig

Branch: `codex/t12b-local-service`  
Base: `main`  
Repository: `agent-core`

## Problem and result

The Rig has a documented local HTTP/WebSocket contract but no Python service behind it. This PR adds the loopback-only agent-core service for status/glow, sign-in, connector tiles, pause, the activity-log path, and chat streaming. It reads the service token through the existing `SecretStore` entry `rig.service_token` in keychain service `OASIS`, authenticates HTTP with Bearer, and authenticates browser WebSockets with `Sec-WebSocket-Protocol` protocols `["bearer", token]` without putting a token in a URL.

Provider and tool text remains data. Production code keeps injectable seams for the real T07/T08/T11 adapters; tests use local fakes and `sk-FAKE-0000` only. The service writes and validates the documented per-user port file and refuses non-loopback binds.

The approved startup gate is explicit: production refuses to start without a concrete real watcher backend. A fake backend is test-only and cannot supply pause/glow state. Missing watcher/T05 wiring blocks live Rig startup; T05 remains a draft pending Windows evidence.

## Validation

Pending worker completion and coordinator rerun:

```text
uv sync --locked
uv run --no-sync pytest -q tests/test_local_service.py
uv run --no-sync pytest -q
uv run --no-sync ruff check .
uv run --no-sync mypy --strict src
git diff --check
```

The companion desktop authentication PR is [coordination/rig-auth-pr.md](rig-auth-pr.md). Windows installation, live Microsoft/provider flows, real keychain acceptance, and the missing watcher/T05 wiring remain human or integration gates.
