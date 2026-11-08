# Contract — T63: Proposals v1, agent-core half (agent-core 0.7.38 → 0.7.39) — #266, #277

Design is FIXED by decision #277 and the T63 ticket (t63-decision.md); nothing here adds to it.
Scope: (1) a plain counter over existing `memory/log.py` records finds a repeat = same
action + same counterpart 3+ times in 14 local days, no model. (2) at most one proposal/day,
put on the daily note, with the counted facts as structured fields; a model writes only the
one-sentence proposal text from those facts, sent as a labelled user/conversation message,
never folded into system text (#73). (3) a proposal type told No 3 times stops being offered
("Tune on its own"). (4) a Yes/No answer API on the local service plus a chat card on "any
suggestions?"; both log `proposal_answered` and a new `proposal_decision` event. (5) Yes writes
a skill draft YAML to the drawer at `skills/drafts/<name>.yaml`; never git, a standing rule, a
run, or company data beyond what the drawer already holds. The Home card (desktop-app, after
T31) is OUT of scope.

## Base
agent-core main at bdaf31a (0.7.37); branch `t63-proposals`; bump to 0.7.39 (after T67 0.7.38 merges; rebase first). One owner job
lists every file asserting 0.7.38 (not read in this job, per the ticket text): `pyproject.toml`,
`src/anorak/__init__.py`, the `uv.lock` root entry, `src/anorak/local_service.py`,
`tests/test_local_service.py`, `tests/test_service_cli.py`, `CHANGELOG.md`.

## Files
- **New** `src/anorak/proposals.py`: the counter, `Repeat`/`Proposal` dataclasses, the
  one-sentence model call, the per-type No-lockout, the daily-note write, `write_skill_draft`.
- `src/anorak/telemetry.py`: add `Telemetry.proposal_decision(*, actor, proposal_id, type,
  decision, seconds_to_answer)` next to the existing `proposal_answered` (line 79).
- `src/anorak/chat_tools.py`: a new tool entry (schema + `FIELDS`) for the "any suggestions?"
  chat card, following the existing `add(...)` pattern; kind TBD (see Open questions).
- `src/anorak/memory/drawer.py`: doc-comment only, adding `skills/drafts/` to the drawer layout
  list; no new public attribute unless the Open question below is resolved otherwise.
- `src/anorak/local_service.py` (not read): the Yes/No answer endpoint, loopback + Bearer, in
  the same style as its existing endpoints.
- `src/anorak/chat_service.py` (not read): the "any suggestions?" trigger/dispatch that calls
  the new chat_tools.py tool and renders the card.
- `src/anorak/scoreboard.py`: no change — `_proposal_events`/`_proposals_accepted`/`_time_to_yes`
  already read `proposal_shown`/`proposal_answered`; `proposal_decision` is additive telemetry,
  not read by any existing measure.
- `src/anorak/memory/log.py`, `src/anorak/loop_storage.py`: no change — `proposals.py` reads
  `log.jsonl` with its own bounded reader (mirrors `scoreboard.py`'s `_read_jsonl`, using
  `anorak.memory._storage.read_private`, not read directly) and writes the draft YAML through
  `loop_storage.private_directory`, same as every other drawer writer.

## Exports / events / endpoints / fields
| Name | Kind | Where | Shape |
|---|---|---|---|
| `Repeat` | dataclass | proposals.py | `action: str, counterpart: str, count: int, window_start: date, window_end: date` |
| `find_repeats` | function | proposals.py | reads `log.jsonl` `action`/`data`/`at`; returns `Repeat`s with count ≥ 3 in the 14-day window |
| `Proposal` | dataclass | proposals.py | `id, type, action, counterpart, count, window_start, window_end, text` |
| `build_proposal_text` | async function | proposals.py | one model call; facts as labelled user message, never system text |
| `type_locked` | function | proposals.py | reads `proposal_decision` events; True once a type has 3 `no`s |
| `write_skill_draft` | function | proposals.py | writes `skills/drafts/<name>.yaml`; draft only |
| `Telemetry.proposal_decision` | method | telemetry.py (new) | `action="proposal_decision", data={proposal_id, type, decision, answered_at, seconds_to_answer}` |
| `Telemetry.proposal_answered` | method | telemetry.py (existing, line 79) | `action="proposal_answered", data={proposal_id, decision, answered_at}` |
| Yes/No endpoint | HTTP | local_service.py (not read) | loopback, Bearer, body `{decision: "yes"\|"no"}` |
| suggestions chat tool | ChatTool | chat_tools.py (new) | kind TBD; reads today's pending proposal, renders card |

## Time zones
14 local days uses the same zone-as-parameter pattern as `scoreboard.py`'s `_local_day`/`zone`
(T66b): the window boundary is computed in whatever zone the caller's `today` was computed in,
never guessed from record text. Tests fix a non-UTC offset (e.g. `timezone(timedelta(hours=-5))`)
and place records on either side of local midnight to prove the boundary, not just calendar dates.

## Tests (one behavior test per failure class)
1. 2 occurrences of the same action+counterpart in the window → no proposal.
2. 3 occurrences in the window → one proposal.
3. 3 occurrences spread so one falls outside the 14-day window → no proposal.
4. same action, different counterpart, 3 times each → neither reaches 3, no proposal.
5. one proposal type told No 3 times → a 4th qualifying repeat of that type produces nothing.
6. Yes → the draft file exists at `skills/drafts/<name>.yaml`; asserts no standing rule and no
   run were created as a side effect.
7. the proposal-text model call: system message is the fixed constant string; the counted facts
   appear only in the user/conversation message.
8. two qualifying repeats found the same local day → only one proposal is shown/logged that day.

## Mutants (one per rule above)
1. `{id: m1-threshold, file: proposals.py, find: "count >= 3" comparison, replace: "count >= 2"}`
2. `{id: m2-window, file: proposals.py, find: the 14-day window-start bound, replace: bound removed/widened}`
3. `{id: m3-counterpart, file: proposals.py, find: grouping key (action, counterpart), replace: grouping key action alone}`
4. `{id: m4-lockout, file: proposals.py, find: the 3-No lockout check, replace: check removed}`
5. `{id: m5-yes-effect, file: proposals.py, find: Yes only calls write_skill_draft, replace: Yes also creates a standing rule or a run}`
6. `{id: m6-facts-placement, file: proposals.py, find: facts passed as the labelled user message, replace: facts concatenated into the system message}`
7. `{id: m7-one-per-day, file: proposals.py, find: the per-local-day proposal cap, replace: cap removed}`
8. `{id: m8-decision-shape, file: telemetry.py, find: proposal_decision requires decision in {"yes","no"} and the fixed field set, replace: validation dropped}`

## Release
Bump `0.7.38` → `0.7.39` in every file listed under Base; one CHANGELOG.md entry naming T63
agent-core-half scope only. PR notes explicitly that the Home daily-note card is desktop-app
work, tracked separately after T31 leaves desktop-app.

## Decision #280 (Braden, s54) — overrides the Open questions it answers
- **Counterpart source = both.** (a) `find_repeats` counts from connector reads the agent already makes: Sent mail (recipient address, normalized lower-case) and calendar series (series/recurring-master id) over the last 14 local days. (b) From now on the action log also records a normalized `counterpart` id in `data` on the writers the scout named: `chat_service.execute_action` (`chat_tool_ran`/`chat_tool_failed`: recipient address for reply/send) and `chat_service.read_result` (`chat_tool_read`: event series id for calendar). The counter merges (a) and (b), de-duplicated by source message/event id.
- **Note = its own same-day "Suggestion" note** (tag `suggestion`), never appended to the daily-summary note.
- Counterpart ids are company data: they stay in the person's drawer log and the model call only; never in git, fixtures (use fakes like `dana@example.test`), or swarm prompts.
- Implementation open questions (endpoint path, chat dispatch, drawer path helper, draft naming) follow existing patterns in the file the builder changes; draft name = `<action>-<8-hex of sha256(counterpart)>.yaml`, a repeat name overwrites the same draft.
- Extra tests: (9) a Sent-mail fake with 3 replies to one address in 14 days → proposal with no log history; (10) a logged `counterpart` on chat_tool_ran is counted and de-duplicated against the same message from Sent mail. Extra mutants: m9 drop the Sent-mail source; m10 drop de-duplication.

## Open questions
- Which existing log action/data field actually carries the counterpart identifier (sender
  address, meeting series id, forward target) is not established by any file read here — the
  producers for reply/meeting-prep/forward actions live in `local_service_adapters.py` /
  `chat_service.py` / `standing.py` (not read). `find_repeats` needs the exact field name(s)
  confirmed against whichever module logs those actions before it can run on real data.
- Whether "put on the daily note" means appending to the *same* note `daily_summary.py` writes
  (title `Daily summary <date>`, tag `daily-summary`) or a separate same-day note is not settled
  by decision #277's text; needs an owner decision before `notes.write` is wired.
- The exact Yes/No answer endpoint path/method and its Bearer-auth helper live in
  `local_service.py`, not in this job's context — the endpoint must match whatever pattern
  already exists there, not decided here.
- The chat-card trigger/dispatch for "any suggestions?" lives in `chat_service.py`, not in this
  job's context — this contract only fixes the `chat_tools.py` tool/schema side.
- `Drawer`'s public layout has no `skills/drafts/` attribute today; whether to add one (like
  `drawer.notes`) or have `proposals.py` build the path directly via `loop_storage.private_directory`
  is left to drawer.py's owner.
- Naming/collision rule for `skills/drafts/<name>.yaml` (how `<name>` is derived from
  action+counterpart, and what happens on a repeat name) is not specified by decision #277 or
  the ticket text.

## Orchestrator additions (s54, before build)
- **Wheel:** the orchestrator vendors `vendor/connectors-0.5.3-py3-none-any.whl` (connectors main 7843400) + pyproject pin + `[tool.uv.sources]` + uv.lock + PROVENANCE.md line before this job runs. The builder uses `gates.graph_read.sent_mail(...)` and `CalendarEvent.series_id` / `.id`; never edits vendor/.
- **When it runs:** once per local day, right after the daily-summary note is written on the existing daily-summary schedule path (no new schedule, no new clock), and on demand when the person asks "any suggestions?" in chat (returns today's pending proposal or runs the counter once if none yet today). Reads go through the same gates reader seam `daily_summary.py` uses (`GatesOutlookReader`), extended with `sent(since)` and `calendar_window(start, end)`; tests use fakes of that seam.
- **Note:** its own same-day note titled `Suggestion <date>`, tag `suggestion` (decision #280).
- **Counterpart logging (#280 b):** `chat_service.execute_action` / `read_result` add `counterpart` (normalized) to the logged `data` only when the tool call names one (recipient address, event series id); nothing else in those records changes.
- **Model call:** the one-sentence text uses the chat model client already used by chat_service (no new provider, no key handling). System text = a fixed code constant; the counted facts go in a separate labelled user message. If the model call fails, the note uses a fixed template sentence built from the facts (no retry loop). A fake model client in tests.
