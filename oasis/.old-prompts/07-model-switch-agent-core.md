# Prompt — T07 Model switch (agent-core)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T07 — Model switch (agent-core)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `agent-core`
**Build:** `src/anorak/models/` with one interface (`complete`, `stream`, `tools`) and adapters for Anthropic (Claude), OpenRouter, and Ollama. Model is chosen from config per agent and per skill, never in code. Cost per call is computed from a price table and logged. Spend alerts: cumulative spend crossing each $500 line triggers a notification hook.
**Done when:** The T06 test skill runs unchanged on two providers; cost appears in the log; the $500 hook fires in a test with a fake price table.

Finish with the done report from `AGENTS.md`.
