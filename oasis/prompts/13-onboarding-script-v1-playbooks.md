# Prompt — T13 Onboarding script v1 (playbooks)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T13 — Onboarding script v1 (playbooks)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `playbooks`
**Build:** `onboarding/v1/`: the agent's self-introduction (what I am, what I watch, what I never do, how to pause me) in short screens; the question set (role, ventures, day, tools, people, preferences) with follow-ups; a writer that turns answers into `profile.yaml`; the "Can I watch this page?" first-visit prompt and its saved-answers store. Delivered as a skill so it runs through the loop.
**Done when:** Braden runs it as user zero in the Rig; his `profile.yaml` reads true to him; a second run skips answered questions and asks only the gaps.

Finish with the done report from `AGENTS.md`.
