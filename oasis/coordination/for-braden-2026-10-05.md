# For Braden — 2026-10-05 (session 72)

Things only you can do, in the order that unblocks the most:

1. **Rig is off.** The Mac rebooted on 10-02 ~21:06 local; nothing listens on 4405. Run `bash coordination/tools/rig_restart.sh` (gate → pull → sync → start → verify). It also brings agent-core 0.7.60 = the browser tool. I did not restart it (your rule).

2. **T93 sign-in hand-off (decision #347a, was For-Braden 6 on 10-02).** The browser tool is headless, so today the utility-bill-draft skill can only *stop* at a sign-in page; nobody can type the password anywhere. Pick one:
   - **(a) "Connect this site" window (recommended):** a headed window opens once, you sign in yourself, the agent only waits for the session cookie and never sees the keystrokes. Lands as a new ticket (T94) in agent-core + a Settings button.
   - **(b) Import your Chrome profile:** Chrome 136+ refuses attaching to a live profile; would need a copy of the profile directory, which also copies every other saved login. Not recommended.
   Until you pick, T93 merges but its done-when ("you run it on a real saved session") stays **not met**; the Mac-check row only proves the stop-at-sign-in path and the submit gate on the fake pages.

3. **Codex credits** still out (last probe 10-02). Refill if you want the big-file worker back; project-swarm's own CLI file (385 KB) and T86 (worktree relocation) need it or an Opus file-tools job.

4. Still open from 10-02: public lessons wording 192–209 (local branch `swarm-public-lessons-192-203`); T80 publish template OK; app checks (mac-checks.md rows T83 orb sheet, T75 updater, T50 polish + T77); connectors/playbooks "skip" or "add win32 mypy"; flake quarantine format (T51 item 5); T33 #336; T74/T75 PAT + Windows box; T64 slices 1/5; T66–T68; T76; T61b dev-run cap (#270/#321: $4 was not enough for 150 cases on Sonnet 5.5 — raise to ~$8 or shrink the sample to 25 per set).

5. **Windows installer CI needs a token (T74/T75):** desktop-app's `windows installer (OASIS-Setup.exe)` job fails on main because it checks out the private agent-core repo and the repo secret `AGENT_CORE_READ_TOKEN` is not set. Add a fine-grained PAT with read-only Contents on RDW-Labz/agent-core as that secret in RDW-Labz/desktop-app (Settings → Secrets → Actions). Until then OASIS-Setup.exe is not built.

