# Prompt — T11 Thin Windows shell: the Rig (desktop-app)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T11 — Thin Windows shell: the Rig (desktop-app)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `desktop-app`
**Build:** Tauri 2 app. Sign in (company Microsoft account). Chat panel talking to the local `agent-core` service. Connect page with tiles reading from the T10 catalog and driving its flows. Activity log view reading `log.jsonl`. Pause button (stops the watcher and shows state). **Orb**: always-on-top small window, draggable, click opens the side panel, `Ctrl+Space` hotkey, glow state from a local API flag, right-click menu (pause, hide 1h, open app). Background service registered to start at login. Signed installer (`.msi`/`.exe`); auto-update from a GitHub release feed.
**Done when:** Installs on a clean Windows machine; orb appears above every window; Connect Gmail works end to end from the tile; the app updates itself from a test release.

Finish with the done report from `AGENTS.md`.
