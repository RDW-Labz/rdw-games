# T32 contract — reader/critic steps (decision #122)

Shared by two jobs: **sr** (agent-core 0.7.8, loader) and **rc** (skills 0.3.0, rule + validator + skills).
Every cross-job name is here. A worker that needs a name not listed reports it in `crossJobNames`.

## Step fields (both repos)

A step is `{id, do}` today. Two optional fields are added:

| Field | Values | Rule |
|---|---|---|
| `role` | `reader` or `critic` | Absent = ordinary step. Any other value is refused. |
| `checks` | non-empty list of step ids | Only on a step with `role: critic`, and required there. Each id is unique, names a step that appears **earlier** in `steps`, and that step has `role: reader`. |

Nothing else changes. `role`/`checks` never change what runs or what pauses: `risky_steps` and `always_ask` stay the only things that pause.

## agent-core (job sr, 0.7.7 → 0.7.8)

- `anorak.loop.load_skill` accepts `role` and `checks` and enforces the table above, raising the same exception class it raises today for a bad skill, with a message naming the step id.
- The step object gains `role: str | None` (default `None`) and `checks: tuple[str, ...]` (default `()`).
- A skill with no `role`/`checks` loads exactly as before: same objects, same plan hash / fingerprint (if any), same behavior. A test proves the hash of an existing skill is unchanged.
- Unknown step keys other than these two are still refused.

## skills (job rc, 0.2.2 → 0.3.0)

Module `src/almanac/validate.py`:

- `TOOL_ACCESS: dict[str, str]` — exact tool name → one of `"read"` (brings in outside content), `"config"` (the person's own validated config, decision #73; not outside content), `"model"`, `"write"`. Any name starting `model.` is `"model"`. Tool name = the `do` text before the first `(`, stripped. Unknown name → refused (fails closed).
- Initial list: `connectors.calendar.today`, `connectors.calendar.next`, `connectors.email.unread`, `connectors.email.search`, `connectors.square.sales`, `notes.search`, `downloads.inspect` = read; `profile.filing_rules` = config; `notes.write`, `files.move` = write. Add only names the three shared skills or formats.md examples use.
- `validate_skill(path: Path) -> list[str]` — error strings, empty list = pass. Also `python -m almanac.validate <skill.yaml>...` exits 1 and prints the errors when any file fails.
- Rules, walking `steps` in order. R = every reader seen so far. U = readers seen since the last critic (a critic empties U).
  1. Every `do` tool name is in `TOOL_ACCESS`.
  2. A `read` step must have `role: reader`.
  3. A step with `role: reader` must use a `read`, `config` or `model` tool, never `write`.
  4. A `model` step with no role while U is not empty is refused (it would see unchecked outside content).
  5. A `critic` step must use a `model` tool, and its `checks` must list **every earlier reader** (all of R). Then U becomes empty.
  6. A step that uses a `write` tool, or whose id is in `risky_steps` or `always_ask`, while U is not empty, is refused ("needs a critic before it").
  7. The field rules in the table above (same as agent-core).
  8. `config` steps with no role are fine anywhere.
- Every `skill.yaml` under `shared/` and `personal/` is validated in pytest.

## Names used across jobs

- step keys: `role`, `checks`; role values: `reader`, `critic`
- critic tool name used by the shared skills: `model.critic`
- agent-core version: `0.7.8`; skills version: `0.3.0`
- Coordinator only (no job): skills `vendor/` wheel swap 0.4.0 → 0.7.8, `vendor/provenance.json`, `uv.lock`.
