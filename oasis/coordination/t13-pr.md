T13 adds `onboarding/v1/`: the agent's self-introduction in four short screens (what I am, what I watch, what I never do, how to pause me), the question set for role, ventures, day, tools, people and preferences with follow-ups, and a profile writer that turns those answers into a valid `profile.yaml` through `ProfileStore`. The "Can I watch this page?" first-visit prompt lives here too, with its own saved-answers store that tracks yes/no decisions per page and asks only pages that have never been answered.

The Python API in `garage.onboarding` exposes one session class and three methods: `OnboardingSession.pending_question_ids()` walks the current profile and includes a question only when its mapped field is missing or empty, so a second run asks only the gaps; `session.answer(question_id, value)` collects already-structured answers from the Rig's UI (the package never parses free text); `session.finish()` writes the merged profile atomically. For watch prompts at any time, `needs_prompt(answers, page)` is true only when the page has never been answered, and `apply_decision(answers, page, decision)` saves YES or NO (NOT_NOW is never persisted, so that page is asked again next visit). Delivered as a skill so it runs through the loop with the four T10 factory functions for each step.

Validation:
```
.venv/bin/pytest -q
41 passed in 0.21s
.venv/bin/ruff check .
All checks passed!
.venv/bin/ruff format --check .
30 files already formatted
.venv/bin/mypy --strict src/
Success: no issues found in 9 source files
```

The done-when requirement (Braden runs this as user zero in the Rig; his `profile.yaml` reads true to him; a second run asks only the gaps) is tested indirectly: `test_onboarding_session.py` asserts the exact gap list for a fresh profile, a fully-onboarded one, and one with a single field cleared back to empty; `test_onboarding_data.py` asserts intro screens contain no terminal/api/key/settings words; `test_onboarding_watch.py` covers all three watch decisions and independent-page tracking; and the skill's own three test_cases pass through the skills runner. Test fixtures use fake names only, and a full first run is asserted to produce a valid profile.yaml. The human acceptance parts—running through the Rig's UI and having the profile actually represent Braden—are pending until T12 (the Rig itself) exists. Two open questions for Braden remain: whether page-watch answers should mirror into `profile.yaml`'s optional `watch_answers` field (keeping them separate is a Phase 0 choice, not yet recorded in DECISIONS.md), and whether `access_level` should be set by an admin at provision time rather than asked as a plain-words question during onboarding. Dependency: this PR pins skills 0.2.1 from skills PR #3 (chore: pin agent-core 0.4.0); merge skills #3 first. Vendored wheel provenance records the chore branch commit 03c390d. Package version is 0.2.0; no release has been published. Base branch is main.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
