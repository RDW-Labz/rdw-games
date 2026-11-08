# Prompt — T10 Connector catalog and Gmail/Outlook connect flows (connectors)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T10 — Connector catalog and Gmail/Outlook connect flows (connectors)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `connectors`
**Build:** `catalog/` with one `connector.yaml` per connector (Gmail, Outlook, Outlook Calendar, Google Calendar, OneDrive, Google Drive, Teams first). `src/gates/connect.py`: given a connector and a person, opens the provider's consent page in the system browser, receives the callback on `127.0.0.1`, stores the token via the secrets interface, tests the connection (one read call), refreshes on expiry. Emits plain-words step descriptions for the UI ("Click Allow on the screen that just opened") and plain-words errors ("Gmail said no. Try again or ask Braden.").
**Done when:** Braden connects Gmail and Outlook with clicks only; tokens in keychain; a `status` command shows both as Connected; a forced expiry refreshes silently.

Finish with the done report from `AGENTS.md`.
