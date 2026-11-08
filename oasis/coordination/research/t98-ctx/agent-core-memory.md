# T09 memory and network events

`anorak.memory` is the person's drawer: four stores (profile, working memory,
log, notes) plus a local slice of the Network data model (PLAN.md "Network
data model"). It makes no model, network, browser or OS-automation calls
itself, and never stores a secret -- secrets are `anorak.secrets` (T02).

## Stores

- **Profile** (`anorak.memory.profile.ProfileStore`) -- loads and saves
  `profile.yaml`, validated against the shape in
  `repos/skills/docs/formats.md` by `anorak.memory._validation.Profile`.
  `save()` is atomic (write-temp, fsync, `os.replace`, fsync the directory);
  `load()` reads it back. A validated `Profile` is immutable and equality
  comparable, so "survives a restart" is just: save with one `ProfileStore`
  instance, `load()` with a second instance pointed at the same path.
  `read_raw()`/`write_raw()` read and atomically replace the *full* on-disk
  YAML mapping, unvalidated by the agent schema -- for display configuration
  (`avatar`) and T28's `standing_rules`/`company_domains` (`anorak.standing`)
  only; `load()` pops all three before building a `Profile`, and `save()`
  preserves whatever is already on disk for all three, untouched, regardless
  of what the saved `Profile` holds (it cannot hold any of them -- unknown
  keys are rejected).
- **Working memory** (`anorak.memory.working.WorkingMemory`) -- in-process
  only, never touches disk. `note(text, **data)` records one observation;
  `summary()` returns `{"count": int, "notes": [...]}`; `clear()` drops it.
  Nothing persists it on its own -- see "Loop integration" below for how it
  is folded into the log at task end.
- **Log** (`anorak.memory.log.Log`) -- append-only `log.jsonl`.
  `record(*, actor, action, data=None, model=None, cost_usd=0.0)` appends one
  JSON line: `at` (when), `actor` (who), `action` (what), `data` (which
  data), `model` (which model), `cost_usd` (cost). `cost_usd` must be a
  known, non-negative, finite number.
- **Notes** (`anorak.memory.notes.NoteStore`) -- markdown files under
  `notes/`, one file per note (created once, never edited in place), plus a
  local `notes/index.json` index guarded by a file lock
  (`anorak.memory._storage.OwnerLock`) so concurrent writers cannot race.
  `add(title, body, tags=())`, `list_all()`, `get_body(id)`,
  `search(query)`. Search is a bounded, case-insensitive substring scan over
  title, tags and body -- Phase 0 is thin: no embeddings, no ranking.

`anorak.memory.drawer.Drawer(path)` opens (and privately creates, via
`anorak.loop_storage.private_directory`) all four together.

## Drawer file layout

```
<drawer>/
  profile.yaml               # ProfileStore
  log.jsonl                  # Log (append-only)
  events.jsonl                # NetworkEvents (append-only)
  events.jsonl.state.json     # NetworkRecorder's small dedup index (see below)
  notes/
    index.json                # NoteStore's local index
    <uuid>.md                 # one file per note, immutable once written
```

Working memory has no file: it lives only in the `Drawer.working` object for
the life of the process running a task.

## Network events (`anorak.memory.network`)

Every skill run, connector use and drawer read appends one line per event to
`events.jsonl`, per PLAN.md "Network data model": `node_created`,
`node_updated`, `node_retired`, `link_created`, `link_used`, `link_removed`.
The graph is rebuilt by replaying this stream, never edited by hand.

Each event line is `{"event": ..., "at": ..., "actor": ..., "why": ..., ...}`
plus either a `"node"` (full node record: `id, type, name, owner, status,
sensitivity, codename?`, plus type-specific fields) or a `"link"` (`from,
to, type`). `actor` is who made it happen; `why` is the id of the run that
caused it (a `log.jsonl`/audit run id), never raw tool output.

`node_created`/`link_created` fire once per id; every later touch of the
same node or link fires `link_used` only. `NetworkRecorder` keeps a tiny
local index (`<events>.state.json`) of node ids and link keys it has already
announced, guarded by the same `OwnerLock` used for the notes index, so a
graph built by replaying only `events.jsonl` never needs to de-duplicate.
`use_count`/`weight` (PLAN.md's link fields) are graph-level aggregates
computed on replay -- Phase 0 does not compute or store them itself.

Node ids are deterministic strings so repeated runs and repeated drawer
reads collapse onto the same node: `person:<id>`, `agent:<id>`,
`skill:<name>@<version>`, `connector:<name>`, `model:<name>`,
`drawer:<name>`.

`NetworkRecorder.record_skill_run(...)` is the one-call helper used at task
end (below): it announces the person/agent/skill nodes, any declared
connector and model nodes, and the `owns`/`has`/`uses`/`runs_on` links.
`NetworkRecorder.record_drawer_read(...)` is a direct call a skill's tool
makes when it reads a drawer, since the loop's resource model has no notion
of "which drawer" a `file:` resource belongs to.

## How the loop calls it

`anorak.loop.LoopRunner` already exposes the seam T09 needs and names it
explicitly: `event_sink: Callable[[AuditEvent], None]`, "T09 can consume
this seam without a graph service" (`docs/loop.md`, "Public API").
`anorak.memory.task.TaskHooks` is that callable:

```python
from anorak.memory import Drawer, TaskHooks

drawer = Drawer(drawer_path)
hooks = TaskHooks(drawer, skill, person="braden", agent="anorak-1")
runner = LoopRunner(tools=..., checkers=..., audit=..., event_sink=hooks)
result = await runner.run(skill, actor="anorak-1")
```

`AuditEvent` identities (actor, skill id, step id, resource identities) are
opaque SHA256 hashes by design (`docs/loop.md`, "Audit and replay"), so
`TaskHooks` never tries to recover plaintext from the event stream itself.
It is constructed with the real, already-known `Skill` object and the
plaintext `person`/`agent` identifiers the caller is about to pass to
`runner.run(actor=...)` -- that is enough. On the run's terminal `done`
stage (every other stage is ignored) it:

1. Appends one `log.jsonl` line (`action="skill_run"`) with the skill name
   and version, the run's outcome and step count, the *configured* model
   (`skill.model`, never claimed as the actual model used -- see
   Limitations), and the real cumulative `cost_usd` from the audit event.
2. If working memory is non-empty, appends a second `log.jsonl` line
   (`action="task_summary"`) with `working.summary()`, then clears it.
3. Calls `drawer.network.record_skill_run(...)` with the skill's declared
   `connector:` resources, emitting the person/agent/skill/connector/model
   nodes and the `owns`/`has`/`uses`/`runs_on` links into `events.jsonl`.

`tests/test_memory_loop.py` drives a real `LoopRunner` (real `JsonlAudit`,
real `Scheduler`, a trivial synthetic tool and an independent checker) with
`TaskHooks` as `event_sink`, and asserts the exact node/link records written
to `events.jsonl` and the exact `log.jsonl` lines after one skill run.

## Feedback (T29, decisions #16, #73, #103, #144)

**`anorak.memory.feedback.FeedbackStore`** is a fifth drawer store,
`<drawer>/feedback.jsonl`, same append-only family as `Log`/`ChatStore`: one
line per create/edit, `{entry_id, target, thumbs, note, at, generation}`
(`generation` is internal-only, for the edit-window check below, never part
of the public `{"entry_id","target","thumbs","note","created_at",
"edited_at"}` view `FeedbackStore.public_view` returns). The *latest* line
for an `entry_id` wins; nothing is ever rewritten. `target` is
`"chat_reply"`, `"plan_report"`, or `"skill_run"`; `entry_id` is opaque and
code-owned -- `msg:<thread_id>:<index>`, `plan:<thread_id>:<preview_id>`, or
`run:<sha256-hex>` of the exact `log.jsonl` line for that run
(`skill_run_entry_id`, verifiable by re-hashing the raw line later). A note
is one plain-text line, refused outright (never truncated) for a newline,
control character, or more than 280 characters -- exactly like a note can
hold client data an employee typed, it lives only here, private, never git,
the same split `log.jsonl` already keeps for chat text (`ChatStore`) and
note bodies (`NoteStore`).

`anorak.chat_service.ChatService.record_feedback`/`edit_feedback` are the
only writers: they resolve `entry_id` against real data (a real message
index, a real `chat_plan_report` log line, a real `skill_run` log line --
checked, never trusted raw), enforce the edit window (the thread's existing
`generation` counter for `chat_reply`/`plan_report`; a newer run of the same
skill for `skill_run`), and log `feedback_recorded`/`feedback_edited`
(`entry_id`, `target`, `thumbs` only -- never the note) through the same
`Log.record` every other action uses.

**Private run outputs and candidate cases.** `Log.record_with_line` (like
`record`, but also returns the exact bytes appended) lets a caller compute a
stable hash of one line without ever re-serializing a copy.
`anorak.memory.task.TaskHooks` uses it for the `skill_run` line, and, wired
as a new, separate `LoopRunner(outputs_sink=...)` seam (distinct from the
opaque `AuditEvent`/`event_sink` stream, which is unchanged), writes that
run's real accepted step outputs to `<drawer>/runs/<hash>.json` --
private, never git. A qualifying `skill_run` thumbs-down then writes one
candidate regression case, `<drawer>/candidates/<skill>/<uuid>.yaml`:
`{skill, run_entry_id, inputs: {ref: "runs/<hash>.json"}, expected: <note
text>}` -- the person's own drawer, for the skill author to review. A
`chat_reply` thumbs-down never writes one.

## Limitations (Phase 0, intentionally thin)

- **No retrieval beyond the local index.** `NoteStore.search` is a linear,
  case-insensitive substring scan. No embeddings, no ranking, no
  cross-drawer search.
- **No role gate, no drawer sharing.** Everything here is one person's own
  drawer; nothing filters by role or ships to another agent or to Postgres.
  That is Phase 3 (PLAN.md "Network data model", "Where it lives").
- **Model identity is configured, not verified.** `TaskHooks` logs
  `skill.model` (the configured alias). `docs/loop.md` is explicit that a
  configured model alias is never proof of the model actually used; T08
  (model switch, not yet built on this branch) owns per-call verified model
  identity. `AuditEvent.model` (a hash, only present on action/check stages)
  is not available at the terminal `done` stage this hook fires on.
- **Drawer reads are not auto-detected.** The loop's resource model has no
  notion of "which drawer" a `file:` resource belongs to, so
  `record_drawer_read` must be called explicitly by the tool/skill code that
  actually reads a drawer; it is not inferred from `AuditEvent`.
- **No node/link retirement or update logic beyond what is described above.**
  `node_updated`/`node_retired`/`link_removed` exist on `NetworkEvents` for
  a future caller to use, but no Phase 0 code path calls them yet.
- **`events.jsonl` and `log.jsonl` are local files, one per agent**, per
  PLAN.md "Phase 0 writes events to a local file per agent; Phase 3 ships
  them to Postgres." Nothing here talks to a database.
