# Prompt — T14 Scoreboard nightly skill v1 (agent-core)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T14 — Scoreboard nightly skill v1 (agent-core)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `agent-core`
**Build:** `src/anorak/scoreboard.py` as a scheduled skill (`0 2 * * *`). Reads `log.jsonl` and `events.jsonl` for one agent and computes the ten measures in PLAN.md "Scoreboard": hours given back, tasks automated, proposals accepted, skill success rate, answers with sources, time to yes, ask-first friction, cost per task, plus the two weekly check-in values when present. Writes `scoreboard/YYYY-MM-DD.json` and a plain-words `scoreboard/weekly.md` every Monday. v1 only measures and reports; the tune-on-its-own actions (model switch, stop a rejected proposal) are Phase 1 tickets and must not be built here.
**Tests:** A fixture log of two weeks of synthetic runs with known answers; the ten numbers match; the weekly report names the skill with the lowest success rate.
**Done when:** Runs nightly on Braden's agent (user zero) and produces correct numbers from his real log; weekly report reads in plain words.

Finish with the done report from `AGENTS.md`.
