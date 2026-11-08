# Changelog — agent-core

Newest first.

## Unreleased

- T16b — daily-summary runs for real through `rig-service` (decisions #48-#53). `anorak.loop`'s
  `ActionContext` gains a read-only `prior` mapping of earlier *accepted* step outputs, keyed by
  step id and populated only from checker-passed values, so a failed attempt's output never
  appears and a later gated step still prompts (J1; `docs/loop.md`). Add `anorak.daily_summary`:
  the fixed four-action daily-summary 1.1.0 contract (`connectors.calendar.today`,
  `connectors.email.unread`, `model.daily_summary`, `notes.write`) and its independent
  `daily_summary_matches` checker, plus `GatesOutlookReader`, the production
  `CalendarReader`/`MailReader` that loads `gates.graph_read` lazily through `importlib` so
  neither mypy nor tests import connectors. The one model call runs on the agent's default route
  (decision #48), with calendar events and mail headers quoted inside one untrusted `<data>`
  block the model has no tools to act on (decision #51); subjects and senders may reach the model
  and the note (`internal`, decision #49) but never `loop_audit.jsonl`. One note is written per
  local day (decision #50) (J4; `docs/skill-tools.md`). `service_cli.py` wires all of this with
  production inputs — a real `GatesOutlookReader`, the agent's `ModelClient`, the drawer's
  `NoteStore` and a local-time clock — and fails a skill closed with one fixed, secret-free log
  line when `gates.graph_read` cannot be imported or a connector token is missing, without
  stopping the rest of the service from starting. `Scheduler` now declares `connector_limits` for
  both `connector:outlook` and `connector:outlook-calendar`. Every clock-triggered and "run now"
  run gets its own `anorak.memory.TaskHooks` as `event_sink` (a fresh `LoggingLoopRunner` per
  submitted run), so `log.jsonl`/`events.jsonl` record who, what, which data, which model, when
  and cost for every run — never subjects, senders or body text (AGENTS.md: "every action logs").
  `connectors` reaches agent-core as a vendored, hash-pinned wheel
  (`vendor/connectors-0.3.0-py3-none-any.whl`, commit `fed1512`, SHA256 recorded in
  `vendor/PROVENANCE.md`), installed `--no-deps` and never declared in
  `[project.dependencies]`, because of the agent-core/connectors pin cycle (decision #34/#50)
  (J5). `rig-service` also exposes `POST /skills/:name/run` (decision #52): a token-protected
  "run now" for one installed skill, resolved only through the clock's own
  `DirectorySkillRegistry` and submitted through that same scheduler seam, so T07 resources,
  pause and ask-first still apply. Returns `202 {"status": "queued", "skill": "<name>"}` without
  waiting for the run to finish, `409 {"error": "paused"}` while paused (nothing submitted), and
  `404 {"error": "unknown_skill"}` for any name that fails a strict pattern or does not match an
  installed skill — never building a filesystem path from the request. Writes one activity-log
  line (`skill_run_requested`, outcome the skill's name) on success. No Rig button yet; see
  `docs/local-service.md` for the curl example (J7). Package version is 0.5.0.

- T16 — add `anorak.skill_tools`, the one place that binds an installed skill's registered
  `do`/`checker` names to real tools for the T15 clock's `LoopRunner` in `rig-service`
  (decision #47). `build_tools()`/`build_checkers()` are wired into `service_cli.py` in place
  of the empty registries T12b left; both remain empty today because none of the three
  starter skills' nine actions or three checkers has a real, non-invented binding available
  yet (T11's connectors package exposes no calendar/email content read; no filing-rules field,
  downloads scan or file-move utility exists; `NoteStore` is real but the loop's `Tool`
  signature has no channel for the content it would need). `LoggingLoopRunner` still fails an
  unmatched skill closed exactly as before, now with one plain, human-readable log line naming
  the missing action/checker alongside the audit's existing hashed record. Resources, pause
  and ask-first are untouched (`clock.py`/`scheduler.py` are not modified). See
  `docs/skill-tools.md`. No version bump.

- Service logs "no token found" to the activity log when the Rig service token is missing (decision #46).

- Config refers to secrets by name; `secret_name` references accepted (decision #45).

- T12b — add `anorak.local_service`, the loopback HTTP/WebSocket service the Rig talks to
  (`GET /status`, sign-in, `pause`/`connectors`/`paths/log`, `WS /chat`), matching
  `desktop-app/docs/local-api.md` exactly. Binds to `127.0.0.1` only, writes the well-known
  per-user port file with a safe default-port fallback, and authenticates with a
  keychain-backed bearer token (`OASIS` / `rig.service_token`, `Authorization: Bearer` for
  HTTP and `Sec-WebSocket-Protocol: bearer, <token>` for WS) never exposed in a URL, log or
  response (decision #39). The service now starts with no watcher backend at all (decision
  #41, supersedes #40): `LocalWatcherState` is real in-process pause/glow state, logged as
  `("watcher", "not connected")` until T05 is wired in, and `WatcherBackend` stays an
  optional `set_paused`-only seam so pause forwards to a real watcher once one exists. Wires
  a real T15 `SkillClock` (its own `LoopRunner` over the drawer's installed skills, sharing
  the service's T07 scheduler) so pause/unpause reach it and shutdown stops it. Adds
  `rig-service` (`service_cli.py`) as the real launch path, split from transport
  (`local_service.py`), the auth contract (`local_service_auth.py`) and the T07/T08/T11
  composition root (`local_service_adapters.py`). Known limitation: T11's sign-in flow runs
  on an uncancellable blocking thread, so a shutdown mid-sign-in waits rather than
  interrupts. No version bump.

- T15 follow-up — the clock catches up once after unpause, like after sleep: one run per
  skill that came due during the pause, not one per missed tick (decision #42).

- Chore — run `ruff format` on nine files that were unformatted on main, so `ruff format --check .`
  passes. Formatting only; no behavior change (decision #44).

- T15 — add `anorak.clock`, the installed-skill clock: five-field cron schedules submit due
  work through the T07 scheduler at scheduled priority (resources, pause and ask-first gates
  unchanged), suppress duplicates, and catch up once after sleep. Sync `set_paused()` /
  `stop()`; ticks while paused dispatch nothing. Add `anorak.telemetry` producers (task
  start/end, first-try/fix, ask-first gates, proposal shown/answered, watcher baselines,
  cited answers, weekly check-ins) so all ten Scoreboard measures compute from real
  records; missing source data stays `not_measured`.

- T14 — add `anorak.scoreboard`, the nightly measure-only Scoreboard skill (`0 2 * * *`):
  reads one agent's `log.jsonl` and `events.jsonl`, computes the ten PLAN measures with an
  honest measured / derived / not-measured status each, writes `scoreboard/YYYY-MM-DD.json`
  and a plain-words `scoreboard/weekly.md` on Mondays. No tuning actions (Phase 1). No
  version bump.

- T08 — add the typed async model interface (`complete`, `stream`, `tools`) with
  Anthropic, OpenRouter and Ollama adapters, config-driven route selection per agent
  and per skill, sensitivity gating (restricted/owner-only never leave the machine),
  validated price tables, durable per-agent spend ledger with once-only $500 alerts,
  metadata-only audit, and secret reveal only at the send boundary. Package version
  is 0.4.0; no release has been published.

- T07 — add the bounded skill loop and concurrent resource scheduler, independent
  checks, queued approval prompts, private replayable audit records, and explicit
  connector capacities. Preserve cancellation cleanup and fail closed on limits.

- T09 — add `anorak.memory`: the drawer with `profile.yaml`, in-process working
  memory summarized to the append-only `log.jsonl` at task end, `notes/` with a local
  index, and append-only network events (`node_created`, `link_used`, ...) in
  `events.jsonl` recorded through the loop's event sink for every skill run and drawer
  read. Secrets stay behind the T02 interface. No version bump.

- T02 — add the redacted secrets interface, native keychain backends, hidden-input
  operator CLI, locked index updates, leak/failure tests, and Windows/macOS native CI.
  Package version is 0.2.0; no release has been published.

- T01 — apply the shared repository template, locked tooling and executable CI checks.

- 0.1.0 — skeleton created
