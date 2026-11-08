# onboarding-v1

**Goal:** introduce the agent in plain words, learn who this person is, and
write their `profile.yaml`.

**Steps**

1. `show_intro` — the self-introduction screens: what I am, what I watch,
   what I never do, how to pause me (`intro.yaml`,
   `garage.onboarding.data.load_intro_screens`).
2. `collect_answers` — ask only the currently pending questions (missing or
   empty `profile.yaml` fields) from the data-driven question set
   (`questions.yaml`, `garage.onboarding.session.OnboardingSession`).
3. `write_profile` — write the collected answers into `profile.yaml`
   through `anorak.memory.ProfileStore` (`garage.onboarding.writer`). Never
   asks for or accepts `access_level`: a new profile defaults it to
   `member`, and an existing value (set by Braden during provisioning) is
   preserved unchanged on every run (DECISIONS.md #31, #38).
4. `ask_watch_page` — the first-visit "Can I watch this page?" prompt and
   its saved-answers store (`garage.onboarding.watch.WatchAnswers`). Yes/No
   are mirrored into `profile.yaml`'s `watch_answers` field — the
   canonical saved-answer store (DECISIONS.md #23, #38) — whenever a
   profile already exists; Not now is never saved anywhere.

**Done when:** `profile.yaml` has every required field filled and reads
true to the person.

**Risky steps:** `write_profile` is the one step that changes the stored
profile, so it is listed under `risky_steps` in `skill.yaml` and the loop
gates it on a yes. The other three steps only read, present screens, or
record the single watch/no-watch answer the person just gave for one page
— never a person's core identity or role fields — so none of them are
risky or `always_ask`, even though `ask_watch_page` may also mirror that
same already-given answer into `profile.yaml`.

**Second run:** `collect_answers` only ever asks the ids
`garage.onboarding.session.gap_question_ids` reports as still missing or
empty; an already-answered question is never asked again. `ask_watch_page`
only records a decision the first time a given page is seen (per
`garage.onboarding.watch.WatchAnswers`) — a page already answered yes or no
is never asked again either.

**Test cases:** `skill.yaml` → `test_cases` lists three cases, each
pointing at a `fixtures/*.yaml` file: a brand-new person's first run, a
second run with only one gap left, and an already-onboarded person
declining to watch a new page. `almanac.runner` replays each through the
T07 loop in place of the real steps above (no real name, page or client
data is used anywhere in these fixtures).
