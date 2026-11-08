# Prompt — T09 Memory and network events (agent-core)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T09 — Memory and network events (agent-core)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `agent-core`
**Build:** `src/anorak/memory/`: four stores in the person's drawer folder — `profile.yaml`, working memory (in-process, summarized to log at task end), append-only `log.jsonl`, and `notes/` (markdown, searchable with a simple local index). Secrets are already handled by T02; this ticket only calls that interface. Also emits **network events** (`node_created`, `link_used`, …) to `events.jsonl` for every skill run, connector use and drawer read — the shape is in PLAN.md "Network data model".
**Done when:** Profile survives a restart; working memory is summarized into the log at task end; events file has correct nodes and links after one skill run.

Finish with the done report from `AGENTS.md`.
