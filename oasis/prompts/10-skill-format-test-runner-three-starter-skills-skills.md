# Prompt — T10 Skill format, test runner, three starter skills (skills)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T10 — Skill format, test runner, three starter skills (skills)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `skills`
**Build:** `docs/formats.md` defining `profile.yaml`, `skill.yaml`, `connector.yaml` (fields in PLAN.md "Phase 0 → Formats"). `src/almanac/runner.py`: loads a skill folder, runs its `test_cases` through the T07 loop with recorded fixtures, reports pass/fail. Three shared skills, each with `SKILL.md`, `skill.yaml`, 3 test cases: `daily-summary` (calendar + unread → short note), `file-filing` (move a downloaded file to the right folder by rules in the profile), `meeting-prep` (next meeting → one-page brief from notes and email).
**Done when:** All three pass 3/3 through the runner; a fourth skill with no test cases is refused by the runner.

Finish with the done report from `AGENTS.md`.
