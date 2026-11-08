# Prompt — T07 Loop runner (agent-core)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T07 — Loop runner (agent-core)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `agent-core`
**Build:** `src/anorak/loop.py` plus `src/anorak/scheduler.py`. The loop takes a `skill.yaml` (goal, done_when, steps, checker, risky_steps, budget, resources). The scheduler runs N loops as workers (default 4), grants declared resources (shared: connector, model, agent-browser-tab; exclusive: file, screen, person-attention), queues by priority (direct request > unblocked > scheduled > proactive), and keeps other workers alive when one fails. The loop runs: plan → act one step → check (checker is a callable that is **not** the model: a test, a diff, a compare, or a second model with a different prompt) → fix from the failure text (max 3 per step) → done-when check → log. Budgets: max steps, max seconds, max spend; hitting one stops with a report. `risky_steps` pause and wait for a yes via a callback. Every turn appends a JSON line to the log: plan, action, check result, cost, actor, timestamp.
**Tests:** A fake tool and a real checker; a skill that must fail its checker twice then pass; a skill that hits its step budget; a risky step that waits; two tasks needing the same exclusive file run one after the other while a third with a shared resource runs alongside; one worker crashing leaves the others running; two ask-first prompts never show at once.
**Done when:** All seven tests pass; the log for each run is complete and replayable and names the worker and resources held.

Finish with the done report from `AGENTS.md`.
