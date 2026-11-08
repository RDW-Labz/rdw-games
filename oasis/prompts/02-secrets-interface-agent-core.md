# Prompt — T02 Secrets interface (agent-core)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T02 — Secrets interface (agent-core)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `agent-core`
**Build:** `src/anorak/secrets.py`: `get(name)`, `set(name, value)`, `delete(name)`, `list()` over the OS keychain (Windows Credential Manager, macOS Keychain) via `keyring`, behind one small interface so the Phase 3 vault (Keys) can replace the backend with no caller changes. Values never appear in logs, exception messages, `repr`, or test output. A `secrets` CLI for Braden to set a value without it echoing to the terminal.
**Tests:** Set, get, delete round-trip with a fake secret `sk-FAKE-0000`; a test that captures all stdout/stderr/log output during the suite and asserts the fake never appears; a test that a `KeyError` message does not contain the value.
**Done when:** All tests pass on Windows and macOS CI; ticket T03 can store client IDs through it.
**Why second:** T03 (registrations), T06 (macro replay) and T11 (connectors) all need a place to put a key before T09 would have built it.

Finish with the done report from `AGENTS.md`.
