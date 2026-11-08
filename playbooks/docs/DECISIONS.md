# Decisions log

One line per decision. Newest at the bottom. Change a decision by adding a new line, never by editing an old one.

| # | Date | Decision | Why |
|---|---|---|---|
| 1 | 2026-09-18 | Build agents first (Amber, then Michael), shared pipeline third | Two real users teach us what the pipeline needs |
| 2 | 2026-09-18 | Amber's agent starts watch-only and earns "do" tools | Trust is the product |
| 3 | 2026-09-19 | One private GitHub repo per piece, versions pinned between them | Isolated builds; a broken watcher never touches an agent |
| 4 | 2026-09-19 | Repos live under `Btabor11` during the build; transfer to the company org when working | Braden has admin; transfer keeps history |
| 5 | 2026-09-19 | Product name OASIS; codenames from Ready Player One | Braden's call; needed before app registration |
| 6 | 2026-09-19 | Cloud host: Azure, one VM + Postgres (pgvector) + Blob, everything in Docker | Team is on Microsoft 365; Docker keeps it portable to own hardware |
| 7 | 2026-09-19 | Windows first (Amber), Mac in the same codebase from day one | Not everyone will be on Windows |
| 8 | 2026-09-19 | No API spend cap; alert Braden at every $500; route through OpenRouter where possible | Braden's call; one place to see spend |
| 9 | 2026-09-19 | Braden approves each phase gate | One approver |
| 10 | 2026-09-19 | REMOTE (Zemeckis) is concept only; built from scratch, scrubber first | The one thing that must not be wrong |
| 11 | 2026-09-19 | Amber has full access to every venture, including Bin-There Bought That | She oversees all of them |
| 12 | 2026-09-21 | Watcher has full access by default; asks "Can I watch this page?" once per site/app and saves the answer | Company machines; ask once, never again |
| 13 | 2026-09-21 | Desktop app: Tauri 2 + TypeScript/React; browser extension for Edge/Chrome; always-on orb + side panel + hotkey | Light and quiet for an always-on app; switch to Electron only if Phase 0 finds a blocker |
| 14 | 2026-09-21 | Scoreboard is its own agent; phase gates require targets met two weeks running | Measurement must be automatic and act on itself |
| 15 | 2026-09-21 | Network data model (nodes, links, events, one visibility rule) collected from Phase 0; 3D view (the Stacks) parked to Phase 4+ | No second data collection later |
| 16 | 2026-09-21 | Fleet upgrades: every agent self-upgrades nightly after passing its own tests; Scoreboard rolls back regressions; core rolls out in stages | Agent 1 stays as capable as agent 10 |
| 17 | 2026-09-21 | Backend in Python 3.12 (uv, pytest, ruff, mypy); UI in TypeScript | Best AI/agent tooling; mitmproxy exists for the watcher proxy |
| 18 | 2026-09-21 | Secrets: Phase 1 uses the OS keychain behind one `secrets` interface; Phase 3 swaps in the shared vault (Keys) behind the same interface | No sprawl to clean up later |
| 19 | 2026-09-21 | Secrets interface is ticket T02, built in Phase 0 with the OS keychain behind it | Registrations, macros and connectors all need it before memory would have built it |
| 20 | 2026-09-21 | Scoreboard v1 (measure and report only) is ticket T14 and closes Phase 0; tune-on-its-own actions are Phase 1 | Amber measured from day one; no self-tuning before there is data |
| 21 | 2026-09-21 | Phase 0 "thin" Rig = orb, side panel chat, Connect page, activity log, pause, installer, auto-update. No onboarding polish, Docs area, Scoreboard tab or Mac installer yet | The orb is the product's face; without it Amber has nothing to trust |
| 22 | 2026-09-21 | Macros never enter git; they live in the person's private drawer. Shareable only once turned into a skill with company data replaced by arguments | Macros hold client names and task data |
| 23 | 2026-09-21 | Watch consent: Yes (this site from now on), No (never), Not now (ask next visit). "Full access" means no permission barrier, not "watch before asking" | One question, answered once, no ambiguity |
| 24 | 2026-09-21 | Ask-first on risky steps cannot be relaxed by anyone until the skill passes the injection suite; then Scoreboard proposes one step at a time; `always_ask` steps never relax | Prompt injection is risk #2 |
| 25 | 2026-09-21 | Personal-to-shared skill approval: Braden in Phases 0–2; any admin from Phase 3 | One approver while small |
| 26 | 2026-09-21 | Graph visibility = the data role gate (venture + sensitivity), narrowed for members to owned or linked nodes; admins pass the gate for all | One rule, never wider than data access |

## Open

- What replaces QuickBooks Online, and when? Keep the QBO connector for history.
- Confirm the exact SharePoint sites, OneDrive folders and Google Drive shares during Amber's onboarding.
