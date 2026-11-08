## T01 — Repo template and CI (playbooks)
## T02 — Secrets interface (agent-core)
## T03 — App registrations (connectors)
## T03b — Public pages, Google verification, and Microsoft admin consent (connectors)
## T04 — Scrubber with leak tests (remote)
## T05 — Local proxy on Windows (remote)
## T06 — Macro format v1 and replay (remote)
## T07 — Loop runner (agent-core)
## T08 — Model switch (agent-core)
## T09 — Memory and network events (agent-core)
## T10 — Skill format, test runner, three starter skills (skills)
## T11 — Connector catalog and Gmail/Outlook connect flows (connectors)
## T12 — Thin Windows shell: the Rig (desktop-app)
## T12b — Local agent-core service for the Rig (agent-core)
## T13 — Onboarding script v1 (playbooks)
## T14 — Scoreboard nightly skill v1 (agent-core)
## T15 — Skill clock and complete task telemetry (agent-core)
## T16 — Skill tool bindings for scheduled skills (agent-core)
## T17 — Orb v2: the avatar system (desktop-app, agent-core, skills)
## T18 — Orb voice (desktop-app)
## T19 — OASIS UI upgrade: the Rig, the Orb, onboarding (desktop-app)
## T21 — Chat threads (agent-core, desktop-app)
## T22 — Avatar library (desktop-app)
## T23 — Themes (desktop-app)
## T24 — Quick chat under the orb (desktop-app; agent-core only if an API is missing)
## T25 — Remember this (agent-core, desktop-app)
## T26 — Avatar generator skill (playbooks)
## T27 — Chat uses tools (agent-core, desktop-app)
## T28a — Injection test suite (agent-core; connectors fakes)
## T28 — Standing permissions (agent-core, desktop-app)
## T29 — Feedback loop (agent-core, desktop-app)
## T27b — Full recipients for reply-all (connectors, agent-core)
## T27c — Honest chat actions (agent-core, connectors) — P0
## T34 — Connector write audit (connectors)
## T30 — App icon (desktop-app)
## T27d — Honest pending text, card first, Teams send refusal (agent-core, desktop-app)
## T31 — Opening splash (desktop-app)
## T32 — Reader/critic convention for skills (skills)
## T33 — Month-end close skill for Amber (skills, connectors)
## T40 — Enter the OASIS (desktop-app; agent-core for the network feed)
## T41 — Reply shape + safe Markdown in chat (agent-core, desktop-app)
## T42 — Idle budget (desktop-app; agent-core for the service line)
## T43 — Formatted emails (agent-core, connectors, desktop-app)
## T44 — Disconnect + account line (agent-core, connectors, desktop-app)
## T46 — Animated tier for avatar packs (skills formats, playbooks, agent-core, desktop-app)
## T47 — One-step rig install (agent-core)
## T48 — Honest reads, early Teams refusal, search-first recap (agent-core, connectors)
## T49 — Orb hover controls (desktop-app) — queued after T31
## T50 — Holo coworker cards (desktop-app) — queued after T49
## T51 — CI and ship speed (project-swarm + every repo's CI)
## T51a — Flake metric that tells a flake from real red (coordination tool + project-swarm) — rescope from the T51 baseline, first
## T51b — desktop-app PR gate: Windows-first, macOS to `full` (desktop-app CI) — rescope from the T51 baseline, second; amended by #263
## T52 — orb as the swarm's UI verifier (scout only) — queued after T48 ships
## T52b — `swarm verify --orb` (project-swarm) — after T52 (#262)
## T53 — Animation shortlist (research scouts) — queued after the T52 scout
## T54–T60 — Research scouts (decision #251) — queued after T53
### T54 — Sound (`sound-shortlist.md`)
### T55 — Signing and updates (`signing-updates.md`)
### T56 — Prompt-injection tests (`injection-datasets.md`)
### T61 — Ask-first exit test (agent-core + skills) — from T56 (#265)
### T57 — Local vector store (`vector-store.md`)
### T58 — Watcher and scrubber (`watcher-scrubber.md`)
### T59 — Write APIs (`write-apis.md`)
### T60 — On-device models (`on-device-models.md`)
### T62 — Scoreboard check (agent-core, small) — #266
### T63 — Proposals v1 (agent-core + desktop-app, after T31 leaves desktop-app) — #266
### T64 — Watcher v1, Windows (remote) — #266, #267
### T61b — Live-model exit test (agent-core) + skills email-reply — #268, #270, #273
### T65 — Daily-summary failures (agent-core + skills, small) — Braden s51
### T66 — Scoreboard events (agent-core, needs Braden) — #271
### T67 — Account refresh never sent (agent-core + connectors, needs Braden) — #278
### T68 — Stream decoder refuses new usage fields and blocks (agent-core, needs Braden) — #287
### T69 — Keychain get failing every ~3 s since 09-27 (agent-core, small) — #287
### T70 — Mask credentials read from mail/Teams in chat and summaries (agent-core, needs Braden) — #289
### T74 — Windows install: one installer, service bundled, Credential Manager (desktop-app + agent-core, needs Braden) — #316, #317
### T75 — Windows updater + oasis-releases repo (desktop-app + agent-core, needs Braden) — #317
### T76 — agent-amber role file v1 (agent-amber + skills + remote, needs Braden) — #328, #329, #330
### T77 — Coworkers page v2 (desktop-app, under #288; screenshots before merge) — Braden 2026-10-01
### T78 — Eight theme avatar packs from the r1 sets (playbooks + agent-core bundling) — decision #338
### T79 — Pack import route (agent-core; desktop "Add a pack" wiring after) — decision #339
### T83 — Orb renders a tiny 3×1.5 slice of an animated-tier pack sheet (desktop-app) — Braden 2026-10-02
### T85 — Preview harness: four stale captures (desktop-app) — night shift 2026-10-02
## T80 — Lesson tool: log, route, ship and publish swarm lessons by command (project-swarm) — Braden typed 2026-10-01, decision #340
## T81 — Speed pipeline: one command from manifest to merged PR; workers run their own checks (project-swarm) — Braden typed 2026-10-01, decision #341
## T91 — Browser tool (agent-core) — Braden typed 2026-10-02
## T92 — Read-only web fetch through T91 (rag-pipeline) — Braden typed 2026-10-02
## T93 — First browser skill: utility bill draft (skills) — Braden typed 2026-10-02
### T93b — Bind utility-bill-draft's actions in agent-core (agent-core; needs Braden: browser + ask-first) — found 2026-10-06 (s73)
## T87 — OneDrive live: write reach with ask-first (connectors, agent-core; needs Braden) — Braden typed 2026-10-05
## T88 — QuickBooks read-only live (connectors; needs Braden) — Braden typed 2026-10-05
## T89 — Outlook Calendar live (connectors; needs Braden) — Braden typed 2026-10-05
## T90 — To Do + Planner into the daily note (connectors, skills, agent-core) — Braden typed 2026-10-05
## T94 — Dock polish (desktop-app) — Braden typed 2026-10-05
## T91d — Yes on the browser card approves the site for the task and resumes it (agent-core hotfix) — Braden typed 2026-10-05
## T91e — Browser card shows Done after Yes; read starts with title + h1-h3 (agent-core hotfix) — Braden typed 2026-10-05
## T91g — One-line browser answers, no phantom card; say when a page has no headings (agent-core hotfix) — Braden typed 2026-10-05
## T96 — "Sign in to this site": the person signs in once in a window of their own (agent-core + desktop-app; needs Braden) — Braden typed 2026-10-06
## T97 — Settings → Sites: allowed and signed-in sites with Forget (desktop-app + agent-core) — Braden typed 2026-10-06; LATER, not now
## T98 — Research: tinyhumansai/openhuman memory tree + run journal (research only; no code) — Braden typed 2026-10-06
