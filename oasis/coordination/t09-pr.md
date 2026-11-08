T09 adds `anorak.memory`: the person's drawer with four durable stores and a network event log. `ProfileStore` loads and saves `profile.yaml` atomically; `WorkingMemory` records observations in-process and yields a summary at task end; `Log` appends audit records with action, actor, data and cost; `NoteStore` organizes markdown files under `notes/` with a local index guarded against concurrent writes. `Drawer(path)` opens all four together and exposes them to the loop via `TaskHooks`.

Every skill run appends one log line with the skill name, outcome and step count, then (if working memory is non-empty) a second line with the summarized observations before clearing. The loop's `event_sink` seam receives `TaskHooks`, which emits network events (`node_created`, `link_used`, `link_removed`) to `events.jsonl` for the person, agent, skill and declared connectors, with deterministic node ids and link types so replay collapses repeated runs onto the same graph. `NetworkRecorder.record_drawer_read(...)` lets a tool announce drawer reads explicitly, since the loop's resource model has no notion of which drawer a `file:` resource touches.

Validation:
```
.venv/bin/pytest -q
251 passed, 2 skipped, 1 deselected in 2.09s
.venv/bin/ruff check .
All checks passed!
.venv/bin/mypy --strict src/
Success: no issues found in 17 source files
.venv/bin/mypy --strict --platform win32 src/
Success: no issues found in 17 source files
```

The done-when requirement (profile survives a restart; working memory is summarized into the log at task end; events file has correct nodes and links after one skill run) is asserted in `tests/test_memory_profile.py`, `test_memory_stores.py`, `test_memory_network.py` and `test_memory_loop.py`, where the last drives a real `LoopRunner` run with a synthetic skill and checks exact `events.jsonl` and `log.jsonl` records. Two documented limitations: the log records the configured model alias (not verified until T08 lands), and drawer-read events require explicit calls from the tool or skill code since the loop has no resource notion of "which drawer." No new dependencies, no version bump. Base branch is main (includes T07). This PR is independent of PR #4 (T08); whichever merges second may need a one-line CHANGELOG rebase.
