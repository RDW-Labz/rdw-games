# Prompt — T05 Macro format v1 and replay (remote)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T05 — Macro format v1 and replay (remote)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `remote`
**Build:** `src/remote/macro.py`. Reads a scrubbed trace, groups calls by service, infers **constants** (same value every time) vs **arguments** (values that changed or look like IDs/names), writes `macros/<name>.remote` (plain YAML: name, arguments, steps[], each step with request template, `ask_first: bool`, `rollback?`). `remote <name> <args>` replays it, pausing on `ask_first` steps. Tokens for replay come from the secrets interface, never from the trace.
**Done when:** One recorded two-service task replays with one changed argument and produces the same result; an `ask_first` step pauses and waits.

Finish with the done report from `AGENTS.md`.
