# T34 contract — connector write audit (decision #121), connectors 0.4.8, job wa-audit

Root cause: `gates.audit._ACTIONS` allows only `connect, refresh, test_connection, status, read_calendar, read_mail`. Every other `append_event` call (search_mail, read_teams_*, search_files, read_file_text, send_mail, reply_mail, move_mail, create/update/delete_event, file and Teams writes …) raises inside `_record`, is turned into `AuditError`, and is suppressed, so nothing lands. `google_api.py` (Gmail, Google Calendar, Drive) never calls the audit at all.

## Build
1. `_ACTIONS` becomes the full set of action names the package logs. Keep one module-level frozenset. It must contain every string literal passed as the `action` argument to `audit.append_event` anywhere in `src/gates/`, plus the new Google names below.
2. Every write function in `graph_write.py` and `google_api.py` appends `started`, then `succeeded` or `failed` (on `ConnectError` or any exception, re-raised unchanged), with one `operation_id` per call, via `contextlib.suppress(audit.AuditError)` exactly like the existing Graph writes. Google action names reuse the Graph names so the log reads the same across providers (the `connector` field tells them apart):
   - `gmail_send` → `send_mail`; `gmail_reply` → `reply_mail`; `gmail_move` → `move_mail`
   - `gcal_create` → `create_event`; `gcal_update` → `update_event`; `gcal_delete` → `delete_event`
   - `drive_create` → `create_file`; `drive_move` → `move_file`; `drive_share` → `share_file`; `drive_delete` → `delete_file`
   - Check the Graph Teams deletes: `teams_delete_channel_message` must log its own name (`delete_channel_message`) if it currently logs `delete_chat_message` or nothing.
   Validation failures raised before any network call (e.g. reply-all with no `to`, invalid id) happen before `started` and log nothing — unchanged.
3. Records stay metadata-only (`_record` unchanged): connector, person, action, stage, operation_id. Never an address, subject, body, file name or id.
4. An audit failure behaves as it does today (suppressed; the action still runs).
5. Reads in `google_api.py` are out of scope (T34 is writes); do not add audit calls to them.
- Version 0.4.7 → 0.4.8: `pyproject.toml`, `src/gates/__init__.py`, `tests/test_smoke.py`, `uv.lock` (this project's version line), `CHANGELOG.md`.

## Tests (new `tests/test_write_audit.py` unless a test belongs in an existing file)
- A static scan test: parse every `src/gates/*.py` with `ast`, collect every string constant passed as the 3rd positional argument of an `audit.append_event(...)` call, and assert each is in `audit._ACTIONS` (and that there is at least one per write function listed above).
- For each write function (Graph and Google), with the existing fake-HTTP patterns and the audit path redirected to `tmp_path` (see the `_redirect_audit` fixture in tests/test_graph_write.py): a successful call leaves exactly `started` + `succeeded` with the same `operation_id` and the right action name; a failing call (HTTP 500) leaves `started` + `failed`. Parametrize.
- No record contains any fake address, subject, body text, file name or message id used in the call (scan the raw file text).
- The existing `test_reply_mail_reply_all_no_address_in_audit_log` now finds the file (tighten it: the file must exist and hold started + succeeded).

## Mutants the coordinator will run
drop `send_mail` from `_ACTIONS`; drop `reply_mail`; drop `move_mail`; gmail_send logs nothing; gmail_reply skips `failed`; gcal_delete logs nothing; drive_share logs nothing; outlook move_mail skips `succeeded`; an address in a record (`data` gains `to`); started/succeeded use different operation ids.
