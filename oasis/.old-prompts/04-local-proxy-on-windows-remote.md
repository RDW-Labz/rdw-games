# Prompt — T04 Local proxy on Windows (remote)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T04 — Local proxy on Windows (remote)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `remote`
**Build:** `src/remote/proxy.py` on top of `mitmproxy`. `remote learn "<task>"` starts it on `127.0.0.1:7788`, installs the local CA cert (Windows cert store, with a clear uninstall), sets the system proxy, and streams every request through the scrubber to a raw trace file. `remote stop` restores proxy settings and closes the trace. Handles apps that pin certificates by logging "unseen: <host>" instead of breaking them.
**Done when:** On a Windows test box, records Edge, Chrome and desktop Outlook traffic; restores settings cleanly on stop; unseen hosts listed, not broken.

Finish with the done report from `AGENTS.md`.
