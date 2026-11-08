# Prompt — T03 App registrations (connectors)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T03 — App registrations (connectors)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `connectors`
**Build:** `docs/registrations.md` with step-by-step for registering "OASIS" as an app in Microsoft Entra (delegated scopes: Mail.Read, Mail.Send, Calendars.ReadWrite, Files.Read.All, Sites.Read.All, Chat.Read, User.Read) and Google Cloud (Gmail, Calendar, Drive scopes; OAuth consent screen). Client IDs and the Microsoft tenant ID go into the secrets interface, never the repo. A script `scripts/check_registration.py` checks readiness with fake-token requests; it does not prove real sign-in, consent, or authenticated access. Authenticated verification belongs to T11.
**Done when:** IDs stored + Microsoft passes + Google probe passes.
**Note:** Google verification, public pages/domain prerequisites, and Microsoft admin consent are T03b, not blockers for T03.

Finish with the done report from `AGENTS.md`.
