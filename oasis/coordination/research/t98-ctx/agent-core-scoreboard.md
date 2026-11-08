# T14 Scoreboard with T15 telemetry

`anorak.scoreboard` reads one agent drawer and writes
`scoreboard/YYYY-MM-DD.json` nightly plus `scoreboard/weekly.md` on Mondays.
It measures and reports only. Log content is counted and compared, never
executed.

Every record is bucketed into the window by the *same* zone the window's own
`today` was computed in (T66b): `compute_scoreboard`'s `zone` parameter
(default UTC, matching every scheduled/CI caller), threaded through one
helper, `_local_day(at, zone)`. `ScoreboardStep` takes `zone` as a callable
alongside its existing `clock` callable, and `service_cli.py` wires both to
the same `local_now()` the nightly/forced run already uses to decide
"today" -- never two different zones deciding the same night's window.



## Honest sources for all ten measures

All source records use T09's append-only `Log.record` envelope: `at`, `actor`,
`action`, `data`, `model`, and `cost_usd`.

| Measure | Source and calculation |
| --- | --- |
| Hours given back | `manual_baseline` watcher seconds minus completed `skill_run.duration_seconds`, summed for seven days |
| Tasks automated (#271) | skills whose last 3 runs (by `started_at`, over all history) are each first-try `done`, and whose first-try success rate over the 7-day window is at least 0.80 |
| Proposals accepted | yes / (yes + no), joining `proposal_answered` to `proposal_shown` by ID |
| Skill success rate | first-try completed runs / runs with explicit first-try telemetry |
| Answers with sources | `answer` records with at least one source (`cites_source`) / all answer records in the window |
| Time to yes | minutes from a shown proposal to its joined yes answer |
| Ask-first friction | `gate_prompted` count per day, yes share and median `seconds_to_answer` from `gate_answered` |
| Cost per task | `skill_run.cost_usd` / completed tasks, overall, by skill and by model |
| Trust | latest weekly orb `checkin.trust` in the window |
| Days used | latest weekly orb `checkin.days_used` in the window |
| Standing rule fires (T28) | plans run unattended (`chat_plan_standing`) in the window; `detail.per_rule` also carries each rule's window and lifetime fire count |

`TaskHooks` produces task start/end, duration, first-try/fix and its own
skill-side `gate_prompted`/`gate_answered` lines (`origin: "skill"`) from
committed T07 audit events; `ChatService` produces the chat-side pair
(`origin: "chat"`) beside its existing `chat_plan_preview`/
`chat_plan_declined`/`chat_plan_confirmed` lines. Either origin's
`gate_answered` logs `prompted_at`/`seconds_to_answer` as `null` (never a
guessed `0.0`) when its own `gate_prompted` was never seen -- e.g. a rig
restart between the card and the answer -- and the median simply leaves
those out. `anorak.telemetry.Telemetry` provides validated producers for
watcher baselines, proposal shown/answered, cited answers and weekly orb
check-ins. Proposal records are separate because the log is append-only; the
Scoreboard joins the first valid answer to its shown record.

Missing source data stays `not_measured` with a reason. The system does not
turn a missing baseline, missing check-in, unmatched proposal answer, missing
first-try field or absent source list into a zero or estimate.

## Producer API

```python
telemetry = Telemetry(drawer.log)
telemetry.record_manual_baseline(
    actor=agent_id, skill="daily-summary", duration_seconds=600, source="watcher"
)
telemetry.proposal_shown(actor=agent_id, proposal_id=proposal_id, proposal_type="daily-note")
telemetry.proposal_answered(actor=person_id, proposal_id=proposal_id, decision="yes")
telemetry.answer_recorded(
    actor=agent_id, answer_id=answer_id, thread_id=thread_id, sources=[source_reference]
)
telemetry.weekly_checkin(actor=person_id, trust=4, days_used=5)
telemetry.weekly_checkin(actor=person_id, skipped=True)
```

Source references are identifiers, not raw tool output. Validation rejects bad
ranges, negative durations, invalid decisions and credential-shaped values
before append. `answer_recorded` computes `cites_source` itself
(`bool(sources)`) rather than trusting a caller to report it; `weekly_checkin`
takes either `trust`+`days_used` or `skipped=True`, never both.

## Scheduled Scoreboard skill

`SKILL_YAML` declares `0 2 * * *`. The T15 clock now enforces that schedule.
Construct `DirectorySkillRegistry`, `LoopSkillScheduler` and `SkillClock` as
shown in `docs/clock.md`; the Scoreboard then runs through the same real
`LoopRunner` as every installed skill.

`anorak.scoreboard.install_builtin_skill` (T62) installs `SKILL_YAML` under a
drawer's `skills/scoreboard-nightly/skill.yaml` the first time rig-service
starts and finds no copy there -- `service_cli.py` calls it before building
the clock's own `DirectorySkillRegistry`. It never overwrites an existing
copy (a person's own edit, or an earlier install, is untouched) and logs one
`scoreboard.skill_installed` line only on the call that actually writes it,
so this is safe on every restart.

Each nightly run's own tool (`ScoreboardStep`) logs exactly one
`scoreboard.nightly_ran` line to the drawer's `log.jsonl`: `date`, `wrote`
(the relative paths written under `scoreboard/`), `measured`, `not_measured`
and `weekly` (whether Monday's `weekly.md` was written too). A failed run
logs `scoreboard.nightly_failed` (`date`, the error's class name) instead,
and -- since `write_daily_report` writes atomically -- never leaves a
partial daily report behind. `GET /scoreboard/latest` (`local_service.py`)
surfaces the newest such line as `lastRun`, `null` when there is none yet.

The weekly heading writer (`render_weekly_markdown`, via
`WEEKLY_HEADING_FORMAT`) and `GET /scoreboard/latest`'s reader
(`_SCOREBOARD_WEEKLY_HEADING_RE`) are built from the one shared format
constant, so they cannot drift apart the way they once did.

The Scoreboard tool computes the report. Its independent checker reopens the
daily JSON and verifies all ten names. Empty denominators remain
`not_measured`. The weekly report names the skill with the lowest first-try
success rate.

The implementation reads `events.jsonl` as part of the drawer contract, but
the ten measures come from `log.jsonl`. Cross-agent aggregation, self-tuning
and changes to skill code remain outside Phase 0.

## Feedback (T29, decision #144)

`proposals_accepted` also folds `feedback_recorded` lines whose
`data.target == "plan_report"` into the same yes/no/by_type tally --
`proposal_type="chat_plan"`, `decision="yes" if thumbs == "up" else "no"`,
added by the line's own `at`, no shown/answered join needed.
`skill_success_rate` looks up, per `skill_run` record, whether a
`feedback_recorded`/`feedback_edited` line names that run's own hashed
`entry_id` (a sha256 of the exact `log.jsonl` line, `anorak.memory.feedback.
skill_run_entry_id`); if so, its *latest* `thumbs` replaces `first_try and
outcome == "done"` for that one run -- `up` counts as done, `down` as not
done, in either direction. A run with no feedback is unchanged.

The weekly report additionally groups feedback notes given in the window
(`feedback_notes_in_window`, joining `feedback_recorded` log lines to
`FeedbackStore`'s own latest-wins note text) into a "What people said"
bullet list, one line per group: `"N said: '<note>'"`. `ScoreboardStep`
takes an optional `model` (a small `NoteGroupingModel`, `async def
complete`); when supplied and there is at least one note, one model call
(`group_feedback_notes`) groups near-duplicate notes together -- fixed,
code-owned system text only, every note travelling as its own labelled user
message, never folded into system text (#73) -- and the call is logged
(`feedback_notes_grouped`: who, model, cost) exactly like every other model
call. With no `model` configured, or on any failure (a raised exception or
a reply that does not match the required `N said: "<note>"` shape), grouping
falls back to plain exact-text matching (`casefold().strip()`) with no
model call at all, logging `feedback_notes_group_failed` (a fixed reason,
never note text) only when a call was actually attempted and failed. The
scheduled Scoreboard skill's own budget is now `max_usd: 1.0` (was `0.0`)
to allow for this one small, capped (`$0.50`) call on a Monday.
