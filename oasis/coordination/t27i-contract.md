# Teams read fix contract (Braden 2026-09-25: "don't let the search-first rule hide it")

## Root cause (coordinator, reproduced live on Braden's Mac 2026-09-25 13:10 CDT)
`teams_recent_chats` sends `GET /v1.0/me/chats?$expand=members&$orderby=lastUpdatedDateTime desc&...`. Graph answers **400 BadRequest "QueryOptions to order by 'lastUpdatedDateTime' is not supported."** Scope (Chat.Read) and token are fine. Verified working live: `$expand=members,lastMessagePreview` + `$orderby=lastMessagePreview/createdDateTime desc` + the existing `$select` + `$top`. `teams_chat_messages` works as is. agent-core's tool loop then logged every exception as "the service was offline", hiding the cause.

## connectors 0.4.5 (orchestrator merges)
- `_teams_recent_chats_url`: `$expand` = `members,lastMessagePreview`, `$orderby` = `lastMessagePreview/createdDateTime desc`; `$select` and `$top` unchanged. Parsing unchanged (the extra `lastMessagePreview` key is ignored).
- `gates.errors.ConnectError` gains keyword-only `status: int | None = None` and `graph_code: str | None = None` attributes (defaults keep every existing call valid). `graph_read._request_json` sets them on its `status >= 400` error: `status` = the HTTP status, `graph_code` = the response's `error.code` when it is a string of at most 64 characters matching `[A-Za-z0-9_.]+`, else None. Vendor codes only, never `error.message` or any body text.
- Tests: the exact recent-chats URL (a test that fails on the old orderby); a fake 400 with `{"error":{"code":"BadRequest","message":"x"}}` raises ConnectError with status 400 and graph_code "BadRequest" and no message text on it; a code with bad characters or over 64 chars → graph_code None; existing ConnectError(message, kind=...) calls unchanged.
- Version 0.4.4 → 0.4.5 (pyproject.toml, src/gates/__init__.py, tests/test_smoke.py, CHANGELOG.md; uv.lock only if it asserts this project's version). docs/graph-read.md notes the orderby.

## agent-core (same PR as search-first, 0.7.4)
- In the tool loop's `except`, for an exception with a `kind` attribute (gates ConnectError; duck-typed, CI has no wheel): the `chat_tool_failed` log gets `error_type` (class name), `error_kind`, `http_status`, `graph_code` (counts/codes only, never message text), and `detail` from the existing `chat_service` failure mapping instead of the fixed "the service was offline". Other exceptions: `error_type` + `detail` "the tool raised an unexpected error".
- The tool message the model sees on failure (code-owned text, role tool): `Tool failed: <Display name> could not be read just now. Tell the person it failed; do not report it as searched or empty.` (`<Display name>` from the existing tool label map: Teams, Outlook, Gmail, …).
- TOOL_USE_INSTRUCTIONS gains one sentence at the end: `If a tool fails, say which one in your one-line report (for example "I couldn't read Teams just now"); never report a failed search as empty.`
- A failed read still counts toward `reads_done` (the agent tried), but the reply must name it.
- Tests: Teams read raising a fake ConnectError(kind="generic", status=400, graph_code="BadRequest") → log entry has those fields and no message text; the model's next request holds the exact failure tool message; a scripted reply naming Teams passes the guard; a plain RuntimeError → error_type RuntimeError, detail "the tool raised an unexpected error".
- Vendor connectors 0.4.5 (coordinator only).

## agent-core follow-up: honest failure detail (coordinator review, 2026-09-25)
`chat_service.failure_reason` falls back to "the service was offline" for every unmapped error, and it reads `status_code` while gates ConnectError sets `status`. Fix:
- Read the HTTP status from `status`, then `status_code`.
- Mapping order: permission (existing kinds or 403) and not-found (existing kinds or 404) unchanged; kind `denied` or status 401 → `The sign-in was refused; reconnect it in Connect`; any other 400–499 → `The service rejected the request`; status 500–599, kind `network`/`timeout`, or no status → `the service was offline` (unchanged).
- Tests: status 400 via `status` → rejected; 403 via `status` → permission text; 401 / kind denied → reconnect text; 503 → offline; no status → offline; existing gate tests unchanged. Update the Teams-failure test in tests/test_chat_search_first.py to expect `The service rejected the request` for its 400.
