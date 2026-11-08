# Onboarding script v1 (T13)

`onboarding/v1/` is a shared skill (T10 format: `SKILL.md` + `skill.yaml` +
`test_cases`/fixtures) plus the Python behind its steps in
`src/garage/onboarding/`. Phase 0 is thin: no UI, no voice, no Rig code
lives here. Everything below is a plain Python API and four skill steps
the Rig (T12) calls once it has its own UI.

## Screens (the self-introduction)

`onboarding/v1/intro.yaml`, loaded by `garage.onboarding.data.load_intro_screens`
(the wheel force-includes `intro.yaml`, `questions.yaml` and `skill.yaml` under
`garage/onboarding/v1/` so an installed, vendored copy loads its own data).
Four short screens, one idea each, plain words for a non-technical
employee — no terminal, key, or settings talk:

1. `what_i_am` — a coworker that lives on your computer, learning how you
   work.
2. `what_i_watch` — with a yes, it watches the apps/pages you use for
   work; a new site or app always gets a first-visit "Can I watch this
   page?" ask.
3. `what_i_never_do` — never sends, pays, signs, or shares outside the
   company without asking first; everything it does is in the activity
   log.
4. `how_to_pause_me` — one click pauses all watching; nothing is lost
   while paused.

`tests/test_onboarding_data.py` asserts these screens never contain
"terminal", "api key", "token", or "settings".

## Questions → `profile.yaml` fields

`onboarding/v1/questions.yaml`, loaded by `garage.onboarding.data.load_questions`.
Each question's `field` is exactly where its answer lands in
`profile.yaml` (a dotted field such as `preferences.tone` reaches into the
`preferences` mapping). Follow-ups are asked right after their parent and
extend the same field (list answers are concatenated).

| question id           | profile.yaml field       | follow-up(s)                        |
|------------------------|--------------------------|--------------------------------------|
| `q_name`               | `name`                   |                                       |
| `q_title`               | `title`                   |                                       |
| `q_reports_to`          | `reports_to`              |                                       |
| `q_ventures`            | `ventures`                 |                                       |
| `q_tools`               | `tools`                    | `q_tools_more`                       |
| `q_day`                 | `day`                      | `q_day_more`                         |
| `q_people`              | `people`                   | `q_people_more`                      |
| `q_pref_tone`           | `preferences.tone`         |                                       |
| `q_pref_ask_before`     | `preferences.ask_before`   |                                       |
| `q_pref_quiet_hours`    | `preferences.quiet_hours`  |                                       |

There is no `access_level` question. `access_level` is a data-role
decision, admin-set outside onboarding (DECISIONS.md #31, #38), not
something a non-technical employee is asked to frame for themselves — see
"access_level: admin-set, never asked" below. `garage.onboarding.data.load_questions`
refuses `questions.yaml` outright if a question's `field` is `access_level`.

The Rig's own UI collects the actual answer for each question and calls
`OnboardingSession.answer(question_id, value)` with an already-structured
value (a string, a list, or — for `people` — a list of
`{name, role, how_often}` mappings). No free-text parsing happens here.

## The writer

`garage.onboarding.writer.write_answers(store, answers)` merges the
collected answers onto whatever `profile.yaml` already has (via
`ProfileStore.load_or_none()`), constructs a validated
`anorak.memory.Profile`, and saves it through `ProfileStore.save()` —
never bypassed. A key of `"preferences.<name>"` sets one entry inside
`preferences`; anything else replaces a top-level field. Fields the
current answers do not touch (including a `watch_answers` block mirrored
in by the watch-prompt step) are carried over unchanged. Structural
fields (`ventures`, `tools`, `people`, `day`, `preferences`) default to
empty when a profile does not exist yet; the three identity fields
(`name`, `title`, `reports_to`) have no default — if one is still
missing, `Profile(...)` raises `MemoryStoreError` and nothing partial is
ever written.

### `access_level`: admin-set, never asked

`access_level` defaults to `"member"` when a profile does not exist yet,
and `merge_answers` drops an `"access_level"` key from `answers` outright
— even if one were somehow present, it is never applied. Onboarding
itself never produces such a key (there is no question for it), so this
is defense in depth for the rule in `docs/DECISIONS.md` #31: access level
is Braden's provisioning decision, made outside onboarding by writing
`"admin"` directly onto the profile; once set, every later onboarding run
(gap-fill or otherwise) leaves it exactly as it was.
`tests/test_onboarding_writer.py` covers the default, the ignored input,
and admin surviving a run.

## Files in the drawer

| file | store | written by |
|---|---|---|
| `profile.yaml` | `anorak.memory.ProfileStore` | the writer (`write_profile` step); mirrored into by the watch-prompt step |
| `watch_answers.yaml` | `garage.onboarding.watch.WatchAnswers` | the watch-prompt step, one page at a time |

`profile.yaml`'s optional `watch_answers` field
(`repos/skills/docs/formats.md`) is the canonical, human-visible
saved-answer store (DECISIONS.md #23, #38): every Yes/No is mirrored
there, through `ProfileStore` (validated, atomic), whenever a profile
already exists. `watch_answers.yaml` remains a small file of its own
alongside it, because a page can be answered before onboarding has
produced a valid, complete `profile.yaml` — each write there only touches
the one page just answered (read the whole small mapping, set one key,
atomically replace the file). A read merges both, with `profile.yaml`
treated as the base and the local file as the freshest layer, so nothing
already answered — before or after a profile exists — is ever asked
again.

## The "Can I watch this page?" prompt

`garage.onboarding.watch.needs_prompt(answers, page)` is true only when
`page` has never been answered. `apply_decision(answers, page, decision)`
saves `WatchDecision.YES`/`NO` (`True`/`False`) to `watch_answers.yaml`
and, when a profile already exists, mirrors the same value into
`profile.yaml`'s `watch_answers` field; `NOT_NOW` is never persisted
anywhere, so the same page is asked again next visit. Once a page has a
saved yes or no, it is never asked again — `tests/test_onboarding_watch.py`
covers all three decisions, independent-page tracking, the profile
mirror, and recording a decision before a profile exists.

## Second-run behaviour

`garage.onboarding.session.gap_question_ids(profile, questions)` (and
`OnboardingSession.pending_question_ids()`) walks the question set in
order and includes a question — and its follow-ups — only when its mapped
field is missing or empty (`None`, `""`, `[]`, or `{}`) on the current
profile. A field with a real answer is never asked again, even if a later
run's profile still lacks other fields. `tests/test_onboarding_session.py`
asserts the exact list of ids for a fresh profile, for a fully-onboarded
one (`[]`), and for one with a single field cleared back to empty.

## The checker: `onboarding_profile_complete`

`onboarding/v1/skill.yaml`'s `checker: onboarding_profile_complete` is built
by `garage.onboarding.checker.make_profile_complete_checker(store)`
(decision #64). It is plain code, never a model — `skill.yaml`'s
`budget.max_usd` for this skill is `0.0`, and the checker always reports
`cost_usd=0.0`, `model=None`. It never trusts a step's own reported
`CheckContext.result` (a step could lie about having written the profile);
it always re-reads `profile.yaml` from the `ProfileStore` it was built with.
It passes only when all three hold:

1. Every field in `garage.onboarding.writer.REQUIRED_FIELDS` is present and
   non-empty on the stored profile (a structural field such as `ventures`
   still defaulting to `[]` counts as missing).
2. The profile loads and validates through `ProfileStore`/`Profile` at all —
   a missing or unreadable `profile.yaml` fails outright.
3. Every code in the profile's `ventures` list exists in `ventures.yaml`
   (`garage.ventures.load_ventures`); an unknown code fails and is named.

Failure text names only the missing fields or unknown venture codes — never
any other profile value. An agent-core `LoopRunner` registers this callable
under `CHECKER_NAME` (`"onboarding_profile_complete"`, matching `skill.yaml`'s
`checker:` value) in the `checkers` mapping it passes to run this skill.
`tests/test_onboarding_checker.py` covers a complete profile, each missing
field named, an unknown venture code named, a missing `profile.yaml`, a
lying `context.result`, and that the checker never reports a model or cost.

## How the Rig calls it

Plain Python, no loop required for a one-off call:

```python
from anorak.memory import Drawer
from garage.onboarding import OnboardingSession

drawer = Drawer(person_drawer_path)
session = OnboardingSession(store=drawer.profile)
for question_id in session.pending_question_ids():
    ...  # show the screen/prompt, collect the answer from the Rig's UI
    session.answer(question_id, value)
session.finish()  # writes profile.yaml through ProfileStore
```

For a Rig that drives onboarding through `anorak.loop.LoopRunner` (so it
is logged, budgeted, and the profile write is gated on a yes),
`garage.onboarding.steps` has one factory per `onboarding/v1/skill.yaml`
step (`make_show_intro_tool`, `make_collect_answers_tool`,
`make_write_profile_tool`, `make_ask_watch_page_tool`) — each returns a
plain `anorak.loop.Tool` closed over the session/answers/decision the
Rig's UI already collected, ready to register by the step's `do` name.

Watch prompts, for a page visit at any time (not just during onboarding):

```python
from garage.onboarding.watch import WatchAnswers, WatchDecision, apply_decision, needs_prompt

answers = WatchAnswers(drawer)
if needs_prompt(answers, page_host):
    decision = ...  # the orb's yes/no/not-now, from the Rig's UI
    apply_decision(answers, page_host, decision)
```

## Limitations (Phase 0, intentionally thin)

- No UI, no voice, no NLP: the Rig's own screens ask the plain-words
  questions and hand back already-structured answers; this package never
  parses free text.
- No branching or conditional follow-ups: a question's follow-ups are
  always asked right after it while the parent field is a gap. There is
  no logic here that skips a follow-up based on the parent's answer.
- `watch_answers.yaml` still exists alongside `profile.yaml`'s mirrored
  `watch_answers` field, because a page can be answered before a profile
  exists to receive the mirror; see "The 'Can I watch this page?' prompt"
  above.
- No connector, model, or browser calls anywhere in this package; secrets
  are out of scope (T11 connect flows own tokens).
- Braden running this as user zero in the Rig, and "his `profile.yaml`
  reads true to him," are human acceptance and stay pending — this v1 is
  covered by tests, not by a live Rig run.

## Resolved (DECISIONS.md #23, #31, #38)

Two questions this doc previously left open for Braden are now settled:

- Page-watch answers mirror into `profile.yaml`'s `watch_answers` field,
  which is the canonical, human-visible saved-answer store; the dedicated
  `watch_answers.yaml` remains only as the pre-profile / always-available
  working store (DECISIONS.md #23, #38).
- `access_level` is never an onboarding question. It is an admin-set data-
  role decision: new profiles default to `member`, and Braden sets `admin`
  during provisioning, outside onboarding (DECISIONS.md #31, #38).
