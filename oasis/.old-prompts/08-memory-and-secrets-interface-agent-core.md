# Prompt — T08 Memory and secrets interface (agent-core)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T08 — Memory and secrets interface (agent-core)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `agent-core`
**Build:** `src/anorak/memory/`: four stores in the person's drawer folder — `profile.yaml`, working memory (in-process, summarized to log at task end), append-only `log.jsonl`, and `notes/` (markdown, searchable with a simple local index). `src/anorak/secrets.py`: `get(name)`, `set(name, value)`, `list()` over the OS keychain (Windows Credential Manager, macOS Keychain) using `keyring`. Values are never returned to logs or exceptions. Also emits **network events** (`node_created`, `link_used`, …) to `events.jsonl` for every skill run, connector use and drawer read — the shape is in PLAN.md "Network data model".
**Done when:** Profile survives a restart; a secret is set and read without ever appearing in any output; a test greps the whole test output for the fake secret and finds nothing; events file has correct nodes and links after one skill run.

Finish with the done report from `AGENTS.md`.
