# For Braden in the morning — 2026-10-02 (night shift, decision #344)

Things only you can do, in the order that unblocks the most:

0. **Codex is out of credits (05:50Z, run 1790912696307-b62f16f7: "Your workspace is out of credits").** Refill if you want Codex back; until then (and until Claude returns 23:00Z) the only code worker is OpenRouter Sonnet 5.5 for files under ~15 KB. project-swarm 1.44.0 is parked as WIP on worktrees/swarm-ac (fix round 1 contract written, 14 reds to clear; see TASK.md).

1. **Public lessons wording (2 min):** `git -C worktrees/swarm-public-lessons show --stat HEAD` then read `docs/lessons.md` entries 192–203 there. Say "wording OK" → I push that branch and merge it (decision #343 shipped the code without it). Also the T80 publish template (same file, same OK).
2. **Private store rule:** `lesson import` skips 89 of 301 rows that hold private terms (strict, #159 provisional). Keep strict, or check only at `publish`? Default tonight: strict.
3. **App checks on your Mac** (mac-checks.md rows "T83 orb sheet", T50 polish, T77, T79): orb animates while a reply is written, celebrate once on Done, standard-pack switch; Coworkers page v2; Add a pack.
4. **"Swap models"**: I could not tell what you meant. If it is the seat model, that is your `/model`. If it is a worker or the rig's profile route, name the model.
5. Still open from before: connectors/playbooks "skip" or "add win32 mypy"; flake quarantine format (T51 item 5); T33 #336; T74/T75 PAT + Windows box; T64 slices 1/5; T66–T68; T76.

6. **T91 design choice (decision #347a):** how does a person first sign in to a site (TurboTenant for T93) without the agent ever typing credentials? Options: a headed "connect this site" window the person types into (the agent only watches for the session cookie), or the person signs in once in their own browser and we import that profile (Chrome 136+ refuses attaching to a live profile). Default until you say: headless only; T93 assumes the session already exists.
7. **T63 "Home card":** the Suggestion card is merged (desktop-app#57, Home + chat). Say what you want changed; a harness view for it needs a shell worker.
8. **Codex credits** still out (probe at 16:03Z).
