# #183 CLI failure friction record — 2026-09-28

- Run: `1790610131553-1a00919e`; duration 64.183 s.
- Recorded streams: 1176 stdout bytes and 391032 stderr bytes.
- Missing outputs: `tests/field-lesson183.test.mjs`, `package-lock.json`, `coordination/swarm-183-pr-create.json`.
- No persisted stderr, response, or agent log was present in the run record. The underlying cause is unknown; this note does not infer one.
- Parent dispatched a native Codex fallback in an isolated writable checkout. Source checkout remains read-only to that worker; parent owns review, integration, and ship.
- No #185 or other build ticket has started.
