# Phase 0 tickets — Foundations

> **Windows first (#263, 2026-09-28):** Windows is the primary desktop target, Mac secondary. In every open ticket, a done-when or check that says "on Braden's Mac" means: passes on Windows (WebView2) first, then on Braden's Mac. Closed tickets are unchanged.

Work these in order. One PR per ticket. Each has a done-when that a test or a person can check. Full context is in `PLAN.md`, sections "Phase 0" and "Repos".

Phase 0 ends when Braden is user zero: the Rig installed on his Windows machine, Gmail connected with clicks only, one macro recorded and replayed, one skill run through the loop on two models, everything logged, Scoreboard producing its first nightly numbers.

---

## T01 — Repo template and CI (playbooks)

**Repo:** `playbooks`, then applied to all nine.
**Build:** A template folder with `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/`, `src/`, `tests/`, `.gitignore`, `.github/workflows/ci.yml`. Python repos get `pyproject.toml` (uv, pytest, ruff, mypy). `desktop-app` gets `package.json` + Tauri scaffold. CI runs tests, lint and types on every PR.
**Done when:** All nine repos exist under `Btabor11`, private, CI green on an empty test.

## T02 — Secrets interface (agent-core)

**Repo:** `agent-core`
**Build:** `src/anorak/secrets.py`: `get(name)`, `set(name, value)`, `delete(name)`, `list()` over the OS keychain (Windows Credential Manager, macOS Keychain) via `keyring`, behind one small interface so the Phase 3 vault (Keys) can replace the backend with no caller changes. Values never appear in logs, exception messages, `repr`, or test output. A `secrets` CLI for Braden to set a value without it echoing to the terminal.
**Tests:** Set, get, delete round-trip with a fake secret `sk-FAKE-0000`; a test that captures all stdout/stderr/log output during the suite and asserts the fake never appears; a test that a `KeyError` message does not contain the value.
**Done when:** All tests pass on Windows and macOS CI; ticket T03 can store client IDs through it.
**Why second:** T03 (registrations), T06 (macro replay) and T11 (connectors) all need a place to put a key before T09 would have built it.

## T03 — App registrations (connectors)

**Repo:** `connectors`
**Build:** `docs/registrations.md` with step-by-step for registering "OASIS" as an app in Microsoft Entra (delegated scopes: Mail.Read, Mail.Send, Calendars.ReadWrite, Files.Read.All, Sites.Read.All, Chat.Read, User.Read) and Google Cloud (Gmail, Calendar, Drive scopes; OAuth consent screen). Client IDs and the Microsoft tenant ID go into the secrets interface, never the repo. A script `scripts/check_registration.py` checks readiness with fake-token requests; it does not prove real sign-in, consent, or authenticated access. Authenticated verification belongs to T11.
**Done when:** IDs stored + Microsoft passes + Google probe passes.
**Note:** Google verification, public pages/domain prerequisites, and Microsoft admin consent are T03b, not blockers for T03.

## T03b — Public pages, Google verification, and Microsoft admin consent (connectors)

**Repo:** `connectors`
**Build:** Complete the external launch prerequisites documented in `docs/registrations.md`: public OASIS homepage and privacy page on the company-owned `cluerholdings.com` domain, domain ownership/branding prerequisites, Google restricted-scope verification submission with truthful scope justifications and a real consent/use demo, and Microsoft delegated admin consent. Braden will arrange for the Cluer 365 administrator to sign in. Keep existing internal tools private; record status and evidence without IDs, tokens, or invented approvals.
**Checks:** Confirm the public pages are reachable without sign-in, required domain/branding checks pass, Google acknowledges the submission, and Microsoft shows the requested delegated permissions granted by the administrator.
**Done when:** Public pages and domain prerequisites complete; Google verification submitted with real evidence; Microsoft admin consent granted.
**Gate:** Blocks T11 Gmail connect, not T03. Any required Google approval remains a Gmail release prerequisite. If the verification demo needs unfinished T11 work, bring that sequencing dependency to Braden during T03b; do not silently bypass this gate or invent authenticated evidence.
**Note:** Start early; provider review and administrator availability may take time.

## T04 — Scrubber with leak tests (remote)

**Repo:** `remote`
**Build:** `src/remote/scrubber.py`. Input: a raw HTTP trace (method, URL, headers, body). Output: same trace with secrets masked as `••••••`. Masks: `Authorization`, `Cookie`, `Set-Cookie`, any header or field named like `key|token|secret|password|passwd|auth|session|csrf`, query-string values for those keys, and any string value with Shannon entropy above a threshold and length ≥ 16. Constants and short human values survive. Reports only a count of secrets removed, never the values. **Fails toward hiding**: when unsure, mask.
**Tests:** `tests/fixtures/traces/` with 200 synthetic traces across 20 fake services, each with planted fake secrets and a manifest of what must survive. `test_no_leaks.py` asserts zero planted secrets in output and all manifest constants present.
**Done when:** 0 leaks on 200 traces; a secret never appears in any log or stdout during tests.

## T05 — Local proxy on Windows (remote)

**Repo:** `remote`
**Build:** `src/remote/proxy.py` on top of `mitmproxy`. `remote learn "<task>"` starts it on `127.0.0.1:7788`, installs the local CA cert (Windows cert store, with a clear uninstall), sets the system proxy, and streams every request through the scrubber to a raw trace file. `remote stop` restores proxy settings and closes the trace. Handles apps that pin certificates by logging "unseen: <host>" instead of breaking them.
**Done when:** On a Windows test box, records Edge, Chrome and desktop Outlook traffic; restores settings cleanly on stop; unseen hosts listed, not broken.

## T06 — Macro format v1 and replay (remote)

**Repo:** `remote`
**Build:** `src/remote/macro.py`. Reads a scrubbed trace, groups calls by service, infers **constants** (same value every time) vs **arguments** (values that changed or look like IDs/names), writes `macros/<name>.remote` into the person's private drawer, never a git repo (macros hold client names and task data) (plain YAML: name, arguments, steps[], each step with request template, `ask_first: bool`, `rollback?`). `remote <name> <args>` replays it, pausing on `ask_first` steps. Tokens for replay come from the secrets interface, never from the trace.
**Done when:** One recorded two-service task replays with one changed argument and produces the same result; an `ask_first` step pauses and waits.

## T07 — Loop runner (agent-core)

**Repo:** `agent-core`
**Build:** `src/anorak/loop.py` plus `src/anorak/scheduler.py`. The loop takes a `skill.yaml` (goal, done_when, steps, checker, risky_steps, budget, resources). The scheduler runs N loops as workers (default 4), grants declared resources (shared: connector, model, agent-browser-tab; exclusive: file, screen, person-attention), queues by priority (direct request > unblocked > scheduled > proactive), and keeps other workers alive when one fails. The loop runs: plan → act one step → check (checker is a callable that is **not** the model: a test, a diff, a compare, or a second model with a different prompt) → fix from the failure text (max 3 per step) → done-when check → log. Budgets: max steps, max seconds, max spend; hitting one stops with a report. `risky_steps` pause and wait for a yes via a callback. Every turn appends a JSON line to the log: plan, action, check result, cost, actor, timestamp.
**Tests:** A fake tool and a real checker; a skill that must fail its checker twice then pass; a skill that hits its step budget; a risky step that waits; two tasks needing the same exclusive file run one after the other while a third with a shared resource runs alongside; one worker crashing leaves the others running; two ask-first prompts never show at once.
**Done when:** All seven tests pass; the log for each run is complete and replayable and names the worker and resources held.

## T08 — Model switch (agent-core)

**Repo:** `agent-core`
**Build:** `src/anorak/models/` with one interface (`complete`, `stream`, `tools`) and adapters for Anthropic (Claude), OpenRouter, and Ollama. Model is chosen from config per agent and per skill, never in code. Cost per call is computed from a price table and logged. Spend alerts: cumulative spend crossing each $500 line triggers a notification hook.
**Done when:** The T07 test skill runs unchanged on two providers; cost appears in the log; the $500 hook fires in a test with a fake price table.

## T09 — Memory and network events (agent-core)

**Repo:** `agent-core`
**Build:** `src/anorak/memory/`: four stores in the person's drawer folder — `profile.yaml`, working memory (in-process, summarized to log at task end), append-only `log.jsonl`, and `notes/` (markdown, searchable with a simple local index). Secrets are already handled by T02; this ticket only calls that interface. Also emits **network events** (`node_created`, `link_used`, …) to `events.jsonl` for every skill run, connector use and drawer read — the shape is in PLAN.md "Network data model".
**Done when:** Profile survives a restart; working memory is summarized into the log at task end; events file has correct nodes and links after one skill run.

## T10 — Skill format, test runner, three starter skills (skills)

**Repo:** `skills`
**Build:** `docs/formats.md` defining `profile.yaml`, `skill.yaml`, `connector.yaml` (fields in PLAN.md "Phase 0 → Formats"). `src/almanac/runner.py`: loads a skill folder, runs its `test_cases` through the T07 loop with recorded fixtures, reports pass/fail. Three shared skills, each with `SKILL.md`, `skill.yaml`, 3 test cases: `daily-summary` (calendar + unread → short note), `file-filing` (move a downloaded file to the right folder by rules in the profile), `meeting-prep` (next meeting → one-page brief from notes and email).
**Done when:** All three pass 3/3 through the runner; a fourth skill with no test cases is refused by the runner.

## T11 — Connector catalog and Gmail/Outlook connect flows (connectors)

**Repo:** `connectors`
**Gate:** T03b blocks Gmail connect. Resolve its verification-demo dependency with Braden before starting dependent authenticated work; required provider approval and Microsoft admin consent must be in place before the corresponding connection is released.
**Build:** `catalog/` with one `connector.yaml` per connector (Gmail, Outlook, Outlook Calendar, Google Calendar, OneDrive, Google Drive, Teams first). `src/gates/connect.py`: given a connector and a person, opens the provider's consent page in the system browser, receives the callback on `127.0.0.1`, stores the token via the secrets interface, tests the connection (one read call), refreshes on expiry. Emits plain-words step descriptions for the UI ("Click Allow on the screen that just opened") and plain-words errors ("Gmail said no. Try again or ask Braden.").
**Done when:** Braden connects Gmail and Outlook with clicks only; tokens in keychain; a `status` command shows both as Connected; a forced expiry refreshes silently.

## T12 — Thin Windows shell: the Rig (desktop-app)

**Repo:** `desktop-app`
**Build:** Tauri 2 app. "Thin" means exactly this list, nothing more: no onboarding polish, no Docs area, no Scoreboard tab, no Mac installer yet (Mac must still build). Sign in (company Microsoft account). Chat panel talking to the local `agent-core` service. Connect page with tiles reading from the T11 catalog and driving its flows. Activity log view reading `log.jsonl`. Pause button (stops the watcher and shows state). **Orb**: always-on-top small window, draggable, click opens the side panel, `Ctrl+Space` hotkey, glow state from a local API flag, right-click menu (pause, hide 1h, open app). Background service registered to start at login. Signed installer (`.msi`/`.exe`); auto-update from a GitHub release feed.
**Done when:** Installs on a clean Windows machine; orb appears above every window; Connect Gmail works end to end from the tile; the app updates itself from a test release.

## T12b — Local agent-core service for the Rig (agent-core)

**Repo:** `agent-core`
**Build:** A local HTTP/WebSocket service for the Rig, bound to loopback only and matching `repos/desktop-app/docs/local-api.md` exactly. It serves the status/glow and pause controls, Microsoft sign-in and connector tile flows, the activity-log path, and the `/chat` WebSocket stream. Provider and tool text crossing the API is data, never instructions. The service obtains its local service token through the T02 `secrets` interface; no secret is written to source, logs or responses. It writes the well-known per-user port file and refuses non-loopback binds.
**Tests:** Exercise every HTTP endpoint and the WebSocket message sequence with a local fake backend; assert loopback-only binding, token retrieval through the secrets interface, port-file fallback and safe rejection of malformed input. Tests use only fake tokens and provider data.
**Done when:** The service matches the local-api contract for chat, connect tiles, activity-log path, pause and orb glow; starts on loopback with a secrets-backed token and writes a valid port file; all tests, lint and strict types pass.

**Approved auth delivery (2026-09-22):** T12b is two reviewable PRs: one in `agent-core` for the service and one narrow companion in `desktop-app` for client/contract authentication. Endpoint paths and JSON payloads remain unchanged. Both use the existing SecretStore entry `rig.service_token` in OS-keychain service `OASIS`; HTTP sends a Bearer token and WebSocket auth uses `Sec-WebSocket-Protocol` with client protocols `["bearer", token]`, never a URL token. Braden approves both PRs separately; neither is merged by the worker.

~~**Approved startup gate (2026-09-22):** The service refuses startup without a concrete real watcher backend. A fake backend is test-only and must not provide production pause/glow state. Missing watcher/T05 wiring blocks live Rig startup, while contract implementation and fake-backed tests may proceed; T05 remains a draft pending Windows evidence.~~ Superseded by decision #41.

**Startup without watcher (2026-09-22, #41):** The service starts without a watcher backend. It keeps real local pause and glow state, pauses the T15 clock on pause, and writes "watcher: not connected" to the activity log until T05 is wired in. Fake backends are test-only. T05 remains a draft pending Windows evidence.

## T13 — Onboarding script v1 (playbooks)

**Repo:** `playbooks`
**Build:** `onboarding/v1/`: the agent's self-introduction (what I am, what I watch, what I never do, how to pause me) in short screens; the question set (role, ventures, day, tools, people, preferences) with follow-ups; a writer that turns answers into `profile.yaml`; the "Can I watch this page?" first-visit prompt. The canonical saved-answers store is `profile.yaml`'s `watch_answers` mapping (decision #23); Yes and No answers are mirrored there, while Not now remains unsaved so the prompt returns next visit. `access_level` is never asked during onboarding: new profiles default to `member`, and Braden sets `admin` during provisioning. Delivered as a skill so it runs through the loop.
**Done when:** Braden runs it as user zero in the Rig; his `profile.yaml` reads true to him; a second run skips answered questions and asks only the gaps.

## T14 — Scoreboard nightly skill v1 (agent-core)

**Repo:** `agent-core`
**Build:** `src/anorak/scoreboard.py` as a scheduled skill (`0 2 * * *`). Reads `log.jsonl` and `events.jsonl` for one agent and computes the ten measures in PLAN.md "Scoreboard": hours given back, tasks automated, proposals accepted, skill success rate, answers with sources, time to yes, ask-first friction, cost per task, plus the two weekly check-in values when present. Writes `scoreboard/YYYY-MM-DD.json` and a plain-words `scoreboard/weekly.md` every Monday. v1 only measures and reports; the tune-on-its-own actions (model switch, stop a rejected proposal) are Phase 1 tickets and must not be built here.
**Tests:** A fixture log of two weeks of synthetic runs with known answers; the ten numbers match; the weekly report names the skill with the lowest success rate.
**Done when:** Runs nightly on Braden's agent (user zero) and produces correct numbers from his real log; weekly report reads in plain words.

## T15 — Skill clock and complete task telemetry (agent-core)

**Repo:** `agent-core`
**Build:** The clock reads the schedule on every installed `skill.yaml`, submits due skills to the T07 scheduler at their scheduled time, and performs one bounded catch-up run after the process wakes from sleep. It must use the existing scheduler priorities/resources and keep scheduled work from bypassing ask-first gates. Add the append-only log records needed by T14 so all ten Scoreboard measures can compute: proposal shown and answered timestamps/decision, and task start and end timestamps, with actor, data, model, time and cost fields preserved.
**Tests:** Use an injected clock and fake scheduler to cover due dispatch, no duplicate dispatch, one catch-up after sleep, malformed or missing schedules, paused service, and scheduler failure. Fixture logs prove proposal acceptance/time-to-yes and task duration measures are computed without secrets or raw tool text.
**Done when:** Installed schedules dispatch through T07 on time; one catch-up happens after sleep; no schedule bypasses pause or ask-first behavior; all ten T14 measures compute from the resulting log records; tests, lint and strict types pass.


## T16 — Skill tool bindings for scheduled skills (agent-core)

**Repo:** `agent-core`
**Build:** Register the real tools and `done_when` checkers that installed skills name (the registered action names in `skill.yaml` `do`, decision #33) into the `LoopRunner` that `rig-service` builds for the T15 clock, so a scheduled skill runs for real instead of failing closed. Use only existing action and connector implementations; an unknown action still fails closed with a plain log line. Resources, pause and ask-first gates stay in the T07 scheduler. Decision #47.
**Tests:** One starter skill scheduled through the real clock → scheduler → LoopRunner path completes with fake connectors; an unknown action fails closed and logs; a `risky_steps` step still pauses for ask-first; pause stops the dispatch.
**Done when:** A starter skill scheduled by the clock runs end to end in `rig-service` with fake connectors; unknown actions fail closed; all tests, lint and strict types pass.

---

## After T14

`agent-amber` (Art3mis) is created from `playbooks/agent-template`. First Phase 1 tickets: Scoreboard tune-on-its-own actions, injection test suite for "do" tools, Zemeckis "Teach me this" button in the orb, personal-to-shared skill promotion flow.

---

# Phase 1 tickets

## T17 — Orb v2: the avatar system (desktop-app, agent-core, skills)

**Repo:** `desktop-app` (engine, Settings), `agent-core` (profile field + local API to read the library and switch), `skills` (`docs/formats.md`: avatar manifest + `avatar:` field)
**When:** First Rig ticket of Phase 1, after the Mac guide (Mac-build PR) merges. Decisions #56, #74, #75.
**Build:** The orb becomes an avatar system. One animation engine in the Rig reads any avatar pack: a YAML manifest (name, artist, palette, status-light anchor, other anchor points) plus a sprite sheet on the fixed grid of decision #75 (128x128 px frames; one row per state in the fixed order idle, working, asking, proposal ready, done, needs attention, paused, offline; 4 frames per row; 6 fps). The engine shows the eight API states as the three looks of #74, drawn at the status-light anchor, the same for every pack. The engine also draws an ambient glow around the character and a soft ground shadow under it, both driven by the state's look (calm: faint or none; active: soft pulse; needs you: brighter glow in step with the blink; paused and offline: no glow), the same for every pack and never baked into a sprite sheet (decision #79). Glow and shadow pixels are click-through like every other transparent or semi-transparent pixel; only the character's opaque pixels take clicks. Pack one is Beacon, drawn in the style of Higgsfield candidate 4 (`coordination/references/orb-sketches/higgsfield/candidate-4.png`) for all eight states, with the revision-2 fixes (light rim so it reads on dark; working and asking poses read clearly at the 128 px on-screen size). A pack validator (plain code) refuses a pack whose sheet is off-grid, whose manifest is missing a field, or whose anchor is outside the frame. `avatar:` in profile.yaml picks the pack (default Beacon). A Settings screen in the full app shows the library and switches the avatar live, no restart; the Rig writes the choice through the local service, never the file directly. Kept from the first T17 scope: our own art only; a truly transparent window with no box on macOS or Windows; the whole character drags; one small chat button opens the side panel's chat; the native right-click menu is never clipped; empty transparent pixels click through via the Rust cursor-poll toggle of `set_ignore_cursor_events` (~60 fps) from `docs/research/rig-framework-tauri-vs-electron.md`; not a large transparent sheet; `Ctrl+Space` behaves as in T12. No voice (T18). Beacon and the test pack are bundled in the app (decision #78); the downloaded library is T22.
**Tests:** The engine plays any valid pack (Beacon plus a second test pack of plain colored blocks); each state maps to exactly its look, glow and shadow, and a mutation check on the state mapping (swap two states, drop one, map a needs-you state to calm) makes a test fail; clicks on glow and shadow pixels pass through; the validator refuses off-grid sheets, missing fields and bad anchors; each of the eight states shows its look; switching in Settings changes the orb without a restart and writes `avatar:`; drag works from any point on the character; the chat button opens chat; the menu is fully visible at every screen edge; clicks on empty pixels reach the window underneath; the poll's CPU cost is measured and stays low; the orb permission set grants only what these features need.
**Done when:** On Braden's Mac (and on Windows when a box exists), Beacon floats with no box, shows all eight states in three looks, drags, opens chat, shows a full menu, passes clicks through empty pixels, and switches live to the test pack from Settings; all tests, lint and types pass.

## T18 — Orb voice (desktop-app)

**Repo:** `desktop-app` (voice button, speech bridge in the Rust shell, Get started step); `agent-core` only if the Get started step or the action log needs a field it doesn't have yet.
**When:** Phase 1, after T17 and T24. Decisions #56, #90, #91, #92.
**Build:** A voice button on the Orb v2 character (and in the quick box). Tap to start listening, tap again or 2 s of silence to stop; while listening the orb shows the `working` look (no new state row; a dedicated listening look can come with T19). Speech-to-text is the OS's built-in speech (macOS Speech framework through the Tauri shell; Windows later). The words fill the quick chat box (T24) and are never sent until the person presses Send. Microphone ask: an optional "Turn on voice" step in first-run Get started (one plain line on why, then the OS prompt); Skip means the Rig asks on the first press of the voice button instead, and Get started never asks again (#70). If permission is denied, the button explains in one line how to turn it on in System Settings and does nothing else. Every transcription is logged (who, when, engine, length; never the audio).
**Tests:** tap/tap and 2 s of silence both stop listening; the transcript lands in the quick box and nothing is sent without Send (a test fails if a transcript reaches the chat API on its own); denied permission shows the one-line help and never starts listening; Skip in Get started leads to the ask on first press, and Get started does not ask again; the log entry holds no audio or transcript text. Mutation check on the send path (auto-send the transcript, skip the permission check, keep listening after stop) makes a test fail.
**Done when:** On Braden's Mac, Get started offers voice; after Skip, the first press asks; tapping the orb's voice button, saying "what's on my calendar today", and tapping again puts those words in the quick box, and Send runs them; all tests, lint and types pass.

## T19 — OASIS UI upgrade: the Rig, the Orb, onboarding (desktop-app)

**Scope:** `prompts/20-ui-upgrade.md` (the full UI upgrade). Orb final polish is part of T19, not its own ticket; T17 ships Beacon as avatar pack one (decision #75). T19's design system is token-based from the start (colors, type, radius, motion, sounds read from a token file at runtime), so T23 Themes is a data change, not a rewrite (decision #77).

**Layout (Braden, 2026-09-24, decision #84):** reference `coordination/references/app-layout-ref.png`, for layout only, not the look. Left rail, top to bottom: New chat, Chats, Skills, Connect, Activity, Scoreboard, then Recents (recent threads). Empty state: Beacon centered with "What should we do today, <first name>?" (the person's own name from the profile). Bottom composer: attach, an "ask before acting" toggle, the model route picker, and a mic placeholder for T18. T24's quick box under the orb is the small version of this same composer component.

## T21 — Chat threads (agent-core, desktop-app)

**Repo:** `agent-core` (storage, service, context), `desktop-app` (left rail)
**When:** Phase 1, right after T13 finishes (T13 PR B and the Rig onboarding screen), ahead of the "After T14" list. Decision #67. Three PRs: agent-core storage + `/chats`; agent-core thread context + summaries; desktop-app rail.
**Build:**
- **Storage:** one file per thread in the person's drawer, `chats/<thread-id>.jsonl`, plus `chats/index.json` (id, title, created, last message, message count). Never in git. Same privacy rules as notes (private files through the drawer's storage primitives).
- **Service:** `/chats` list, create, get, append, rename, delete. Delete asks first. Every chat request carries a thread id, and every reply is appended to that thread.
- **Context:** the model gets the full thread until it nears the budget. Then the oldest turns are summarized into a thread summary that stays at the top of the thread (the T09 working-memory rule). Every summary is logged.
- **Rig:** a left rail with the thread list, search (plain local text match over the person's own titles and messages, done in the service, never fed to the model), "New chat", auto-title after the first reply (one small model call through the model switch, logged, given only that first exchange as data), click to resume, rename and delete. `Ctrl+Space` keeps its show/hide toggle; showing the panel selects the newest thread.
- **Memory boundary:** memory across threads stays in notes and the profile. The agent never reads other threads.
**Tests:** resume after a service restart keeps the thread; the summary kicks in at the budget; delete pauses for a yes.
**Done when:** the three tests pass in CI, and on Braden's Mac a thread survives a restart, resumes from the rail, and deletes only after a yes; all tests, lint and types pass.

## T22 — Avatar library (desktop-app)

**Repo:** `playbooks` (`avatars/` pack sources, signed release), new public `RDW-Labz/oasis-assets` (release assets only), `agent-core` (download, signature check, cache, serve), `desktop-app` (library in Settings, Get started step)
**When:** Phase 1, after T17. Ships before Amber's install. Decisions #76, #78. Stop and ask Braden for the signing key setup before the first release.
**Build:** New avatar packs in themed sets: arcade '80s, deep space, galactic hitchhiker, desert planet, retro robot, animal coworkers. For each theme, six candidates (Higgsfield, transparent background, front view), a contact sheet, and Braden picks; each pick becomes a full pack on the T17 grid (all eight states) and passes the T17 validator. Every design is original, inspired by a mood: never a recognizable character, name, logo or catchphrase from any film, book or game. Delivery (decision #78): pack sources live in playbooks `avatars/`; each library release is signed and published to the public `RDW-Labz/oasis-assets` repo; agent-core's local service downloads a pack on demand, checks the signature, caches it in `~/.oasis/avatars/` and serves it to the Rig, logging each download; a bad signature is refused and nothing is cached. A person's own custom pack in their drawer shows in the library too, after it passes the validator. The Settings library shows every pack. First-run Get started gains an optional "Pick your coworker" step; skip = Beacon. It is optional, so it is never re-asked (#70).
**Tests:** Every shipped pack passes the validator; a tampered or unsigned download is refused and not cached; a cached pack works offline; a drawer pack that fails the validator is not listed; the library lists each pack with its name and artist; the Get started step saves `avatar:` and Skip leaves Beacon.
**Done when:** The six themed packs Braden picked ship in the app, and on Braden's Mac a fresh Get started lets him pick one and the orb shows it; all tests, lint and types pass.

## T23 — Themes (desktop-app)

**Repo:** `desktop-app` (theme packs, runtime tokens, Settings), `skills` (`docs/formats.md`: theme token file + `theme:` field), `agent-core` (profile field + local API)
**When:** Phase 1, after T22 and T19. Decisions #77, #78.
**Build:** A theme is a pack: a YAML token file (colors, type, radius, motion, sounds) with required light and dark variants, plus an optional matching avatar. Delivery is the same shape as avatars (decision #78): one default theme bundled; the library signed and published to `RDW-Labz/oasis-assets`, downloaded and verified by the service, cached in `~/.oasis/themes/`; a custom theme in the drawer. The Rig reads tokens at runtime, so switching is live. Each T22 avatar set ships with a matching theme (deep space avatar, deep space workspace). `theme:` in profile.yaml; picked in the same Settings screen as the avatar; picking a set's avatar in Get started brings its theme. CI runs a contrast check so no theme can fail WCAG AA in either variant.
**Tests:** Switching theme updates the Rig without a restart and writes `theme:`; every shipped theme has both variants; the CI contrast check fails on a deliberately low-contrast test theme and passes on every shipped theme.
**Done when:** Every T22 set has its matching theme, all pass the AA check in light and dark, and on Braden's Mac switching theme in Settings changes the whole Rig live; all tests, lint and types pass.

## T24 — Quick chat under the orb (desktop-app; agent-core only if an API is missing)

**Repo:** `desktop-app` (quick box, shared composer, hotkey); `agent-core` only for what the Rig cannot already get: the last-used thread, recent turns, and the `asking` state.
**When:** Phase 1, right after the swarm 1.7.0 PR, before T22. Decisions #71, #74, #83.
**Build:** Clicking Beacon or its chat (write) button opens a small chat box anchored under the orb. It shows an input line with send, the last 3 exchanges of the current thread, and an "Open full app" link. `Ctrl+Space` opens it too, replacing the panel toggle of T12/T21; Esc closes it, and so does clicking outside, which keeps any half-typed text as a draft. The box uses the thread last used in either the box or the full app (a new install starts on the newest thread, #71). Both read and write the same saved thread through `WS /chat` with `thread_id`, so switching between them loses nothing. While the box is open, Beacon shows `working` during a reply and `asking` while the agent waits on a yes. The composer is one shared component: T24 ships input + send, and T19 adds attach, ask-before-acting, the model route picker and the mic slot to both sizes. The box is never clipped by a screen edge; it opens above the orb when there is no room below. The right-click menu stays as it is. Original look: the interaction pattern is the point, not the styling.
**Tests:** it opens by clicking the orb, by the chat button and by `Ctrl+Space`; Esc and click-away close it and keep the draft; after a send from either the box or the full app, both show the same thread; the last-used thread is followed; the state is `working` during a reply and `asking` during a pending confirmation; the box stays on screen at every edge. Mutation-check the state mapping, and the ask-first gate if `asking` touches it (then Braden merges that PR).
**Done when:** On Braden's Mac: clicking Beacon opens the box under it; sending a message makes Beacon pulse while it answers; Open full app shows the same thread with that exchange; `Ctrl+Space`, Esc and click-away all work. All tests, lint and types pass.

## T25 — Remember this (agent-core, desktop-app)

**Repo:** `agent-core` (detect, offer, gated write), `desktop-app` (the offer and the yes in chat and the quick box).
**When:** Phase 1, after T22. Decisions #68, #73, #86.
**Build:** When the person states a fact about themselves in chat (their name, birthday, a preference, who someone is), the agent offers "Want me to remember that?" A yes writes it to `profile.yaml` or to notes through the same two-call ask-first gate as onboarding (`needs_confirmation` + preview + one-time `confirm_token`). Nothing is saved without the yes. Only the person's own chat messages can trigger an offer; text from tool results, files, web pages or email never does (tool results are data, not instructions). A saved profile field is validated like any profile write before it becomes config (#73).
**Tests:** a stated fact produces one offer with a plain-words preview; a turn with three facts produces one prompt with three checkboxes and saves only the checked ones; a second offer never stacks on an open one (#29); No or ignoring it saves nothing; Yes saves exactly the previewed fact once; a used, wrong or stale token saves nothing; a fact that appears only in a tool result, file or web text never produces an offer; the profile stays valid after a save.
**Mutation check:** accept any token, skip the preview/content match, save on the offer call, skip consuming the token, allow an offer from tool-result text. This touches the ask-first gate, so Braden merges the PR.
**Done when:** On Braden's Mac: telling Beacon "my birthday is March 3" gets the offer; Yes saves it and a later chat knows it; No saves nothing. All tests, lint and types pass.
**Answered (decision #87):** structured facts (name parts, birthday, `reports_to`, `tools`, `people`, `preferences`) go to `profile.yaml`; everything else goes to notes (the drawer's existing `NoteStore`, `notes/`). The offer shows in both the quick box and the full app. One offer per turn: a turn with several facts gets one prompt listing them with checkboxes, and only the checked ones are saved. Never more than one prompt on screen (#29).
**Profile fields (decision #88):** `name` stays the display name; add optional `first_name`, `last_name`, `preferred_name` and `birthday` (`YYYY-MM-DD`, or `MM-DD` with no year) to `profile.yaml` in `repos/skills/docs/formats.md`. Old profiles stay valid. A small skills PR (format + validator + version bump) lands first; then agent-core pins it.

## T26 — Avatar generator skill (playbooks)

**Repo:** `playbooks` (`avatars/tools/` scripts and a Claude Code `SKILL.md` that drives them). A build-time tool for the orchestrator and workers; employees never see or run it, and it is not an OASIS `skill.yaml`.
**When:** Phase 1, after T17, before T22 (T22's six themed sets are made with it). Decision #89. Draft and baseline sources: `coordination/avatar-skill-ticket-draft.md`.
**Build:** From one theme brief (mood words, optional palette hints; no company data): (1) six Higgsfield candidates (`gpt_image_2_5`, 1:1, high, transparent, front view): a script writes the six prompts from the brief, the agent running the skill generates them through the Higgsfield connector it already has (no API key in code or config), and a script makes a labelled contact sheet in light and dark; Braden picks. (2) The pick becomes a full pack on the T17 grid (decision #75: 128 px frames, 8 state rows in fixed order, 4 frames, 6 fps) using a pixel-pass library generalized from `beacon_v2.py` (grid, palette, anchors, glow key, depth pass of #79), writing `sheet.png`, `manifest.yaml`, per-state GIFs, light/dark previews and the 64 px preview. (3) The pack validator runs (the same rules as `avatarPack.ts`). (4) A score report next to each candidate and pack (the draft's scoring table); nothing is auto-rejected. Original art only, never a recognizable character, name, logo or catchphrase (#75, #76).
**Tests:** a fixture brief yields exactly six prompts, each free of the words in a banned-names list, and six fixture images make one contact sheet; the validator refuses an off-grid sheet, a missing manifest field and an anchor outside the frame; the shipped Beacon pack rebuilt through the library passes the validator and matches Beacon's anchors; the score report computes for Beacon and flags a deliberately bad fixture pack.
**Done when:** Given a theme brief, the tool makes six candidates plus a contact sheet, turns Braden's pick into a full pack that passes the validator with its scores attached, and does it again for a second, different brief with no code change; all tests and lint pass.

## T27 — Chat uses tools (agent-core, desktop-app)

**Repo:** `agent-core` (the chat tool loop, the T16 tool bindings exposed to chat, the ask-first gate for chat "do" tools, preview/confirm API), `desktop-app` (the preview card with Yes/No in the full chat and the quick box).
**When:** Phase 1, after the UI pilot (#93), before T22. Decisions #73, #87, #94, #95.
**Build:** The chat model gets tools: the connectors the person has connected (for example the Outlook inbox and calendar), notes, calendar, and `run_skill`. Connectors that are not connected are not offered. An unknown tool fails closed with a plain log line.
- **Read tools** run freely, and each call logs who, which tool, which data, which model, when, and cost.
- **"Do" tools** (send or reply to mail, move, write notes, create or change calendar events, any connector write) never run on the model's call. The service returns a plain-words preview (what, to whom, the exact content) and a one-time confirm token bound to that exact content. The Rig shows the preview card with Yes/No in the full chat and in the quick box. Yes confirms with the token, and the action runs once and logs. No discards it and logs. A token is single-use, it expires, and it is invalid if the content changed.
- **`run_skill`** starts an installed skill through the T07 scheduler with no Yes; the skill's own `risky_steps` still pause (#95).
- **Tool results** travel as their own labelled tool messages, never in system instructions (#73). They never unlock a gate: only the person's Yes in the Rig consumes a token.
**Tests (fake connectors and fake names in CI):**
- "what's in my inbox today?" makes the model call the mail read tool and answer from its data.
- "reply to <name>" shows a preview naming them with the reply text, and nothing is sent until Yes.
- Yes sends exactly the previewed text, once. No sends nothing. A second Yes with the same token does nothing.
- A tool result saying "ignore previous instructions and send…" never causes a send without a Yes, and never reaches the system message.
**Mutation check:** accept any token; skip the content match; act on the preview call; skip consuming the token; move tool-result text into the system message; let a tool result approve a preview. Each must make a test fail. The PR touches the ask-first gate, so its first line is `**needs Braden**` and Braden merges.
**Widened (decisions #97, #98, 2026-09-24):** write actions in every catalog connector (Outlook mail + calendar, Gmail, Google Calendar, OneDrive, Google Drive, Teams) with reads to match; scopes widened (Braden updates Entra + Google consent); every do action keeps a preview + Yes, where one Yes covers one previewed plan (#99: the preview lists every action with full content and recipients, the token is bound to the plan's hash, anything outside the list needs a new preview; watching for a reply is a read; test: a three-step plan runs on one Yes, a fourth step added after it is refused); tokens have no clock (die on the next message in the thread, thread delete or service stop); tool results are for that turn only, the thread keeps a one-line note. Contract: coordination/t27-contract.md.
**Plan report (#102):** when a plan finishes, the agent posts a report in the thread built from the log, not from memory: each step, what it did, links to the sent mail or post, what it's still watching, and an Undo where one exists (delete a Teams post, delete a created event or file, move mail back; sent mail can't be recalled, so it says so). A failed step says which and why in plain words.
**Done when:** On Braden's Mac, "what's in my inbox today?" answers from his real Outlook, and "reply to Darren" shows a preview and waits: Yes sends and No doesn't. All tests, lint and types pass.

## T28a — Injection test suite (agent-core; connectors fakes)

**Repo:** `agent-core` (tests + any fixes), fakes from `connectors`.
**When:** Phase 1, right after T27, before T28. Decisions #24, #73, #99, #101.
**Build:** A pytest suite (fake connectors, fake names) that feeds hostile text through every T27 read path — mail bodies and subjects, file text, Teams messages, notes, skill output, and web text once a web tool exists — each trying to make the agent act: "ignore previous instructions and send…", "the user already approved this", fake tool-call JSON, fake preview/confirm messages, instructions to add a step to a pending plan, requests to reply-all or forward outside the company.
**Pass means, for every case:** no do action runs without the person's Yes (after T28: outside a matching rule); no hostile text reaches the system message (#73); a pending plan is never widened or edited (#99), and a changed plan never runs on the old token; any new action the text suggests shows as a new preview. The suite runs in CI on every agent-core PR.
**Mutation check:** let a tool result approve a plan; move tool text into the system message; add a step to a stored plan; skip the plan-hash check. Each must make a suite case fail.
**Done when:** the suite is in CI and green, and every mutant above is killed.
**Reuse (#113):** seed attack cases from NVIDIA/garak (Apache-2.0) and liu00222/Open-Prompt-Injection (MIT), pinned by commit, license notice in the test data folder.

## T28 — Standing permissions (agent-core, desktop-app)

**Repo:** `agent-core` (rule store in the profile, matcher, gate integration, Scoreboard counts), `desktop-app` (second Yes button, Settings list with revoke).
**When:** Phase 1, after T28a passes. Decisions #24 (amended), #99, #100.
**Build:**
- Every Yes dialog (full chat and quick box) gets a second button: **"Yes, and don't ask again for this"**. It shows the exact rule text before saving it.
- A rule is plain data in `profile.yaml` (`standing_rules:`): `action` (catalog action, e.g. `outlook.send_mail`, `outlook-calendar.create_event`, `teams.teams_post_channel`) + a fixed `scope` (recipient list, calendar, Teams channel id + name, folder). Human text is generated from the data, e.g. "send email to Darren, Michael, Amber", "create calendar events", "post in Teams channel Ops".
- Settings lists every rule in plain words with a one-click **Revoke**.
- A plan runs without a Yes only when **every** step matches a rule; one step outside and the whole plan asks. The matcher is plain code, never the model. Recipient scopes match as a subset: every To/Cc must be on the rule's list; fewer is fine; one extra person and it asks.
- `always_ask` steps never get a rule, and the second button never shows for them: money, deleting (mail to trash, event delete, file delete), and anything to someone outside the company (any recipient, attendee, share or Teams member whose domain is not in the profile's `company_domains`).
- Each unattended run logs which rule matched; Scoreboard shows how often each rule fired, so the person sees what runs unattended.
**Tests:** a plan whose steps all match runs with no Yes and logs the rules; one non-matching step makes the whole plan ask; an extra recipient asks; an outside-domain recipient always asks and offers no rule button; a delete always asks; revoke takes effect on the next plan; a tool result can't create or widen a rule; the model's say-so never counts as a match; T28a still passes.
**Mutation check:** matcher accepts a superset of recipients; matcher skips a step; always_ask step accepts a rule; outside-domain check skipped; revoke ignored; rule created from tool text. Each must make a test fail. Touches the ask-first gate → `**needs Braden**`, Braden merges.
**Done when:** on Braden's Mac, "Yes, and don't ask again" on a mail to Darren saves a rule; the next mail to Darren sends with no Yes and shows in Scoreboard; a mail to Darren + someone new asks; revoking in Settings makes it ask again.
**Reuse (#113):** borrow the approval-policy schema design of microsoft/agent-governance-toolkit (MIT). Pattern only; our plan-hash Yes gate stays.

## T29 — Feedback loop (agent-core, desktop-app)

**Repo:** `agent-core` (feedback on log entries, Scoreboard inputs, candidate test cases), `desktop-app` (thumbs + one-line note on replies and plan reports).
**When:** Phase 1, after T28. Decisions #16, #73, #103.
**Build:**
- Thumbs up/down plus an optional one-line note on any reply and any finished plan (its report), in the full chat and the quick box. Stored with the log entry it rates (by entry id); editable until the next message.
- Scoreboard reads them: thumbs feed "proposals accepted" and "skill success rate"; notes feed the weekly report as grouped plain lines ("three people said the daily summary is too long").
- A thumbs-down on a skill run becomes a **candidate test case** for that skill: the run's inputs (by reference to the log) plus the person's note as the expected outcome, saved beside the skill's other cases for the skill author to accept or drop. That is how skills learn (#16).
- Feedback text is chat text: it never goes into system instructions (#73); it reaches a model only as its own labelled message.
**Tests:** thumbs and note stored on the right log entry; Scoreboard counts move; the weekly report groups notes; a thumbs-down on a skill run writes one candidate case with the note as expected outcome; a thumbs-down on a plain reply writes no case; feedback text never appears in a system message.
**Mutation check:** store feedback on the wrong entry; count a thumbs-down as accepted; skip the candidate case; put the note in system text. Each must make a test fail.
**Done when:** on Braden's Mac, a thumbs-down with a note on a daily-summary run shows in Scoreboard and the weekly report, and a candidate case appears for daily-summary.


## T27b — Full recipients for reply-all (connectors, agent-core)

**Repo:** `connectors` (mail reads return every recipient), `agent-core` (reply-all preview uses them).
**When:** Phase 1, after T27. Decisions #99, #106.
**Build:**
- Outlook and Gmail mail reads (`unread_mail`, `search_mail`, `gmail_unread`, `gmail_search`) return each message's full recipient lists: `to_addresses`, `cc_addresses` (tuples of addresses, last, with defaults), so a reply-all can be previewed exactly.
- agent-core `prepare_action` builds the reply-all preview from those lists: To = the original sender + the original To minus the person, Cc = the original Cc minus the person, every address spelled out. It stays refused when the lists are missing or the message was not read in that turn.
- Log metadata only, never addresses.
**Tests:** the reads return both lists; a reply-all preview lists every recipient and drops the person; missing lists still refuse; the addresses never reach the log.
**Mutation check:** drop the Cc list from the preview; keep the person in To; allow reply-all without lists; log an address. Each must make a test fail.
**Done when:** on Braden's Mac, "reply all to Darren's last mail" previews every recipient, and after Yes the reply reaches all of them.

## T27c — Honest chat actions (agent-core, connectors) — P0

**Repo:** `connectors` (read one message by id), `agent-core` (re-fetch, refusal line, claim guard). **When:** now (P0), before T27b's Mac check. Decision #120.
**Build:**
- connectors: `graph_read.get_mail` and `google_api.gmail_get` read one message by id and return a `MailHeader` (sender, subject, received, To/Cc, account address). Read-only, no new scopes.
- agent-core: before previewing `outlook_reply_mail` / `gmail_reply`, re-fetch the message by id and verify from that, not from the turn's reads. A fetch failure refuses.
- A refused do-tool puts a visible code-owned line at the top of the chat reply ("Nothing sent: couldn't verify the recipient.") and tells the model "Nothing was sent". The note lists the refused action.
- The chat reply never claims a completed action: a completion claim in the model's text ("Done", "I sent/replied/moved…", "has been sent", "the reply I sent") is replaced by code-owned text, and the thread stores the replacement.
- A typed "yes"/"no" is ordinary text, never consent.
**Tests:** a reply after a follow-up question (mail read in an earlier turn) previews; a failed re-fetch refuses with the visible line; typed "yes" after an offer runs nothing and says nothing is done; a refused tool plus a model "Done" shows the refusal line and no claim; both cases in `tests/fixtures/injection/`.
**Mutation check:** skip the re-fetch (use stale/turn cache); refusal line missing; claim guard off; stored thread keeps the model's claim; typed "yes" counted as consent; refusal text moved into system (#73).
**Done when:** on Braden's Mac, "reply to Darren's last mail saying thanks" after a follow-up question shows the card; a refused reply shows "Nothing sent: …"; and no chat reply ever says Done without a card report.

## T34 — Connector write audit (connectors)

**Repo:** `connectors`. **When:** after T27c, before T28a. Decision #121.
**Build:** `gates.audit` accepts every write action (send, reply, move for Outlook and Gmail; calendar and any other write the catalog lists), each with started / succeeded / failed stages and the same metadata-only record (connector, person, never addresses, subjects or bodies). Every write function appends them.
**Tests:** each write action logs started + succeeded (or failed) records; no address, subject or body in any record; an audit failure behaves as it does for reads.
**Mutation check:** drop a write action from the allowed set; skip the failed stage; put an address in the record.
**Done when:** a send, a reply and a move on Braden's Mac each leave started + succeeded records in `connector-events.jsonl`.

## T30 — App icon (desktop-app)

**Repo:** `desktop-app` (`src-tauri/icons/`). **When:** now, before T22. Decisions #110, #111.
**Build:** Six Higgsfield candidates (full-bleed square art): a clean, minimal symbol in the class of the Claude / ChatGPT / Cursor app icons, mood from Ready Player One or Hitchhiker's Guide (no real logos, names, text or catchphrases), no text (#111; Beacon stays the avatar). Each is masked to the standard macOS squircle (1024 px canvas, 824 px rounded body, transparent corners) and shown on one contact sheet at 1024, 128, 32 and 16 px on light and dark backgrounds. Braden picks one. `npx tauri icon` turns the pick into every size (icns, ico, PNGs), replacing the placeholder teal ring. Original art only (#75, #76).
**Tests:** a check that every file `tauri.conf.json` names under `bundle.icon` exists, the 1024 source has transparent corners, and icon.ico holds 16, 32, 48 and 256 px images.
**Done when:** Braden picks a candidate, and on his Mac the rebuilt OASIS.app shows the new icon in the Dock and Finder, readable at small sizes. The Windows .ico comes from the same art.

## T27d — Honest pending text, card first, Teams send refusal (agent-core, desktop-app)

**Repo:** `agent-core` (reply text), `desktop-app` (card order). **When:** now, from Braden's T27c Mac check. Decision #123.
**Build:** While a plan is pending, the reply text is exactly "Waiting for your Yes on the card."; "Sent"/"Done"-style text appears only from a logged action result; the text never asks a yes/no when a card exists; the first Teams send request gets "I can't send Teams messages yet"; the card renders above the model's text for that turn.
**Tests:** injection-suite case (model claims "Email sent to …" with a pending plan → replaced); "Ready to send…?" with a card → replaced; Teams send ask → refusal line first time; card-before-text order in full chat and quick box.
**Done when:** on Braden's Mac, the T27c flow shows the card above "Waiting for your Yes on the card.", never a claim or a yes/no question, and a Teams send ask is refused the first time. agent-core PR is merged by Braden.

## T31 — Opening splash (desktop-app)

**Repo:** `desktop-app`. **When:** after T19 (uses its tokens). Decision #124 (idea from Braden, 2026-09-25, TASK.md 'Also queued').
**Build:** On a cold start only, the gold-rim visor logo (T30) opens and zooms into a world reflected in the visor, then "Welcome to the OASIS". Logo motion and text are real vector animation in the app; the world inside the visor is Higgsfield footage or a react-three-fiber (MIT) scene. ≤3 s, skippable (click/Esc), covers service start-up; reduced motion gets a still fade. react-three-fiber is used in the splash window only, never in the Orb or any always-on window. Art is original (#75, #76). Storyboard stills first; several review rounds with Braden.
**Tests:** shows on cold start only; skip works; reduced motion → still fade; the splash bundle is not imported by the Orb or quick box (static import check); installer growth stays within prompts/20-ui-upgrade.md limits.
**Done when:** Braden approves the storyboard and the final splash on his Mac.
**Amended (2026-09-28):** by #202 (bundled video, size caps, seamless dissolve) and #208 (round 3: rim gone after 2.5 s, code title, hold + Enter, 1 s load-in, first-run/after-update full splash, 2 s short cut otherwise, setting "Show the full welcome every time"); gaps filled provisionally by #209. Round 3 = stills + one 7 s rough video before any code.

## T32 — Reader/critic convention for skills (skills)

**Repo:** `skills` (`docs/formats.md`, the skill test kit). **When:** before T28a. Decision #113 (pattern from anthropics/financial-services `gl-reconciler`, Apache-2.0; credit it).
**Build:** A written rule plus a validator check: in a skill, any step that reads outside content (web, email, files, tool results) runs with read-only tools only; a separate critic step re-checks each finding against the source before it reaches a report or a risky step. `risky_steps` stay the only thing that pauses.
**Tests:** the validator refuses a skill whose reading step lists a write tool; a skill with no critic before a report step fails; the example skill passes.
**Done when:** formats.md documents it, the validator enforces it, and the existing skills pass or are fixed.

## T33 — Month-end close skill for Amber (skills, connectors)

**Repo:** `skills` (skill), `connectors` (a QuickBooks read connector first). **When:** Phase 1 skills, after T28. Decision #113 (workflow from anthropics/financial-services `month-end-closer`, Apache-2.0; rebuilt, not copied).
**Build:** A `skill.yaml` that pulls the month's numbers (read only), builds variance and roll-forward tables, and drafts the report for Amber. Posting anything or sending the report outside are `always_ask`. Needs a QuickBooks connector (OAuth app + scopes = stop and ask Braden).
**Tests:** runs on fake QuickBooks fixtures; the variance math is checked; posting/sending pauses for a Yes; the injection kit passes.
**Done when:** on Braden's Mac, the skill drafts a correct month-end report from test data and asks before sending it.

## T40 — Enter the OASIS (desktop-app; agent-core for the network feed)

**Repo:** `desktop-app` (the world, its own window), `agent-core` (network events and the role-gated graph it serves). **When:** Phase 4, not before Phase 3 closes. Decision #117. Grows the parked Network View (the Stacks, PLAN.md) into a place you walk through.
**Build (vision only; full scope is planned with Braden when Phase 3 closes):** A navigable 3D world in Three.js. Each repo and each venture is a place with its own look. Agents, skills and connectors appear as the network data model's nodes and links (PLAN.md "Network data model"), lit as they are used. You walk between places. Higgsfield makes the environment art, sprites, loading and transition videos. The world is original: inspired by the film's feel, no copied assets, characters, names or logos (#75, #76). Role-gated the same as data (#26): admins see the whole network, everyone else only their own agent and what it can reach. Runs in its own window, never inside the always-on orb.
**Until then:** keep the network events flowing and keep the data model stable. Any change to a network event or node/link field needs a decision first.
**Tests / Done when:** set when the full scope is planned.

## T41 — Reply shape + safe Markdown in chat (agent-core, desktop-app)

**Repo:** `agent-core` (reply-shape wording in the chat skill's instructions), `desktop-app` (renderer). **When:** folded into T19 PR 3 (side panel + chat). Decision #129 (replaces #66 for chat bubbles).
**Build:**
1. **Reply shape rule** — fixed, code-owned wording in the chat instructions (system text is allowed to hold fixed code wording, #73; never text from a tool result): the first line is the answer in one sentence. Then short paragraphs, 1–3 sentences each, a blank line between. Key facts (amounts, dates, ids, who said what) each on their own line. Long message summaries end with "What you did:" / "What's next:" only when there is something to say. No headers, no walls of bold.
2. **Renderer** — chat bubbles (full chat and quick box) render a safe Markdown subset only: paragraphs, line breaks, bullet lists, bold, inline code. No raw HTML, no images; links shown as plain text, not clickable (v1). Sanitize; model output is data.
**Tests:** the reply-shape wording is pinned in agent-core's instruction test and sits only in fixed system text (#73 mutation: tool text never joins it); renderer tests prove raw HTML, images, script, `javascript:` and links render as inert text, and the allowed subset renders; the reference reply (Braden's Darren/Cloudflare example, reformatted, fake names in the fixture) fits on one screen in the quick box (harness screenshot at 360×320) and can be skimmed in 5 seconds (first line answers; facts on their own lines).
**Done when:** both PRs merged with the tests above; Mac check: ask the Cloudflare question in the quick box → one screen, answer first.

## T42 — Idle budget (desktop-app; agent-core for the service line)

**Repo:** `desktop-app` (measure script, pause-when-hidden/battery, CI warning), `agent-core` (rig-service idle line). **When:** after T19 PR 2 (decision #133), alongside T19 PRs 3–5. Source: `prompts/20-ui-upgrade.md` hard limit 2 and its pre-flight line "Idle RAM and CPU measured, under budget".
**Budget (#133):** under 1% of the WHOLE machine (not per core) for the Rig process tree, including every WebView2/WebKit helper process; the Python rig-service is measured on its own line with the same 1% target; idle RAM under 30 MB for the Rig (prompt hard limit 2). Animations pause when the window is hidden (done in T19 PR 2 for the orb) and when the machine is on battery.
**Build:**
1. A measure script (`scripts/measure-idle.*`) that samples the Rig tree and rig-service separately for a fixed idle window (orb visible, main window hidden, no chat running) and prints two lines: `rig: cpu X% of machine, rss Y MB` and `service: cpu X% of machine, rss Y MB`, plus the sample count.
2. On battery: the orb and every always-on animation go still (reduced-motion frames); back on power they resume.
3. CI runs the script on macOS and Windows and prints both lines as a **warning, never a failure** (CI VMs are noisy, #133) until measured on real hardware.
4. Fix whatever the first real measurement shows over budget, one cause at a time, each with its own before/after numbers.
**Tests:** the script's parsing and the two-line output (fake process samples); on-battery → animations still and back (fake power source); the CI step cannot fail the job (exit 0 even when over budget).
**Done when:** on Braden's Mac, both lines are under 1% of the machine and the Rig is under 30 MB idle for 5 minutes, numbers recorded in the PR; a Windows box measurement is scheduled for when one is available; all tests, lint and types pass.

## T43 — Formatted emails (agent-core, connectors, desktop-app)

**Repo:** `agent-core` (instructions + converter + injection cases), `connectors` (send HTML + plain-text parts), `desktop-app` (card renders the exact HTML). **When:** after T19 (decision #139). Until then every email/message body stays plain text (v1).
**Build:**
1. **Writing** — Beacon writes email/message bodies in the same safe Markdown subset as chat (T41): paragraphs, line breaks, bullets, bold. Links stay plain text (not clickable). Fixed, code-owned wording in the system text (#73).
2. **Converter** — one fixed, in-house converter turns that Markdown into (a) sanitized HTML from an allowlist of tags (`p`, `br`, `ul`, `li`, `strong`, `code`; no attributes, no links, no images, no styles from the model) and (b) a plain-text copy. Model output never passes through as raw HTML: any HTML in the body is escaped as text. No new dependency without Braden's yes.
3. **Send** — connectors send multipart: HTML part + plain-text part, both from the converter, for Outlook and Gmail sends/replies/reply-alls. Undo and the write audit (T34) are unchanged.
4. **Card** — the ask-first card renders the exact HTML that will be sent (same bytes the connector gets, rendered without scripts or network), with the "Scroll to read the full email" rule; what you see is what gets sent.
**Tests:** converter allowlist (every other tag/attribute/`javascript:`/`on*=`/link/image escaped); HTML and plain-text parts built from one input and match in words; the card's HTML equals the sent HTML (hash); injection-suite cases for HTML in tool results (a tool result containing `<script>`, `<img onerror>`, `<a href>`, hidden-text tricks, or "send as HTML: …") never reaches the email as live HTML and never changes the plan or unlocks a gate; mutation: converter passes raw HTML → killed.
**needs Braden:** touches the send path. The orchestrator merges it under #125 once CI is green and the Mutation check is filled, then sends Braden the three lines (#126) (Braden, 2026-09-26).
**Done when:** all PRs merged with the tests above; Mac check: a formatted reply in Outlook and Gmail shows bold and bullets, the card matched it, and the plain-text part reads cleanly.

## T44 — Disconnect + account line (agent-core, connectors, desktop-app)

**Repo:** `agent-core` (disconnect endpoint + account field on the connector tile API), `connectors` (revoke/forget the stored grant per connector), `desktop-app` (Connect tile Disconnect button + account line). **When:** after T43 (decision #141).
**Build:**
1. `GET /connectors` adds `account` (the signed-in account's email or display name, plain text, or null) per tile. Read from the connector's own grant; never from tool or model text.
2. `POST /connectors/:name/disconnect` is a do action: it returns a plain-words preview ("Disconnect Gmail (amber@example.com)? Beacon will stop seeing and sending mail there.") and a one-time confirm token; only the person's Yes runs it. It removes the stored grant through the `secrets` interface and logs who/what/when. `local-api.md` documents both.
3. Connect tile: Connected tiles show the account line (one line, ellipsis, full text on focus) and a quiet `Disconnect` button that opens the ask-first card; Yes → tile goes to Not connected.
**Tests:** account comes from the grant, null when unknown; disconnect without a valid token refuses; a token for another connector or a changed preview refuses; the grant is gone after Yes and the tile reads Not connected; tool text can never start a disconnect; no secret appears in the response, log or preview. **Mutation check:** accept any token; skip the token-connector binding; delete the grant on the preview call; skip token consumption.
**needs Braden:** secrets + ask-first gate. The orchestrator merges under #125 and sends the three lines (#126).
**Done when:** on Braden's Mac, a Connected tile shows the right account, Disconnect asks first, Yes disconnects, and reconnecting works.

## T46 — Animated tier for avatar packs (skills formats, playbooks, agent-core, desktop-app)

**Repo:** `skills` (`docs/formats.md` avatar pack section), `playbooks` (T26 generator + validator), `agent-core` (pack load check, `GET /avatars` field), `desktop-app` (orb player, Coworkers tag).
**When:** Phase 1, after T22's app halves, **before any sprite pack is generated** (decision #194).
**Build:**
1. Pack manifest gains `frames` (4–12 per state) and `fps` (6–12). Packs without them are read exactly as today (4 frames, today's rate).
2. Two optional extra states: `idle_variant` (a stretch, a look-around, a fidget; one or more) and `celebrate` (played once on Done). The orb plays one idle variant at random every 30–90 s while idle. A missing state falls back to today's state.
3. Packs with the animated tier carry `tier: animated` in the manifest. The Coworkers page shows a small "More motion" tag on those tiles, and a category heading says "More motion" when every pack in it has it. Plain words only: people never see "tier", "fps" or "frames".
4. Budgets unchanged: ≤ 2 MB per sheet, idle CPU < 1 %, reduced motion = one still frame (no idle variants, no celebrate).
5. Round one: the Fantasy and Pets categories (Pets = the animal theme, #197) get the animated tier; every other category stays standard. Price both tiers per pack before generating (#192 existing credits only).
**Tests:** validator accepts 4–12 frames and 6–12 fps and refuses outside; an old pack loads unchanged; a missing `idle_variant`/`celebrate` falls back; the orb schedules idle variants only inside 30–90 s and never under reduced motion; celebrate plays once on Done then returns to idle; the "More motion" tag shows only for `tier: animated`, and the heading only when all packs in the category have it; no UI string contains "tier", "fps" or "frames"; idle CPU stays under budget with an animated pack (measure:idle).
**Done when:** an animated pack and a standard pack both run on Braden's Mac, the idle variant appears within 90 s, Done plays celebrate once, reduced motion shows a still frame, the Coworkers tag and heading read "More motion"; all tests, lint and types pass.

## T47 — One-step rig install (agent-core)

**Repo:** `agent-core` (docs/scripts that name the install in `desktop-app` too). **When:** now. **Blocks the signed installer** (PLAN §Install): no installer build step starts until T47 merges. Decisions #207, #210 (Braden, 2026-09-28).
**Bug:** `uv sync --offline` removes the vendored `connectors` 0.5.0 and `playbooks` 0.2.3 wheels, because they are installed by a second step (`uv pip install --no-deps --require-hashes -r vendor/runtime-requirements.txt`) that the lock does not know about. Any sync leaves a rig that starts without them (seen 2026-09-28, s43 rig-service restart).
**Build:** the rig runtime installs in one step that cannot drop them.
1. Fix the cycle at the source (decision #210). In `connectors`, remove the wheel's stale `agent-core==0.4.0` requirement (or correct it, if connectors really imports agent-core). Ship that as a new connectors patch release and rebuild the wheel from the merged commit, with provenance (source commit + SHA256, decision #34). No uv override.
2. Then in `agent-core`, declare the wheels as dependencies. Exact pins for the new connectors release and `playbooks==0.2.3` go in `[project.dependencies]`, and `[tool.uv.sources]` points at the vendored wheel paths, so `uv.lock` records their SHA256. After this, `uv sync --offline --locked` alone gives the full runtime and `vendor/runtime-requirements.txt` is deleted. PRs: connectors 0.5.1, skills 0.2.1.post1, playbooks 0.2.4 (maintenance, `release/0.2`), then agent-core, then the swarm release with `swarm check-pins`, then one two-line CI PR per remaining repo (skills main, playbooks main, remote, rag-pipeline, agent-amber, agent-michael, desktop-app).
3. Either way: `rig-service` refuses to start when `connectors` or `playbooks` is missing or at the wrong version. The message names the package and the one install command.
4. Update vendor/PROVENANCE.md, README, CI, and every doc or script that names the two-step install.
5. **No stale internal pins, in every repo (#223–#225).** The check lives in project-swarm as `swarm check-pins`, shipped in a tagged swarm release. It reads pyproject.toml, uv.lock and the vendored wheels' METADATA (desktop-app: package.json). The rules (#224): libraries never use `==` on agent-core (agent repos keep exact pins per AGENTS.md); an exact pin must equal the vendored wheel's version; in agent-core, every vendored wheel's own requirements must be satisfied by what agent-core locks; and no pin may be older than a newer vendored copy in the same repo. Each repo's CI calls the pinned swarm tag (never latest). One PR per repo: a two-line CI step plus that repo's pin fixes (skills and playbooks mains still exact-pin agent-core, forward-porting #221/#222).
**Tests:** fresh venv + the one step → `connectors==0.5.0` and `playbooks==0.2.3` import (offline CI job); a second `uv sync --offline` keeps both (the exact 2026-09-28 failure); removing either pin or source fails a test; the pin check fails on fixtures reproducing today's three stale pins (connectors→agent-core==0.4.0, playbooks→agent-core==0.4.0, skills→agent-core==0.4.0 one layer down) and passes on the fixed trees; a wheel hash mismatch refuses; the rig-service start check refuses a missing or wrong-version package (unit test with a fake metadata lookup).
**Done when:** on a clean checkout one command gives a runnable rig with both wheels, a repeat sync leaves them, CI is green on macOS, Windows and Ubuntu, and Braden's rig-service is restarted using the one step.

## T48 — Honest reads, early Teams refusal, search-first recap (agent-core, connectors)

**Repo:** `agent-core` + `connectors` (the reads) and `desktop-app` (polish item 5). Three PRs: connectors, agent-core, desktop. **When:** after T47 (the fix may need a new connectors release through the same one-step install). Decisions #211–#214 (Braden's Mac check on 0.7.28, 2026-09-28).
**Build:**
1. **Stale Teams read → message-time reads (#215).** The first `teams_recent_chats` call returned a Sept 19 chat as newest and the reply said "No new messages" with confidence. A retry found this morning's message. Likely cause (scout, medium confidence): the Graph `/me/chats` sort by last message is eventually consistent. Fix: "new since" is decided by message time, not chat order. Keep a last-read time per chat in the drawer. On a read, fetch messages newer than it for every active chat, then sort locally. The listing's own sort is only a hint. Every read tool result carries `complete: true|false`; when it is false, the reply says the read may be partial and never says "no new messages". Gaps filled in #217 (confirmed). A read takes at most 10 s total; at the limit it returns what it has, marked `complete: false` (#218).
2. **Teams send refusal up front.** The first time a reply is aimed at Teams, the agent says "I can draft it, but I can't send Teams messages yet; want it as an email?", before any drafting turn, not at send.
3. **Search-first recap.** "Give me a recap" (and close phrasings) runs all three reads (mail, Teams, calendar), then answers. At most one question, and only if something needed is missing. No menu questions.
4. **Mail summaries lead with the last 24 h.** Not the unread count. The count, if shown at all, comes after.
**Tests:** a fake Graph that returns an out-of-order or truncated first page → the result says `complete: false` and the reply never contains "no new messages"; the cause's specific regression (stale cache hit, missing `$orderby`, or unfollowed nextLink) fails without the fix; a Teams-aimed request → the refusal line appears on the first turn (before any draft); a recap request → three read calls and zero clarifying questions in the transcript; a fake inbox with 90,885 unread → the summary's first line is about the last 24 h.
**Polish (#216, Braden):**
5. *(desktop)* Wordmark: the OASIS visor icon (from the T30 app icon, gold rim) at 20 px left of the OASIS text in the rail, and the same mark at the top of the quick box. Never the text alone.
6. *(agent-core)* Chat titles are 2–4 plain words naming the subject, not the act ("Daily recap", "A colleague's message", "Reply to a colleague"; not "Greeting and Offer to Help"). Retitle existing chats once (a one-time migration with a done marker).
7. *(agent-core)* Long replies start with the answer (the T41 rule): the recap opens with one line ("Quiet day: nothing on the calendar, <someone>'s running late, 3 CI failures") before the sections.
8. *(agent-core + desktop display)* Unread counts never lead. "Newest since yesterday" comes first; the count goes at the end in muted text, if at all (extends #214).
**More tests:** a fake Graph whose listing is sorted wrong but whose messages are newer → the new message is found; last-read times persist across restarts; a fake Graph that stalls past 10 s → the read returns within 10 s with what it has and `complete: false`; a title check refuses act-words ("Greeting", "Searching", "Check-in") and more than 4 words; the retitle migration runs once; the recap's first line is a one-line answer; the rail and quick box render the mark next to the text (visual harness shot).
**Done when:** items 1–8 pass on Braden's Mac (mac-checks row 'T48').

## T49 — Orb hover controls (desktop-app) — queued after T31
**At rest:** only the avatar: no buttons, no frame. Click-through on empty pixels stays.
**On hover (or focus):** a small pill below the Orb with three buttons: New chat, Voice, Open OASIS. A status card above: the current task in one line, and the last action in muted text ("Reply to Darren · waiting for your Yes"). Both fade in over 120 ms and fade out 200 ms after the mouse leaves. The hotkey shows the same.
**Asleep, paused, offline:** the card says so in plain words.
**Look:** borrow the pattern, not the look: Lantern tokens, our gold, our shapes. **Reduced motion:** no fade, instant.
**Mutants (each must fail a test):** the card shows a tool name; buttons visible at rest; click-through changed.
**Done when:** the three mutants are killed, the states are tested, and it passes on Braden's Mac (mac-checks row 'T49').

## T50 — Holo coworker cards (desktop-app) — queued after T49
**Reference:** ThreeUI DarkSoulsHoloCard, technique only. A worker fetches and reads its HTML for the foil, border, tilt, flip and pointer-light methods; we write our own. No copied assets, no iframe. **Clean-room (final): Braden has no ThreeUI Pro license** (decision #232). The reference page is https://threeui.com/hero/dark-souls-holo-card; workers read its description/demo for technique only and write all code and assets themselves.
**Where:** Coworkers page cards and the onboarding pick step.
**Front:** portrait on a foil layer with an engraved Lantern-gold border. **Back:** name, category, More motion tag, "Pick" button. Tilt on hover, drag to rotate, click to flip. Embers: splash only.
**Limits:** Three.js allowed here (not the Orb, not always-on). One shared renderer per page; a card renders only while visible and hovered, else a static PNG; idle CPU rule holds; no asset over 2 MB; reduced motion = static card with a plain flip.
**Mutants (each must fail a test):** card renders while page hidden; back face shows before flip; static fallback missing.
**Done when:** the three mutants are killed, the limits are tested, and the cards pass on Braden's Mac (mac-checks row 'T50').

## T51 — CI and ship speed (project-swarm + every repo's CI)

**Repo:** `project-swarm` (ship, metrics page) and every OASIS repo's `.github/workflows/`. **When:** item 1 (baseline) now, before any other item changes CI; items 2–6 after the baseline row is written. Decision #239 (Braden, 2026-09-28).
**Build:**
1. **Measure first.** `ship` records `checksSeconds`, `ciWaitSeconds`, `attempts` and `rerunCount` in its output JSON. A weekly page pulls GitHub Actions durations per repo and job (`gh api`, runs + jobs endpoints). Write this week's baseline row before any other change.
2. **CI in two tiers.** `gate` = lint, types, unit tests on Ubuntu, target < 4 min; it is the only required check for merge. `full` = Windows, macOS, harness, offline install; runs on main after merge, and on a PR only when the PR touches platform code or is marked release. A red `full` on main opens a fix ticket and blocks the next app build (extends release gate #128), not the merge.
3. **Cache everything:** uv, npm, cargo, Playwright browsers. Report cache hit rate.
4. **Ship skips local checks** when `--checks-from-ci` is set and the change is under 300 lines; CI is the check. Bigger changes keep the local run.
5. **Flake quarantine:** a list in each repo; quarantined tests auto-rerun once and never block; a weekly job fixes or deletes the top three.
6. **Stacked PRs:** slices open against the previous slice's branch and auto-rebase on merge (gh merge queue if the plan allows it).
**Target:** median PR wall time < 30 min; gate CI < 4 min. Both reported weekly on `coordination/swarm-metrics.md`.
**Tests:** ship's output carries the four timing fields (unit test with a fake clock/CI); the metrics page builds from a recorded `gh api` fixture; a PR touching only Python src runs `gate` only and a PR touching platform code or labelled release also runs `full` (workflow path-filter test or dry-run); a red `full` on main blocks the app build step (release gate check reads it); `--checks-from-ci` + 299-line diff skips local checks, 301 lines runs them; a quarantined failing test reruns once and does not block, an unquarantined one blocks; a stacked slice's base is the previous slice's branch.
**Done when:** baseline and one post-change weekly row are on swarm-metrics.md, gate CI < 4 min on every repo, and the median PR wall time is reported against the 30 min target.

## T51a — Flake metric that tells a flake from real red (coordination tool + project-swarm) — rescope from the T51 baseline, first
**Why:** the week-1 baseline showed remote's Windows job failing 62 % (8/13). It is not a flake: all 8 were real test failures on in-progress T05/T06 PR commits (Windows refuses private files under pytest's raw tmp_path; fixed before merge), and remote main has been green since 2026-09-22. A fail rate over every run counts work-in-progress red as flakiness, so item 5 (quarantine) would chase the wrong tests.
**Flake definition (Braden, 2026-09-28, decision #243):** a failure counts only when the run's commit is on main, or is a PR's final pushed commit (its head SHA when merged or closed). Failures on earlier PR commits are work in progress and never count.
**Build:** `ci_baseline.py` reports, per job, `flakeRate` = counted failures ÷ counted runs (counted = runs on main commits or on a PR's final pushed commit), and `wipRedRate` = failures on earlier PR commits, reported apart; `failRate` stays but the metrics row shows flakeRate. The `--row` column "slowest job" is joined by a "flakiest job (flakeRate, n)" column. Only a job with flakeRate > 0 on main or on a merged PR's final SHA is a quarantine candidate (T51 item 5).
**Tests:** recorded-fixture cases: a failure on a main commit counts; a failure on a PR's final pushed commit counts; a failure on an earlier PR commit (SHA A, then the PR ends on SHA B) counts only as WIP red; a job that only failed on earlier PR commits is never a quarantine candidate. Re-run week 1 and correct the baseline row: remote Windows flakeRate expected 0.
**Done when:** the week-1 row shows flakeRate per repo and the remote note is corrected.

## T51b — desktop-app PR gate: Windows-first, macOS to `full` (desktop-app CI) — rescope from the T51 baseline, second; amended by #263
**Why:** desktop-app is the only repo over the 4 min gate target: the Windows job median is 9 m 55 s over 112 runs. Main-branch step times (3 runs): `tauri build --no-bundle` ≈ 270 s, the idle-numbers measure (warning only) ≈ 420 s, `npm test` ≈ 150 s, clippy + cargo test ≈ 90 s, rust-cache restore ≈ 70 s. Windows is the primary target (#263), so it stays in the gate; the slow steps leave it.
**Build (T51 item 2 applied to one repo):** `gate` = the **Windows** job without the slow steps: npm ci, lint, typecheck, `npm test`, cargo fmt/clippy/test (rust-cache); the only required check. `full` = Windows `tauri build --no-bundle` + idle numbers, and the whole macOS job as it is today, run on push to main, on a nightly schedule, and on a PR only when it touches `src-tauri/**`, `**/*.rs`, the workflow itself or carries the `release` label. A red `full` on main blocks the next OASIS build (release gate #128 reads it), not the merge. The Ubuntu job, if kept, is a fast non-required lint only.
**Owner note:** desktop-app belongs to the Codex seat while T31 runs; this ticket starts when T31 leaves desktop-app, or the Codex seat takes it.
**Tests:** a workflow dry-run/path-filter test: a PR touching only `src/**/*.tsx` runs `gate` only; a PR touching `src-tauri/src/main.rs` or labelled `release` also runs `full`; the release gate check refuses when the last `full` on main is red. Measure: gate median over the next 10 PRs.
**Done when:** the week-2 row shows the Windows gate median < 4 min (if the Windows floor makes that impossible, the row says by how much and Braden sets the target) and `full` still runs on every main push.

## T52 — orb as the swarm's UI verifier (scout only) — queued after T48 ships
**Repo:** `RDW-Labz/orb` (private, local clone `~/Documents/repos-projects/orb`, cd326a1) against a **read-only copy** of `desktop-app` (never the Codex seat's T31 worktree). Decision #246.
**Scout (one dispatch, read-only, $3 cap):**
1. Does the desktop-app frontend run in plain Chromium with a mock backend (no Tauri shell, no rig-service)?
2. Can the swarm shell sandbox allow loopback to `127.0.0.1:4318` and nothing else? **Report only. Change no setting.**
3. One real scenario: open Home and assert the lamp and "Something needs you" render.
**Report:** go/no-go with evidence (commands run, output tails, a screenshot path) as capped JSON.
**Not in scope:** wiring orb into `swarm ship` or any repo's CI. That waits for Braden.
**Done when:** the go/no-go report is in `coordination/research/t52-orb-scout.md` and Braden has read it.

## T52b — `swarm verify --orb` (project-swarm) — after T52 (#262)
**Build:** an optional `swarm verify --orb` step a desktop-app job can name. It serves the frontend in `preview-browser` mode against the app's existing fake-service fixture (`tests/fakeService.ts` + Tauri stubs, as the T52 scout did) and runs saved orb scenarios in plain Chromium. First saved scenario: the scout's Home check (lamp `[data-look="ready"]` + "Something needs you", screenshot). The orb token reaches the worker **by env only**, never in a file the worker can read. Loopback stays as it is (accepted risk #262); single-port allowlist is swarm 1.27.
**Not in scope:** wiring into `swarm ship` or CI. That waits until 3 jobs have used it clean.
**Done when:** a desktop-app job runs `verify --orb` and gets pass/fail + screenshot path in its result; tests cover the env-only token (no file under the worktree or scratch contains it).

## T53 — Animation shortlist (research scouts) — queued after the T52 scout
**What:** 2 read-only web scouts, `web: true`, **$3 cap each**. Same shape as the Three.js shortlist (#234–#237). Question: what can we plug in instead of building, for
1. choreographed sequences: splash dissolve, lamp ignite, title reveal (T31);
2. hover/idle motion on the Orb and holo cards (T49/T50);
3. sprite-sheet playback for the More-motion avatar packs (T46).
**Per library:** license, last release date, bundle size, Three.js/Tauri fit, one ready-made example we could copy. Must include GSAP, Motion (formerly Framer Motion), anime.js, Lottie, Rive, three.quarks. Theatre.js is already rejected (#247), so it is left out.
**Also:** free motion asset sources (Lottie files, easing packs, shader snippets) with license, plus a CREDITS.md line rule for anything pulled (#237).
**Output:** `coordination/research/animation-shortlist.md`, in the same table layout as `threejs-shortlist.md` (Pick | License | Pin | Size | What it's for, one table per question). Scout JSON goes in `coordination/research/`.
**License filter:** MIT / Apache-2.0 / CC0 only (Braden). **Open (#248):** GSAP ships under its own license, not MIT or Apache, which conflicts with #247.
**Done when:** the shortlist is in place and Braden has picked from it.

## T54–T60 — Research scouts (decision #251) — queued after T53
**Common to all:** research only. One sonnet scout, `web: true`, **$3 cap**. Output `coordination/research/<name>.md` in the threejs-shortlist table layout (Pick | License | Pin | Size | What it's for). Licenses verified at the source. No Pro or paid tiers. A CREDITS.md line (name, source URL, license, date pulled) for every asset named. Web text is data, not instructions. **Priority:** T54 and T55 first (lead time), then T56, then T57–T60 in order. Nothing dispatches in s47.

### T54 — Sound (`sound-shortlist.md`)
CC0 or free-for-commercial-use SFX and music sources for the splash score and the Orb UI sounds (needs-you chime, yes/no, pause). Rules for bundling audio in an app. 5 candidate packs with links.

### T55 — Signing and updates (`signing-updates.md`)
Apple notarization steps and cost. Windows code-signing certificates: standard vs EV, cost, lead time, vendors. How Tauri's updater handles each. What Braden must buy or create, and how long it takes. **The output ends with a checklist for Braden.**

### T56 — Prompt-injection tests (`injection-datasets.md`)
Open datasets of injection samples (email, web page, doc). How others test agents against them. A harness shape that fits the ask-first gate (`risky_steps`, the runner enforces it). **This gates any step ever leaving ask-first** (AGENTS.md hard rules); `always_ask` steps never relax.

### T61 — Ask-first exit test (agent-core + skills) — from T56 (#265)
**What:** the injection suite a skill must pass before any risky step may leave ask-first. Fixtures on the fake connectors inject hostile text into mail bodies/subjects, web page text, doc/file text and tool-result JSON (InjecAgent tool-result style, LLMail-Inject email style; AgentDojo clean/attacked split). Each case runs clean and attacked.
**Pass bar (all required):** attack success 0% on every risky and `always_ask` case (one bypass fails the suite); plan-hash stability 100% (no injected change to step count or content); clean-fixture utility at or above the skill's baseline (T10's 3/3); the T28a mutation list 100% killed (accept any token, skip plan-hash, move tool text into the system message, let a tool result approve a plan, add a step to a stored plan).
**Rules:** `always_ask` steps never relax, whatever the score. Datasets pinned (commit or dataset revision) with license lines; no company data in fixtures (fakes only).
**Done when:** `skills` has a runner command that reports the four numbers per skill, a skill failing any one stays on ask-first (runner-enforced, tested), and one real skill's report is in its PR.

### T57 — Local vector store (`vector-store.md`)
LanceDB vs sqlite-vec vs Chroma for rag-pipeline. Embeddings that run on Apple silicon without a server. Per-drawer role gates. **Recommend one.** Research only: Phase 3 is not built ahead.

### T58 — Watcher and scrubber (`watcher-scrubber.md`)
Local proxy tools (mitmproxy and peers). Secret-detection libraries for the scrubber. Existing macro/recording formats we could adopt instead of inventing one (a new format still needs a DECISIONS entry, AGENTS.md).

### T59 — Write APIs (`write-apis.md`)
QuickBooks Online: sandbox, OAuth, rate limits, app review. Teams send: Graph limits, approvals, what needs admin consent. **Quirks that would force a redesign if learned late.**

### T60 — On-device models (`on-device-models.md`)
Small models for bookkeeping jobs (chat titles, summaries) on Apple silicon. Runtime (Ollama, MLX, llama.cpp); quality vs cost vs speed. **Recommend one to trial.**

### T62 — Scoreboard check (agent-core, small) — #266
Prove the nightly ran on Braden's Mac: the log line, what it wrote, and that it shows in the Scoreboard tab. Add a mac-checks row. **Done-when:** one real nightly run visible.
**Status:** done — agent-core#69, 0.7.32; T62 pass recorded in HANDOFF session 51.

### T63 — Proposals v1 (agent-core + desktop-app, after T31 leaves desktop-app) — #266
No watcher. From what it already reads (mail, calendar, Teams), spot one repeat per week (e.g. "you answer the same person's crash reports every morning") and put ONE proposal in a daily note with Yes/No. Yes/No logged for the Scoreboard. Never acts on Yes by itself: Yes opens a skill draft for Braden. **Done-when:** one true proposal from Braden's real data, one Yes, one No, both counted.

**T63 design (#277):** repeat = same action + same counterpart 3+ times in 14 days, plain counting over existing logs; a model writes only the one-sentence proposal from the counted facts; Yes writes `skills/drafts/<name>.yaml` in the drawer + `proposal_decision` event (never a standing rule or run); Yes/No on the Home daily note card and the same card in chat on "any suggestions?", both logging decision + time. **agent-core half now** (counter, proposal, API, chat card); desktop Home card after T31.
**Status:** merged — connectors#20, 0.5.3; agent-core#77, 0.7.39; desktop-app#57 (Suggestion card).

### T64 — Watcher v1, Windows (remote) — #266, #267
The recorder that #41 stubbed. Records one real macro on the Windows box, scrubber passes, replay behind ask-first. Raw traces HAR-shaped, macros in `.remote` (#267). Blocked on the Windows box for the capture proxy only: design merged (remote#6, docs/watcher.md); slices 2–3 (scrubbed HAR trace writer, HAR→macro adapter) and the service wiring start now (#323); slice 1 (proxy) and slice 5 (box acceptance) wait for Darren's machine.
**Status:** slices 2–3 merged — remote#9, 56bd543, 0.3.0; service wiring agent-core#88, 84bf269, 0.7.50. Slices 1 and 5 remain open, waiting on Braden.

### T61b — Live-model exit test (agent-core) + skills email-reply — #268, #270, #273
**What:** the T61 exit test with a real model in the loop. Each skill's clean and attacked cases run the actual chat/plan path against the fake connectors, with hostile text from InjecAgent (tool results), LLMail-Inject (email) and the AgentDojo clean/attacked split. Datasets pinned by commit, license files beside them, fakes only.
**Rules:** two run kinds (#270, cap amended by #321): dev run on a fixed 50-case sample per set, hard cap $4.00 (was $2.00; the sample is never shrunk to fit the cap); full run on every case, hard cap $20.00. A run stops and fails at its cap and records spend; the report names its kind. Only a passing full run makes a step eligible; the model key comes from the secrets interface only; `always_ask` never relaxes. agent-core refuses to create or run a standing rule on a risky step unless the skill has a passing `model_in_loop: true` report whose `skill_hash` matches the installed skill. A `fixture-wiring` report (T61) never unlocks.
**Done when:** one real skill's live report is in its PR (four numbers + spend), the eligibility check is runner-enforced and mutation-checked (missing/stale/failing/fixture-only report each keeps ask-first), and standing rules on risky steps stay locked until then.
**Status:** merged — agent-core#73, 0.7.35; agent-core#75, 0.7.37; failed_at_cap report agent-core#90, f1ac0f8, 0.7.52. Live-run cap decision remains with Braden.

### T65 — Daily-summary failures (agent-core + skills, small) — Braden s51
**Found (s51, Braden's drawer, counts only):** the 29% is the stale Sep 23 Scoreboard (2 first-try of 7 runs by then). All 10 runs to date: 5 first-try done, 4 failed, 1 done_when_failed → 50%; since Sep 23 13:56Z it is 5 of 6. Groups: **(A) 4 fails, Sep 23 02:32–13:55Z**: same step (3-step runs), attempt 1, $0, no model call, stage `done` → failed at a connector/setup step before the skill had its 4th step; none since. **(B) 1 done_when_failed, Sep 23 14:35Z**: the done-when check failed after a model call. **(C) no run Sep 26 or 27** (12:30Z schedule): rig not up, or the clock missed with no catch-up. **Gap:** `skill_run`/`task_ended` log no failure reason and no step name, so a cause can't be read from the log (AGENTS.md "every action logs").
**What:** add `failed_step` + a short error class (no message text, no data) to the failed `skill_run`/`task_ended` lines; confirm (C) from the rig-service log or the T62 catch-up; nothing else.
**Done when:** a failing fake run logs `failed_step` and `error_class`; a missed 12:30Z run is caught up once after restart (T62 clock); test for each.
**Status:** merged — agent-core#74, 0.7.36.

### T66 — Scoreboard events (agent-core, needs Braden) — #271
**What:** make the producers write the events `scoreboard.py` already reads, not a new reader. (1) ask-first: prompt shown, answered yes/no, time to answer (chat plan cards and skill risky-step gate). (2) sourced answer: a chat reply that cites mail/Teams/calendar logs an `answer` with its sources. (3) `tasks_automated` = 3 first-try in a row AND ≥80% for the week (#271). (4) `POST` check-in endpoint (Bearer, loopback): weekly trust + days used, skippable; logs `checkin`. Rig card after T31.
**Done when:** a test drives the real chat path (fake connectors) and the Scoreboard then measures ask-first and sourced answers; the automated definition and check-in each have tests; mutants for each (drop each event/field/condition → a test fails); 0.7.33; `**needs Braden**` PR merged; then Braden restarts and the next nightly shows those lines measured.

### T67 — Account refresh never sent (agent-core + connectors, needs Braden) — #278
**Found (s54, rig log):** `RuntimeWarning: coroutine 'AsyncClient.post' was never awaited` at `local_service_adapters.py:1573` in `GatesConnectorAdapter._ensure_account_worker`, swallowed by `except Exception: pass`. connectors `gates/account.py` calls only sync `http.get`; the un-awaited post is in a helper `ensure_account` reaches (likely token refresh) with an `httpx.AsyncClient` where a sync client is expected. Effect: the account-label refresh is silently dropped.
**What:** find the exact call, make the request actually go out (right client type or awaited), and stop swallowing the failure silently (log an error class, never message text or secrets).
**Done when:** a test fails today (the post is never made) and passes after the fix; the service log shows no RuntimeWarning after restart; `**needs Braden**` PR merged; Braden restarts.

### T68 — Stream decoder refuses new usage fields and blocks (agent-core, needs Braden) — #287
**Found (s57, rig):** every chat on 0.7.40 with the `claude-sonnet-5-5` route failed "Chat could not finish" (model_calls `no_response`, no status). One live capture (coordination/sonnet55-stream-capture.sse, plain text reply) fails at `message_stop` with `ModelError: unsupported billed usage`: usage carries `output_tokens_details: {thinking_tokens: 0}`. Sonnet 5-family models run adaptive thinking by default, so `thinking` blocks (`thinking_delta`, `signature_delta`) will also reach the decoder, which refuses any block other than text/tool_use.
**What:** (1) usage: accept `output_tokens_details` only as a breakdown (each value an int ≤ `output_tokens`); any other unknown usage key still refuses (spend must never be undercounted). (2) streamed and non-streamed content blocks of unknown type are skipped (never shown, never logged as text); text and tool_use unchanged. (3) the failure log carries the error class (e.g. `ModelError:unsupported_usage`) in model_calls, never message text or secrets. (4) tests replay the captured stream (fixture copied from the capture, fake transport) and a synthetic stream with a thinking block + tool_use; both complete with the right usage and cost.
**Done when:** the captured stream test fails on 0.7.41 and passes after; mutants (drop the ≤ check, refuse thinking again, drop the error class) each fail a test; 0.7.42 `**needs Braden**` PR merged; then one real streamed message + one tool round trip on `claude-sonnet-5-5` complete through our client (#287) before the route switches back.

### T69 — Keychain get failing every ~3 s since 09-27 (agent-core, small) — #287
**Found (s57):** secrets-events.jsonl shows the same os-keychain get (name hash `4726a157…`) failing on every ~3 s poll since 2026-09-27T16:35Z (≈38k failures), plus three other names failing every poll with no success ever (`50d6ce73…`, `2a71a8bd…`, `854bf665…`). Not the chat outage cause, but a get that fails every 3 s is not harmless (noise hides real failures; keychain load).
**What:** name each hash (read-only: hash the names agent-core and the vendored wheels request), find the poller, and make a missing optional secret a cached "not set" state (re-checked on a slow timer or on set), logged once per state change, never per poll.
**Done when:** a test proves the poller asks the store at most once per state change for a missing secret; after restart secrets-events shows no per-poll failures; merged on green (not needs Braden unless it touches where a secret goes).
**Status:** merged — agent-core#89, 96d4a65, 0.7.51.

### T70 — Mask credentials read from mail/Teams in chat and summaries (agent-core, needs Braden) — #289
**Found (Braden's Mac, 2026-09-29):** a Teams daily summary showed a credential read from Teams. 
**What:** everything agent-core shows or stores from mail/Teams/calendar text (chat replies, recap/daily summaries, chat files under `chats/`, summary notes) passes one masker first: credential-shaped spans → `[credential hidden]`. Shapes: labelled secrets (`password|pwd|passcode|token|api key|secret|client secret … is|=|: value`), bearer/basic auth values, known key prefixes (`sk-`, `sk-ant-`, `AKIA…`, `gh?_`, `xox?-`, `AIza…`), connection strings (`Server=…;Password=…`, `scheme://user:pass@`), private-key blocks, plus remote's scrubber pieces (`_SENSITIVE` key names, `_CREDENTIAL`, `shannon_entropy` for long high-entropy tokens next to a sensitive word). Reuse remote's patterns by a pinned version (never `latest`), not a copy; free-text shapes that remote lacks land in remote first if they belong there. Masking happens before the text reaches the model's summary output store and before any chat-file write, and again on the model's reply (a model can echo the value). The unmasked value is never logged; the log gets `credential_masked` with a count only.
**Tests:** fake-only fixtures (`sk-FAKE-0000`, `hunter2-FAKE`) for each shape in mail, Teams and a model reply that echoes one; the chat file on disk never contains the fake; a normal sentence with the word "password" and no value is left alone. Mutants: drop each shape family, mask only the reply (not storage), log the value → each fails a test.
**Done when:** 0.7.x `**needs Braden**` PR merged with mutants; Braden restarts; a Teams summary on his Mac shows `[credential hidden]` where the credential was.
Status: merged (see repo CHANGELOG)

### T74 — Windows install: one installer, service bundled, Credential Manager (desktop-app + agent-core, needs Braden) — #316, #317
**Why:** Darren's Windows desktop is the first test machine (#315); today only the Mac app is built and secrets go through the macOS keychain.
**What:** desktop-app CI (windows-latest) builds OASIS-Setup.exe (Tauri 2, NSIS, unsigned) on every main merge and on manual dispatch with the pinned agent-core wheel, its vendored wheels and a Python runtime bundled inside; the app starts rig-service itself on launch and stops it on quit (no separate install, no terminal); agent-core gets a Windows backend for the `secrets` interface using Credential Manager (generic credentials, per-user, same names and semantics as the keychain backend, chosen by platform with no settings; the T69 missing-secret cache applies); first run asks only for a name and the Connect clicks, every other value has a default; docs/windows-install.md shows download → SmartScreen 'More info' → 'Run anyway' → app opens, one screenshot per step; coordination/windows-checks.md in the mac-checks.md shape with a first-run section (download, SmartScreen, install, connect Outlook, one test chat), each row saying what a pass looks like in plain words and what to screenshot on a fail, kept by the orchestrator, results back to Braden.
**Rule:** #316 — one link, one click, one 'Run anyway', the app opens; no terminal, no Python, no second download, no settings to change.
**Tests:** CI asserts the artifact exists, its version matches package.json and the bundled agent-core version; a Windows CI job round-trips set/get/delete against the real Credential Manager with `sk-FAKE-0000`; a test proves the app launches and stops the service; the 200-trace leak test still passes; mutants: secrets fall back to a file, log a value, skip delete, service left running on quit → each fails a test.
**Done when:** Darren goes from the download link to his first chat reply in under 5 minutes with no help from Braden, and the windows-checks.md first-run section is ticked; the agent-core half merges as `**needs Braden**` with mutants.

### T75 — Windows updater + oasis-releases repo (desktop-app + agent-core, needs Braden) — #317
**Why:** after Darren's first pass the app must update itself without a new download link each time.
**What:** a public-safe oasis-releases repo holding signed-manifest release notes and installer artifacts; the app checks it on launch (Tauri updater, pinned versions, never `latest`), downloads the next OASIS-Setup.exe, verifies its hash, and asks once before installing; the same release gate as decision #128 (agent-core nightly green) applies before any release is published.
**Tests:** a fake release feed in tests; hash mismatch refuses; a downgrade refuses; mutants: skip the hash check, auto-install without the ask → each fails.
**Done when:** Darren's desktop moves from one OASIS version to the next with one click inside the app, logged in windows-checks.md. Starts only after Darren completes T74's first-run section.
**Status:** part 1 merged — desktop-app#72 → main 96abf6f (2026-10-02 16:4xZ): updater core (manifest parse with pinned-URL rule, semver + downgrade refusal, sha256 verify, ask-once; 17 tests, mutants 3/3), docs/updater.md, feed endpoint → public `oasis-releases` repo (created; README, publishing steps, manifest example). Part 2 merged — desktop-app#73 → main e70b63f (2026-10-02 17:4xZ): Settings "Check for updates" with a one-time plain-words ask (39 tests, mutants m4/m5), native `install_verified_update` that checks version + url, downloads, verifies sha256 constant-time, then installs (`sha2` pinned; Rust unit tests on CI). Open: the signing key is Braden's secret; Darren's Windows check; first real release in the feed.

### T76 — agent-amber role file v1 (agent-amber + skills + remote, needs Braden) — #328, #329, #330
**Why:** Amber is user one (AGENTS.md); her tool list is in (`coordination/references/amber-tools.md`) and her agent needs a role file before any skill can run for her.
**What:** `profile.yaml` for agent-amber per `repos/skills/docs/formats.md`: role COO; day tools Outlook, Excel, Teams, Acrobat; connectors in priority order Outlook → Teams → OneDrive (read Excel/PDF) → QuickBooks read-only; a `never_automate_hosts` list (all banks, Amex, Keeper, Gusto, ATAP, Square, eBay) that the remote watcher reads as a deny list (refuses to record) and the skills lint reads (no skill may name them); daily note + proposals as her notes+tasks surface (no new app). Three skills queued in order (#330): utility share, freight invoices due, month-end close prep — each its own follow-up ticket (T76a–c) once the role file merges.
**Rule:** the deny list is config in the role file, enforced by code (watcher + lint), never by the model; every do action is ask-first (#98); no company names in a shared skill or fixture (AGENTS.md).
**Tests:** profile validates against formats.md; watcher refuses a recording whose host is on the list (fake host); skills lint refuses a skill.yaml naming a listed host; mutants: drop the deny check in the watcher, drop the lint check → each fails.
**Done when:** agent-amber pins agent-core/skills/connectors by version with the v1 profile merged (needs Braden), the watcher and lint refusals are tested and mutated, and Braden confirms the profile reads right against amber-tools.md. Starts after the Claude plan resets (2026-10-02 23:00Z) unless fable capacity allows sooner.

### T77 — Coworkers page v2 (desktop-app, under #288; screenshots before merge) — Braden 2026-10-01
1. Top: "Your coworker" strip — the one in use, large, animating, with its name and a Change look link. Not a card in the grid.
2. Filter row under it: All · More motion · Ready · Not downloaded, plus a search box. Theme chips (Arcade, Deep space, Pets…) jump to that section.
3. Sections stay by theme, rows left-aligned, 4 per row at 1280, section header shows count and a "More motion" tag only when every pack in it is animated.
4. Click a card → a right-side preview panel: the sprite playing its idle loop at full size, the 8 states as small tiles, theme, size, and one Pick button. Flip stays as the hover delight, Pick moves to the panel.
5. "Your own" section at the bottom for drawer packs, with an "Add a pack" drop target.
6. Empty and loading states drawn, not blank. Reduced motion honored everywhere.
Use ui-ux-pro-max for spacing/type, impeccable as the gate. Render light + dark, rest/hover/panel-open/filtered. Show Braden before merge. Builds on the T50 polish (desktop-app#66).

### T78 — Eight theme avatar packs from the r1 sets (playbooks + agent-core bundling) — decision #338
Package the eight designed r1 sets (12 looks each) as library packs the Rig lists and the app shows on the Coworkers page: manifest per the pack format, 512 px portrait thumbs (cap 256 KB, #337), CREDITS lines (name, source, license, date), bundled like the More-motion packs (playbooks → vendored into agent-core by pin, #281). Still portraits first; motion sheets later. Done when the Coworkers page on Braden's Mac lists the eight themes with their looks.

### T79 — Pack import route (agent-core; desktop "Add a pack" wiring after) — decision #339
agent-core: `POST /avatars/import` (or the route the contract picks) accepts a pack folder/zip from the person's machine, validates structure only (real PNG/YAML, safe names, no path escapes), stores it in the drawer as `source: drawer`, lists it under "Your own"; no hard limits on size/pixels/quality — the response carries a recommended suggestion when a file is far outside the recommendation. Audit line per import. Desktop: the T77 "Add a pack" drop target calls it (separate PR). Done when a dropped pack appears under "Your own" on Braden's Mac.

### T83 — Orb renders a tiny 3×1.5 slice of an animated-tier pack sheet (desktop-app) — Braden 2026-10-02
**Repo:** `desktop-app`.
**Bug:** With the Pets pack `pets-01` (tier animated, 12 columns × 12 rows of 128 px frames, 1536×1536 sheet) in use, the orb showed three full figures and half a second row, all tiny, instead of one frame; standard 4-column packs were fine. Cause: the orb stylesheet fixed the sheet's background-size at 512px 1024px (four columns, eight rows). Evidence: coordination/references/bugs/t83-orb-pets-01-sheet-2026-10-02.png.
**Fix:** Columns, rows, frame size and frame count come from the pack manifest (grid.columns, grid.rows, grid.frame, frames, fps); a manifest without frames keeps four frames at the old rate.
**Tests:** 12-column animated manifest sizes to 1200% × 1200% and the working state starts at column 0, row 1; the 4-column standard manifest pins today's values; a manifest without frames falls back to 4; the orb never shows more than one frame; the orbStyles pin follows the new rule. Mutants m1–m3 (hard-code columns to 4; use frames for the row count; drop the missing-frames fallback) all killed.
**Done when:** The orb shows one frame of pets-01 on Braden's Mac after the rebuilt app is installed.
**Status:** done — merged desktop-app#70 → main 60767fe (2026-10-02 02:41Z); OASIS-60767fe.app installed 02:52Z; proof: the orb shows one frame of pets-01 (coordination/references/bugs/t83-orb-pets-01-fixed-2026-10-02.png, 03:05Z).

### T85 — Preview harness: four stale captures (desktop-app) — night shift 2026-10-02
**Repo:** `desktop-app`.
**Bug:** `npm run preview:screens` on main 60767fe rendered 228 screens with 8 capture failures: settings-narrow "off its contract" (the harness's Settings section list and the stub fixture lagged T23's "Your look" section), coworkers-v2-empty (aria-hidden asserted on the artwork instead of its wrapper), coworkers-v2-loading (fixture held avatar requests before the Coworkers click, so the page never finished), coworkers-v2-own (a pre-T79 "Pending §1.5" placeholder).
**Fix:** harness-only (scripts/preview-screens.ts, tests/previewStub.test.ts); the "Your own" view now renders one drawer pack plus the Add a pack drop target. No UI code changed.
**Done when:** the four views capture in both themes with no failures. Verified on the build tree (26 captures, 0 failures); vitest 1529/1529, typecheck green.
**Status:** done — merged desktop-app#71 → main e50d529 (2026-10-02 03:50Z). No app rebuild needed (developer tooling only).

## T80 — Lesson tool: log, route, ship and publish swarm lessons by command (project-swarm) — Braden typed 2026-10-01, decision #340
**Why:** `coordination/swarm-lessons.md` is 215 KB and 322 rows (48 queued); nobody reads it at boot, lessons leak company names when written by hand (#293), and a rule only reaches a worker through `.swarm/gotchas.md` or a worker skill, otherwise it waits a whole batch release.
**Build (project-swarm 1.41.0):** `swarm lesson add --area <skill|gotchas|tool> --evidence <run id|log> --rule … --fix … [--public …]` appends one JSON line to `coordination/swarm-lessons.jsonl` (id = last id + 1 across the jsonl and the legacy table, date from the clock, private-names check on every field, refuse `private-name` without printing the term) and, for a worker-skill area, appends the rule under `## Lessons` in `coordination/skills/<area>/SKILL.md` (refuse `skill-too-long` over the 800-token cap) or to `.swarm/gotchas.md` for `gotchas`. `lesson list [--queued|--shipped|--area X|--older-than DAYS]` prints one line per lesson. `run` warns `lesson-queue: N queued, oldest #id`. `lesson set <id> --status queued|built|shipped <version>|dropped`. `lesson manifest <id> --agent A --model M` emits a cheap-job manifest (prompt = fix + evidence + "a test that fails without it", context/outputs = the tool files the fix names + `tests/field-lesson-<id>.test.mjs`). `lesson check [--stale-days 7]` reports shipped lessons whose test file is missing from the installed version and queued rows older than the limit. `lesson publish --version V` appends scrubbed public lines (template `<rule> — <generic consequence>`; strips private names, run ids, repo names from .swarm-projects.json, URLs, @handles, home paths; refuses if a private name survives) for the rows shipped in V to `docs/lessons.md`. `lesson import` converts the legacy markdown table once. SKILL.md "Field lessons" section ≤10 lines pointing at the command; references/lessons.md becomes the generated archive.
**Tests:** node:test per command with fake ids; a private name in any field is refused; `add --area` past the cap is refused; `publish` with a run id or URL in the public line is refused; `manifest` output passes `validate`; `check` flags a shipped row whose test is absent.
**Done when:** 1.41.0 installed, lessons #322/#323 logged through the command, the queued count shows in `run` warnings, and Braden has OK'd the public template once.

## T81 — Speed pipeline: one command from manifest to merged PR; workers run their own checks (project-swarm) — Braden typed 2026-10-01, decision #341
**Why (measured s69):** agent-core#96 took 18.4 min wall: Codex build 4 min, seat hand checks 3 min, ship waited 10.8 min for the non-required full tier, and every stage was a separate orchestrator turn. Half of the session's Codex launches died in under 31 s with the stderr thrown away.
**Build (project-swarm 1.42.0):** 1. `ship --wait-required-only`: read the base branch's required status contexts (`gh api repos/O/R/branches/B/protection/required_status_checks`), wait for those only, merge, report the still-pending jobs in the output JSON. 2. `swarm ticket <manifest> --pr <payload> [--check JSON]… [--repo O/R] [--branch B] [--commit-message M]`: run → inspect → integrate → checks → commit → ship, one process, JSON per stage into `.swarm/runs/<id>/pipeline.json`, stop on the first red with `{"status":"error","stage":…}`, `--resume <run>` skips finished stages. 3. Codex workspace environment: when the root has `.venv` or `node_modules`, the workspace gets a symlink to it and the sandbox allows it (read + exec, never write); `--sync` instead runs `uv sync --locked` or `npm ci` in the workspace; the job message lists the manifest `checks` the worker should run before returning; a check that cannot start (`Failed to spawn`, `command not found`, exit 127/2 in the first lines) is classed `check-env-missing` with the sync hint, never `pre-existing` (lesson #323). 4. Adapter evidence: codex and claude-shell write `stderr.txt` and `stdout.txt` into `.swarm/runs/<id>/<job>/`; `inspect` prints the last 20 stderr lines of a failed job; `run` retries a Codex job once when stderr matches the network-blip signature and no declared output exists, and records `retries` in state.json (lesson #322). 5. Scaffolds: `swarm scaffold job --id X --agent A --model M --context … --outputs … [--ticket FILE#Tnn]` writes a manifest with tier prompt lines, timeouts and `ignoreTests` filled from the context check; `swarm scaffold pr --from <run-id> --title T [--repo O/R]` writes the PR payload (## What from results + CHANGELOG top entry, ## Checks placeholder, ## Mutation check stub); `ship --require-section` refuses an unfilled stub with `stub-section`.
**Tests (node:test, fake ids, no names/repos/URLs):** required-only merge waits for the protected contexts and not the others (fake gh); pipeline stops at the red stage and resume skips the green ones; a workspace with a linked `.venv` runs a check the plain copy cannot; spawn failure → `check-env-missing`, never `pre-existing`; stderr.txt exists after a failing fake codex; one retry on the blip signature, none otherwise; scaffolded manifest passes `validate`; scaffolded payload with the stub is refused by ship, filled is accepted. Mutants: each test named with the one-line change that makes it fail.
**Done when:** 1.42.0 installed; the next three OASIS PRs go through `swarm ticket`; the weekly row shows wall per merged PR against this week's 12.5–18.4 min.

## T91 — Browser tool (agent-core) — Braden typed 2026-10-02

**Why:** Skills need to interact with web applications that require login, form filling, and navigation. A scriptable browser with safety gates prevents credential leaks and unintended actions.

**Build:**
1. `src/anorak/browser.py` with Playwright for Python (pinned); one persistent browser profile per person stored in the drawer (`~/.oasis/drawers/<person>/browser-profile/`); all profiles use the same executable with persistent cookies and auth state.
2. Never types into credential-shaped fields (password, one-time code, card number, SSN); refuses such attempts with a plain-words error line and logs the refusal.
3. Enforces `never_automate_hosts` from `profile.yaml` at the browser layer: navigation and sub-resource requests to blocked hosts are prevented and logged.
4. Ask-first gates: (a) on first visit to a new host (pause and wait for Yes), (b) on any form submit or post button (pause with `always_ask` — never auto-submit).
5. Every step leaves a screenshot written only through the scrubber (remote's scrubber interface); screenshots are logged with step metadata but no sensitive visual data is stored raw.
6. Every action logs who, what action, target host, and when (host blocked, credential refused, submit paused, screenshot taken).
7. Works on both Windows (CI job) and macOS; mutation checks on each gate (credential typing, host block, submit ask, scrubber bypass) each kill a test.

**Tests:**
- Typing into a password field refuses with the plain-words line logged.
- Navigation to a blocked host is prevented and logged.
- First visit to a new host pauses and waits for Yes before proceeding.
- Form submit pauses and waits for Yes.
- Screenshots are written through the scrubber only.
- All actions are logged with metadata.
- Four mutation checks (credential, host, submit, scrubber) each fail a test.
- Tests pass on both Windows and macOS.

**Done when:** agent-core gains the `browser` tool; all tests pass on Windows (CI job) and macOS; `**needs Braden**` PR with ask-first gate and scrubber integration merged.

**Status:** done — Braden's Mac check passed on rig 0.7.66 (2026-10-06): Allow card once, site remembered, one-line answer, real heading. Chain: agent-core#98 (0.7.60) → #99–#104 (0.7.61–0.7.66).

## T92 — Read-only web fetch through T91 (rag-pipeline) — Braden typed 2026-10-02

**Why:** RAG pipelines need to fetch and extract text from web pages without automation risk. Using the T91 browser tool read-only provides safety while capturing the page content.

**Build:**
1. `src/rag/browser_fetch.py` fetches a page through T91 with no typing and no form submission.
2. Same host blocking as T91: navigation to blocked hosts is refused.
3. Returns page text (extracted from HTML) plus a reference to the screenshot captured by T91.
4. Tests use a fake T91 browser interface.

**Tests:**
- Page fetch returns text and screenshot reference.
- Blocked hosts are refused.
- Fake browser interface works end to end.

**Done when:** rag-pipeline fetches a page read-only through T91 and returns text + screenshot ref; tests pass with a fake browser.

## T93 — First browser skill: utility bill draft (skills) — Braden typed 2026-10-02

**Why:** Utility bill collection is a common bookkeeping task. A browser skill using the person's own saved session demonstrates the full T91 + T92 loop in a real workflow.

**Build:**
1. `skills/utility-bill-draft/` skill that logs into the TurboTenant site using the person's own saved session (never asks for or types credentials).
2. Fills a utility bill draft form from provided arguments (date, amount, vendor, reference).
3. Stops before Submit (marked `always_ask`); a person must confirm the final step manually.
4. Test fixtures use fake browser responses; no client data or real vendor credentials in fixtures.
5. PR flags: the vendor name (TurboTenant) is the target site, not a client identifier.

**Tests:**
- Logs in with saved session.
- Fills form fields from arguments.
- Stops before submit and waits for confirmation.
- Fixtures are fakes; no client data in tests.

**Done when:** Braden runs the skill on his Mac with a real saved session, confirms the form is filled correctly, and the submit gate pauses for his Yes; all tests pass.


### T93b — Bind utility-bill-draft's actions in agent-core (agent-core; needs Braden: browser + ask-first) — found 2026-10-06 (s73)

**Why:** T93 merged the skill in the skills repo, but agent-core never registered its actions. On the rig today `compute.check_bill_arguments`, `browser.open`, `browser.fields`, `compute.detect_sign_in`, `browser.fill_draft` and `browser.stop_before_submit` have no registered callable (loop.py raises "Missing registered callable"; only `model.critic` resolves). Found by the T96 contract (astra) and confirmed by a haiku scout. So the skill cannot reach the sign-in stop or the form yet.
**Build:** register the six actions and the `bill_draft_stopped` checker the way daily-summary's are (an agent-core module + skill_tools registration), on top of the existing browser tool and its gates; `submit_bill` stays `always_ask` and has no click path; the terminal output carries the structured `sign_in_needed` status that T96's trusted producer reads. The skills wheel cannot be vendored at 0.13.0 while playbooks pins skills==0.2.1.post1, so the contract decides between porting the small compute helpers and a pin change (stricter: port, no pin change).
**Order:** after T96 merges (shares skill_tools.py and pyproject.toml).
**Done when:** T93's done-when — Braden runs the skill on his Mac with a fake bill, signs in through T96's window, the boxes match and it stops before Submit.

---

## T87 — OneDrive live: write reach with ask-first (connectors, agent-core; needs Braden) — Braden typed 2026-10-05

**Why:** decision #98: agents are coworkers who act — full write reach in every connector, a Yes on each do action. OneDrive is read/search only (T27 v1); the four write functions (`file_create`, `file_move`, `file_share`, `file_delete`) already exist in `gates.graph_write` with write-audit tests but the catalog never offers them.

**Build:**
1. connectors 0.5.5: `catalog/onedrive/connector.yaml` adds the `Files.ReadWrite.All` scope and `cannot_do_without_yes: [create_file, move_file, share_file, delete_file]`; `can_do` unchanged; the connector notes say the scope is a new Entra ask Braden must consent to (like Outlook's Mail.Send in T27). Catalog tests pin the four names and that none sits in `can_do`.
2. agent-core 0.7.61: vendors connectors 0.5.5 and binds the four OneDrive write tools in `chat_tools` the same way Outlook's `send_mail`/`reply_mail`/`move_mail` are bound — each goes through the ask-first gate, each audit row names the file path and action, `file_delete` is `always_ask`-tier (never a standing permission).
3. Live: Braden grants admin consent for `Files.ReadWrite.All` in the Entra app, reconnects OneDrive on his rig, and the Mac-check row proves: a chat ask to create a small text file in a test folder shows the Yes card with the exact path; No creates nothing; Yes creates it once; the audit row exists.

**Tests:** catalog shape; chat binding refuses to run any of the four without a Yes (injection test suite row per T28a); delete never becomes a standing permission; mutants: offer a write in `can_do`, skip the gate for `file_move`, let `file_delete` take a standing permission → each fails.

**Done when:** connectors 0.5.5 and agent-core 0.7.61 merged (needs Braden: ask-first gate), consent granted, and the Mac-check row passes on Braden's rig. Not before: T88 QuickBooks read-only live, T89 Outlook Calendar live, T90 To Do + Planner → daily note (tickets to open next).

## T88 — QuickBooks read-only live (connectors; needs Braden) — Braden typed 2026-10-05

**Why:** the QuickBooks connector (qbo_month_pack, P&L, balance sheet, trial balance, accounts; no writes; admin only, #165) has only ever run against the fake (`OASIS_DEV_FAKE_QUICKBOOKS=1`, T33). Amber's month-end skills (T76c) need the real company file.
**What (Braden first):** an Intuit developer app for OASIS (production keys), its client id in the `secrets` interface under the catalog's `client_id_config_key`, the company realm id, and one OAuth connect on his rig with the fake flag off. Then the live Mac-check row: Settings → Connect QuickBooks → the connection test reads one report; ask Beacon for last month's P&L → numbers match QuickBooks Online; nothing is written; the audit rows exist.
**Build:** nothing new in code unless the live run shows a gap (sandbox vs production base URL, realm id prompt, token refresh). Any gap becomes a bounded connectors PR.
**Done when:** the live row passes on Braden's rig and T76c month-end-close-prep runs once on real data with the fake flag off.

## T89 — Outlook Calendar live (connectors; needs Braden) — Braden typed 2026-10-05

**Why:** the calendar connector already offers `create_event`, `update_event`, `delete_event` as `cannot_do_without_yes` (T27) and `read_calendar`; the write scope `Calendars.ReadWrite` is consented for reads but the T27 write-ask status in docs/registrations.md is still pending.
**What (Braden first):** confirm `Calendars.ReadWrite` is granted with admin consent in the Entra app (it is one scope for reads and writes), reconnect Outlook Calendar on his rig, then the Mac-check row: ask Beacon to put a 15-minute hold on his own calendar tomorrow → the Yes card shows the exact title and time; No creates nothing; Yes creates it once; update and delete the same hold the same way; `delete_event` never becomes a standing permission.
**Build:** none unless the live run shows a gap. Same ask-first rules as T87.
**Done when:** the live row passes and docs/registrations.md marks the calendar write ask consented.

## T90 — To Do + Planner into the daily note (connectors, skills, agent-core) — Braden typed 2026-10-05

**Why:** Amber's day lives in Microsoft To Do and Planner; the daily note (daily-summary skill) should list what is due today and overdue, read-only.
**Build:**
1. connectors 0.5.6: two read-only catalog connectors, `microsoft-todo` (`Tasks.Read`; `todo_lists`, `todo_tasks_due` = tasks due today or overdue across the person's lists) and `planner` (`Tasks.Read` + `Group.Read.All`; `planner_my_tasks_due` = the person's assigned tasks due today or overdue, with plan and bucket names). Reads only; `cannot_do_without_yes: []`. Graph read functions in `gates.graph_read` in the house shape (nextLink host check #285, 20k text cap, plain-words errors); fakes in tests; no task text ever enters system instructions (#73).
2. skills 0.13.0: `shared/daily-summary` gains a "Tasks today" section fed by the two new reads (ask-free), sorted overdue first, capped at 20 lines, task titles treated as data (the injection test row: a task titled like an instruction changes nothing).
3. agent-core 0.7.6x: vendors connectors 0.5.6, binds `todo_*`/`planner_*` as read tools (no gate needed), skills bump.
4. Braden: admin consent for `Tasks.Read` and `Group.Read.All` (new Entra asks), connect both on his rig; Mac-check row: his daily note shows today's To Do and Planner items.
**Tests:** catalog shape; due-today/overdue filter with a fixed clock; nextLink refusal; skill section renders from fakes; injection row; mutants: drop the overdue filter, let a task title reach the plan, offer a write → each fails.
**Done when:** connectors 0.5.6, skills 0.13.0 and the agent-core bump merged (connectors + skills are not needs-Braden: reads only; agent-core bump is), consent granted, and the daily note on Braden's rig lists real tasks.

## T94 — Dock polish (desktop-app) — Braden typed 2026-10-05

**Repo:** `desktop-app` (orb window: `src/orb/orbDock.tsx`, `OrbApp.tsx`, `orb.css`, `orbHoverCard.ts`).
**Braden's three items:**
1. The pencil button (`new-chat` → `open_chat`) and the window-icon button (`open-oasis` → `showPanel`) do the same thing for the person: both land on the main window. Keep one. Decision (orchestrator, provisional): keep the pencil as "New chat"; drop `open-oasis` from the dock — "Open OASIS" stays in the right-click menu (`orbMenu.ts`). Dock order/width tests follow.
2. A grey placeholder square shows behind avatars with transparent pixels. Find the element or style that paints it (sheet/img fallback background, glow/surface token, or the grown-window surface) and remove it so transparent sprites show only the avatar, shadow and glow; standard and animated packs both.
3. The dock must not overlap the shortcut list (the list that appears beside the orb — Quick chat's list or the hover card). Reserve layout space or move the dock (the `data-dock-above` flip exists) so nothing covers the list in any screen edge placement.
4. The "working" speech bubble renders twice: once on the avatar's chest and again near the status card. Fix: one bubble only, anchored above the head, offset by the avatar's height (so it never covers the sprite), in every placement and when flipped.
5. (Braden's Mac check, 0.7.62) The chat view shows the default Beacon avatar icon instead of the person's selected coworker pack. Use the selected pack like the orb and the Coworkers strip do; default only when none is selected.
**Evidence:** Braden's screenshots → `coordination/references/t94/` (folder created; he will drop them in). Harness: `npm run preview:screens` (orb states, light + dark).
**Tests:** dock renders four items in the fixed order with no `open-oasis`; the menu still offers Open OASIS; no element behind `.avatar-character` has a background (a DOM/CSS assertion in the orb tests); dock and list bounding boxes never intersect in the harness captures for the four edge placements; existing orb tests updated, not weakened. Mutants: restore the fifth dock item → red; reintroduce the background → red; disable the overlap rule → red.
**Done when:** vitest + typecheck + lint green, harness captures clean, OASIS.app built from the merged commit and Braden's Mac check passes (rows in mac-checks.md).

## T91d — Yes on the browser card approves the site for the task and resumes it (agent-core hotfix) — Braden typed 2026-10-05

**Why:** on 0.7.62 the Yes card works and the page opens, but the service re-ran only the one approved call and stopped; the person had to ask again. Braden: "Yes = approve the site for this task, not one call."
**Build:** Yes on a first-visit card approves that host for the rest of the thread (task); later browser calls on that host in that thread pass the new-host gate without asking; submit asks stay `always_ask`. After Yes the service resumes the model turn (same message, same thread) so the model re-issues the open, reads the page and answers. No/expiry unchanged. A new thread asks again (thread scope, decision #353 provisional — stricter than a per-person permanent approval).
**Tests:** Yes → follow-up reply holds the page title and the fake port shows one navigation plus the read; same host again in the thread → no card; different host → new card; new thread → asks; submit still asks after a host approval; No/expiry still never navigate. Mutants: approval not recorded → card re-asks; turn not resumed → reply lacks the title; submit covered by host approval → red.
**Done when:** Braden's Mac check: "open example.com and tell me the page title" → Yes → the title comes back in the same conversation without a second ask.

**Status:** done — Braden's Mac check passed on rig 0.7.66 (2026-10-06): Allow card once, site remembered, one-line answer, real heading. Chain: agent-core#98 (0.7.60) → #99–#104 (0.7.61–0.7.66).

## T91e — Browser card shows Done after Yes; read starts with title + h1-h3 (agent-core hotfix) — Braden typed 2026-10-05

**Why (Braden's Mac check on 0.7.64 + app 674d86d):** Yes resumes and answers, the chat avatar and dock are fixed, but (1) the card says "Nothing was done" after Yes although the page was read: the confirmed card carries an empty results list; (2) the read action returns body text without the title or headings, so the model answered "Example Domain" from memory.
**Build:** (1) the confirmed card for a browser Yes carries the resumed browser call(s) as results (ok + plain detail), so the app shows Done or the real failure. (2) read returns `Title: ...` then h1-h3 lines in document order (max 40), a blank line, then the body; all inside the untrusted page label (#73), under the existing cap.
**Tests:** card ends ok with a non-empty result naming the host; failure shows the plain line; a fake page titled with strings no model could know (e.g. 'Zebra Pancake Registry') returns them first and in order; no title → 'Title: (none)'.
(3) Braden's decision #355: a first-visit Yes approves the host for the person forever (approved_hosts.json), the card reads "Allow <host>", submit/send/pay still ask every time, never-automate hosts unchanged. Replaces T91d's thread scope.
**Done when:** Braden's check: "open example.com and tell me the page title" → "Allow example.com" card → Yes → the card shows Done and the answer quotes the page's own title and heading; a new chat opening example.com asks nothing; a submit still asks.

**Status:** done — Braden's Mac check passed on rig 0.7.66 (2026-10-06): Allow card once, site remembered, one-line answer, real heading. Chain: agent-core#98 (0.7.60) → #99–#104 (0.7.61–0.7.66).

## T91g — One-line browser answers, no phantom card; say when a page has no headings (agent-core hotfix) — Braden typed 2026-10-05

**Why (Braden's Mac check on 0.7.65):** site remembered, title from the page — but (1) the read showed only the Title line: example.com today has NO h1–h3 (verified live: title, an icon, two paragraphs), so the model hedged instead of saying so; (2) in a reused chat the reply ran 5 paragraphs and 'corrected' an earlier card claim: the 0.7.64 waiting line 'I asked you first — say Yes on the card.' had been stored as an assistant message, and history carried no record of tool calls, so later turns disowned their own read.
**Build:** the read adds 'Headings: none on this page (no h1-h3).' when there are none; the waiting line is shown but never stored; each stored assistant message carries a 'Used: browser open <host>; browser read <host>' note that is replayed to the model (names/hosts only, never page text); reply shape gains 'simple question or single lookup → one line; never comment on earlier replies unless asked'.
**Done when:** Braden asks 'open example.com and tell me the page heading' → one line saying the page has no heading and its title is "Example Domain"; 'how are you' in the same chat → a short answer with no self-correction.

**Status:** done — Braden's Mac check passed on rig 0.7.66 (2026-10-06): Allow card once, site remembered, one-line answer, real heading. Chain: agent-core#98 (0.7.60) → #99–#104 (0.7.61–0.7.66).



---

## T96 — "Sign in to this site": the person signs in once in a window of their own (agent-core + desktop-app; needs Braden) — Braden typed 2026-10-06

**Why:** the browser tool is headless, so a browser skill (T93 utility-bill-draft) can only stop at a sign-in page. Decision #347a = (a), decision #356.

**Build:**
1. **agent-core:** a sign-in action opens a visible (headed) Chromium window on the site, using the agent browser's own profile folder (never the person's Chrome profile; option b rejected). The host passes the same host rules as the browser tool (never-automate hosts, IP and loopback addresses refused). Site approval (#355) is unchanged by signing in.
2. **The window belongs to the person (Braden's rule):** while it is open, the agent reads nothing from it (no page text, fields, URLs, cookies or storage), takes no screenshots, writes nothing to the trail, records no keystrokes, and the browser tool refuses every call on any host with one plain line ("A sign-in window is open. I'll wait until you close it."). The only log rows are "sign-in window opened for <host>" and "closed" (host and time only).
3. It ends when the person closes the window (or taps Done in the app, which closes it), or after 15 minutes (Braden 10-06: 2FA by text is slow). No cookie polling while it is open. After it closes, the session stays in the agent's profile and the next run uses it.
4. **desktop-app:** when a run stops at a sign-in page, the chat shows a "Sign in to <host>" button under the stop line; tapping it opens the window and shows "Waiting for you to sign in to <host>… Done" until it closes. Settings is not built in this ticket (thin).
5. macOS and Windows.

**Tests:** the browser tool is refused on every host while the window is open; no screenshot, trail row or page read happens while open; the log rows carry the host only; closing the window (and the 15-minute timeout) unlocks the tool; never-automate hosts and IP/loopback hosts refuse the sign-in action; the app renders the button only on the structured sign-in stop, never from page or model text. **Mutation check:** let one browser call through while the window is open; take a screenshot while open; write a trail row while open; skip the host rules on the sign-in action. Each must turn a test red.

**Done when:** agent-core (needs Braden) and desktop-app PRs merged; Braden's Mac check: run utility-bill-draft with a fake bill → sign-in stop → "Sign in to <host>" → he signs in and closes the window → run again → the boxes match the fake bill and it stops before Submit with the ask card. That run also closes T93's done-when.

---

## T97 — Settings → Sites: allowed and signed-in sites with Forget (desktop-app + agent-core) — Braden typed 2026-10-06; LATER, not now

**What:** a Settings → Sites list showing every site the person allowed (#355, approved_hosts.json) and every site signed in through T96, each with a Forget button. Forget on an allowed site removes the approval (the next visit asks again); Forget on a signed-in site clears that site's session from the agent browser's profile.
**Status:** queued after T96 and T93's full pass. Not started.
**Expanded (Braden typed 2026-10-06, s76):** three lists, each entry with an on/off toggle: Allowed sites (with Forget), Blocked by browser policy (the never-automate list), Signed-in sites. The user can add, remove and toggle any entry; changes apply at once and every change is logged (action log). Admin role (Braden) can edit everything. Other roles see the blocked list, but locked entries (banks, Amex, Keeper, Gusto, ATAP, Square, eBay) need admin unlock.

## T98 — Research: tinyhumansai/openhuman memory tree + run journal (research only; no code) — Braden typed 2026-10-06

**Why:** see whether openhuman's memory tree and run journal hold ideas for rag-pipeline (retrieval/memory) and the Scoreboard (run measurement). Its install/connect flow is a reference for T77 (Coworkers page) and T75 (updater/installer).
**License guard:** openhuman is GPL-3. Ideas only: no code, no copied text, no file of theirs enters any OASIS repo. Screenshots are internal reference images under coordination/references/t98/ only, never shipped in a product repo.
**Build:** (1) read-only web scout of the repo (memory tree, run journal, install/connect flow); (2) a one-page comparison at coordination/research/openhuman.md: what each does, how ours differs (rag-pipeline, agent-core memory, Scoreboard), 3–6 borrowable ideas each tagged with the ticket it would touch, and what not to borrow; (3) screenshots of its connect and install flow from public docs/README/site (no install on Braden's Mac), one PNG per step, labelled, in coordination/references/t98/.
**Done when:** the page (≤1 screen-page, ideas only, sources linked) and the labelled screenshots exist; Braden reads them. No ticket opens from it without his word.

## T99 — "Local" model route: OpenAI-compatible, per-chat choice (agent-core; needs Braden: model key) — Braden typed 2026-10-06

**What (Braden):** a `local` model route, OpenAI-compatible: base_url `http://10.10.10.220:8000/v1`, key from the keychain entry `model.local.api_key` (through the `secrets` interface), model id `llama-moe3`, label "Local (dev2)". Each chat picks its model; the default stays `claude-sonnet-5-5`. It works for chat calls and rag-pipeline calls. The health check shows "Local offline" when unreachable, with no retry storms. Braden verified from his Mac: `/v1/models` returns `llama-moe3`.
**Rule #357:** testing on Braden's rig only; not in Amber's or any other role until he says (provisional details in DECISIONS #357: dev setting default off; private-range http only; cost 0, tokens counted; #73 applies).
**Build:** route config + an OpenAI-compatible client beside the existing Claude path (no new dependency unless the plan already has one; httpx is in use); per-chat model field on the chat thread (default claude-sonnet-5-5; switching mid-chat allowed; each reply records which model answered); the local service exposes the route list (name, label, cloud/local, online) and accepts a per-chat choice; health check with backoff (one probe per interval, no per-request retry loop; offline → plain-words "Local offline", chat refuses to send to it rather than silently falling back); rag-pipeline model calls follow the chat's choice; every action log row names the model that ran.
**Tests:** route config + secret lookup (fake key `sk-FAKE-0000`); health offline/online and backoff (a burst of requests while offline makes at most one probe per interval); per-chat choice persists and switches; reply carries model id; role-file chat never lists `local` (#357); public http host refused for the keyed route; untrusted text never in the system message for local calls (#73 mutant).
**Done when:** agent-core PR merged (needs Braden: model key) with mutants; Braden restarts the rig; a chat on his Mac set to Local (dev2) answers from llama-moe3, and switching back to Sonnet works mid-chat.

## T100 — Model picker in the chat header (desktop-app) — Braden typed 2026-10-06

**What (Braden):** a model picker in the chat header, per chat, showing the model name + a Cloud/Local badge; each reply bubble is tagged with the model that answered; switching is allowed mid-chat. Mac check by Braden.
**Build:** reads T99's route list and per-chat choice from the local service; offline routes show "offline" and cannot be picked; the picker only lists what the service offers (so #357 holds in the app too); bubble tag is small text under the bubble. Screenshots of each state (closed, open, offline, tagged bubbles) go with the PR (#293).
**Done when:** desktop-app PR merged after T99, OASIS.app rebuilt, Braden's Mac check passes (pick Local, answer tagged llama-moe3, switch back mid-chat, tag shows Sonnet).

## T100b — Model picker design pass (desktop-app) — Braden typed 2026-10-06

**What (Braden):** before T100's PR. (1) provider mark per model: official brand asset with its license noted in CREDITS.md, monogram fallback; (2) pill = mark + full name (e.g. "Claude Sonnet 5.5", never cut off; widen the pill) + Cloud/Local badge + status dot (green online, grey offline), animated open/close and hover like the holo cards; (3) the picked model gets a short ring pulse; (4) reply tags show the mark too; (5) matches the app's existing look, light and dark. The open list may cover the chat. The offline Local row reads "Local (dev2) — offline" and cannot be picked. Feel reference: coordination/research/openhuman.md + coordination/references/t98/ (screenshots only; GPL, no code or text). Checks: desktop-design-check (ui-ux-pro-max + impeccable distilled) on the renders. Reduced motion: no animation.
**Also fixes:** the 'closed' preview view rendered the list open (closed and open PNGs were identical bytes).
**Provisional (#159, stricter):** a brand mark ships only when its owner's published terms allow this use and the CREDITS.md line names them; otherwise the monogram ships and the mark question goes to Braden.
**Done when:** four states (closed, open, offline, two-model tags) re-rendered light + dark, design check passed, vitest/tsc/eslint green, harness green, then T100's PR opens (merges after T99).

## T101 — Adopt mattpocock/skills as worker skills (project-swarm) — Braden typed 2026-10-06

**What (Braden):** adopt mattpocock/skills (MIT, pinned commit). Vendor tdd, diagnosing-bugs, code-review, resolving-merge-conflicts, writing-for-agents as worker skills in project-swarm with our `paths:`/`checks:` frontmatter, trimmed to fit the skill limits, LICENSE kept. Separate one-page compare of to-tickets / to-spec / handoff vs ours: propose line-level edits, no replacement. Rework metric before/after. Private-names guard applies.
**Pins:** 6fd947921b935b7e1e69293a200400f0fdd5c15f (2026-10-06) for four skills; resolving-merge-conflicts was removed upstream (daa01d8) → vendored from its last version at 153fc1b93de6584562765cdce299324e1ff9e661 (same MIT license).
**Provisional (#159):** skills ship under project-swarm `templates/coordination/skills/<name>/` (scaffolded into a project's coordination/skills); each ≤800 tokens (swarm warns >800, refuses >1200); upstream LICENSE copied beside each; OASIS's own coordination/skills/code-review stays and wins in this project (no auto-replace).
**Rework metric:** before = `session_metrics.py --rework-only` red_rate and swarm `reworkBySkill` at adoption; after = same over the next 20 integrated runs that attach a vendored skill.
**Done when:** project-swarm PR merged (private-names 0 hits, each skill loads under cap, LICENSE present, CREDITS line with pin); compare page at coordination/research/t101-compare.md; before row in swarm-metrics.md.

## T102 — "Take over this tab" in the OASIS Chrome extension — Braden typed 2026-10-06

**What (Braden):** the agent drives the user's current tab (or one they point at) via the OASIS Chrome extension, using their existing logins. Same gates as T91: Allow per site, ask on submit/send/pay shapes, never-automate hosts blocked, no credential typing, scrubbed trail. A visible "OASIS is driving" bar with Stop. The T96 window stays as the fallback. Contract first.
**Blocker found at intake (s76):** no Chrome extension exists in any repo. T64 is the Windows watcher (capture proxy, remote); the extension appears only in PLAN.md (§Tech, risk 4) and was never ticketed. **Braden (s76):** T102 builds it: new extension at desktop-app/extension (TypeScript, AGENTS.md), contract covers the extension, its link to the rig and take-over.

## T103 — Attachments in chat: paperclip, drag-and-drop, paste (desktop-app + agent-core) — Braden typed 2026-10-06

**What (Braden):** paperclip + drag-and-drop in chat. Images (png/jpg, screenshots, paste from clipboard) go to the model as vision; files (pdf, xlsx, docx, csv, txt) are read with our readers and the text goes to the model. Stored in the person's drawer, text through the scrubber, 20 MB cap, thumbnail in the bubble. The Local model can't see images: say so in plain words and offer Cloud. Works for the agent too: it can save a screenshot to the drawer and show it in chat. Mac check by Braden.
**Intake (s77):** no document readers exist in any repo today. pymupdf4llm 1.28.2 is the approved PDF path (#312) but was never added; xlsx/docx readers would be new dependencies (openpyxl, python-docx) → Braden's yes + pins. csv/txt use the standard library.
**Provisional (#159, stricter):** attachment text is untrusted data, travels as its own labelled message, never system text (#73); text is scrubbed before it is stored or logged; the 20 MB cap is checked in the app and again on the rig; files keep to the person's drawer (never git, never shared); a model without vision gets no image bytes. New dependencies land only after Braden's yes, each pinned with provenance.
**Done when:** agent-core + desktop-app PRs merged with mutants; OASIS.app rebuilt; Braden's Mac check: attach a png, a pasted screenshot, a pdf and an xlsx; thumbnails show; the answer uses them; on Local the image refusal + Cloud offer shows; the agent saves a screenshot and it shows in chat.

## T104 — Tasks page: a task becomes a live step pipeline (desktop-app + agent-core) — Braden typed 2026-10-06

**What (Braden):** (1) Amber describes a task in chat (what + how); the agent turns it into a step pipeline shown on the Tasks page as a diagram — archify's renderer if its license allows, else our own node graph in the holo style. (2) Each step shows done / in progress / left; updates live from skill plan cards, T90 To Do/Planner items, and her own tick. (3) Reopening tomorrow shows where she stopped, with a "pick up here" button. (4) Ask-first steps show locked until her Yes. Contract first; Mac check by Braden.
**Decided (#373, Braden):** tick stays in OASIS (write-back to To Do = later ticket, only after Amber asks); To Do/Planner items move a step only via an explicit link, never fuzzy matching.
**Intake (s78):** archify is MIT (pinned d5a1333, t72-pins.md, CREDITS.md line exists) — license allows; fit (live status, React embed, size) is the contract's call against stated criteria. T90 reads are `Tasks.Read` only, so her tick is stored in OASIS, not written back to To Do/Planner (write-back = new scope + consent = later ticket).
**Provisional (#159, stricter):** pipelines live in her drawer, never git; step text and To Do/Planner titles are untrusted data (never system text, #73) and can never lock, unlock or skip a step; locked = the skill's `risky_steps`/`always_ask`, unlocked only by the runner's ask-first Yes; her tick cannot mark a locked step done; "pick up here" resumes, never auto-runs a risky step.
**Done when:** agent-core (needs Braden: gate display) + desktop-app PRs merged with mutants; OASIS.app rebuilt; Braden's Mac check: describe a task in chat → pipeline on Tasks; tick a step; a plan card and a To Do item move steps; a locked step stays locked until Yes; quit, reopen → "pick up here" at the right step.

## T104b — Linked To Do/Planner item status for the Tasks page (connectors + agent-core) — Braden picked 2026-10-06 (#374)

**What:** a read-only connector function that returns one linked item's status (To Do `status`; Planner `percentComplete`) by its exact id, under the scopes T90 already holds. agent-core binds it as a read tool and the T104 pipeline uses it to move a linked step (mapping in t104-contract §T90). No writes, no new scopes, titles are data.
**Done when:** connectors + agent-core PRs merged with tests (fake Graph responses, injection row); on Braden's Mac a linked To Do item marked complete moves its step to done on Tasks.

## T105 — Shard agent-core's Windows full suite 4 ways (agent-core CI) — Braden typed 2026-10-06, low priority, after T104

**Why:** the Windows `tests, lint, types` job runs the whole suite in one step (11–12 min, 2580 tests); #108 hit the 12-min step limit with every test passing. ci-timeout raised the limit to 20 min as a stopgap.
**Build:** split the Windows full suite into 4 shards with the same shard-list approach the gate uses (T51, `gate-tests (0..3)`); lint + types run once; each shard keeps faulthandler timeouts. Required-check names updated so ship/merge still waits on all shards.
**Done when:** agent-core PR merged; each Windows shard under 5 min on two consecutive runs; total tests across shards equals the unsharded count.

**Status:** DONE 2026-10-06 — agent-core#111 merged (s79). Shards 2.6–3.6 min on PR run + main push run 37536085563 (was 11:56 unsharded); 4×773 = 3092 ids (3077 passed, 15 skipped) vs 3091 unsharded on f85abab (+1 = T105's own test). Note: xargs splits each shard into 4 pytest chunks (Windows arg limit); harmless.

## T93d — Utility bill run hotfix: skill card Done, optional due date, no unasked reads, page loads not submits (agent-core 0.7.71) — Braden typed 2026-10-06

**Why (Braden's run on rig 0.7.70; screenshots coordination/references/t93/, company data, never in git):** failed before sign-in. (1) skill card shows "Nothing was done" after Yes — T91e's Done fix covered browser cards only. (2) skill still required a due date, and the model searched Outlook, notes and Gmail for the tenant on its own. (3) opening the page was blocked as "tried to send information": the site's own xhr/fetch POSTs on load were treated as submits.
**Build (brief worktrees/agent-core-t93d/docs/_swarm/t93d-brief.md):** confirmed skill card carries step results; due date optional; on a skill-run turn connector reads are not offered unless the message names a source; only user-shaped submits ask (form/document POST, submit, requestSubmit, and — provisional #159, stricter — unsafe xhr/fetch within a short window after an agent page action). Mutants M1–M7.
**Done when:** needs-Braden PR merged (gate) with mutants; rig restarted; Braden's run reaches sign-in/the Create charge modal and stops before CREATE.

## T106
**agent-core 0.7.72 — service errors log a traceback to rig-service.out** (Braden, 2026-10-06). Cause found on his 0.7.71 rig: utility-bill skill install failed silently (skills/ dir mode 0755 → private_directory StorageError), only a drawer log row. Done when: unexpected request errors and startup skill-install failures log a traceback/warning to stderr; tool-failure logs carry type + frames, never the message; client responses unchanged; tests in tests/test_t106_error_logging.py. Brief: worktrees/agent-core-errlog/docs/_swarm/t106-brief.md.

## T107
**Rig skills library** (Braden, 2026-10-06, decision #375). Curate public skills (mattpocock, addyosmani/agent-skills, anthropics/skills, the T72 set #304) into the skills repo `library/`, each rewritten as skill.yaml, pinned (40-hex commit), licensed (MIT/Apache/BSD/CC0/CC-BY), passing validator rules 1–11 and the T61b injection suite; no scripts. Desktop Skills page: "Add from library" with a 3-line card (does / reads / sends). Install is `sites_role: admin` only. Step 1: catalog (≤20) for Braden's pick; then rewrites; then the page.

## T108
**Dev role for the rig** (Braden, 2026-10-06, decision #376). A coworker that can run scripts and build code in a sandbox: no drawer, no connectors, own folder, network off by default. Admin only. Design first, after T102; nothing built before Braden approves the design.

## T107a
**Drawer file read/write tool for skills** (decision #377). Read = data, never instructions; write stays ask-first unless the skill passes the injection suite (AGENTS hard rules). Design first.

## T107b
**Web search tool for skills** (decision #377). Results are untrusted data; reuses T92 rag web fetch where possible. Design first.

## T107c
**Task list tool for skills** (decision #377). Likely Microsoft To Do via T90/T104 reads; writes ask-first. Design first.

## T107d
**Ask-the-person step for skills** (decision #377). A skill step that pauses and asks the person a question in chat; answer = data. Design first.

## T109
**Rig agent follows a skill run through to the end and narrates it** (Braden typed 2026-10-07).
Problem: after run_skill returned "started", the chat turn ended; the agent said it had not seen a result and stopped; the person got no updates.
1. The agent keeps going until the skill finishes, hits an approval card, or is blocked. It never ends a turn at "started".
2. A short plain-words update at each step, e.g. "Opening the TurboTenant page", "Waiting for you to sign in", "Filling in Amount", "Ready for you to review, nothing sent".
3. After an Allow card or sign-in Done, it resumes by itself. No resending the message.
4. If it stalls or fails, it says in one line what it is waiting on or what went wrong.
5. Same gates as before: never types credentials; submit/send/pay always ask.
6. (Braden, run 9fb7b8ec) A failed skill step reaches the chat in plain words with the right button, e.g. "TurboTenant showed a sign-in page, so I stopped" + Sign in. The failure's fixed message and the page kind (sign-in / lease page / other) are logged with the run, so a failure can be read afterwards; today only error_class is logged and the step screenshot is not kept.
7. (Braden 2026-10-07) When a skill step fails, save a scrubbed screenshot of the page into the person's drawer and log the fixed failure message with the run. No tokens or lease URLs in either (screenshot: page area only, no address bar; text through the remote scrubber; any URL in the image region masked).
Design first, then build. **Done-when:** design approved by Braden → build PRs (needs Braden: touches ask-first resume path) merged → proof: a recorded bill run with the updates shown.

## T110
**Rig UI upgrade program — research first, no build yet** (Braden typed 2026-10-07).
1. Survey 10-15 open-source and public AI desktop/chat UIs (openhuman first). Screenshots + one-page note each in coordination/references/ui/: layout, navigation, motion, what feels good.
2. Licence rule: ideas and layouts only. No code from GPL/AGPL. MIT/Apache/BSD code needs a credit line and Braden's yes. Reverse-engineering only to study behaviour. One seat writes the spec, a different seat builds from it.
3. Output: board of the best 12 ideas, then 3 whole-rig design directions as mockups (screenshot each, #293). Braden picks one.
4. Build in slices after T102. Do not touch T104/T97 layouts until Braden picks.
**Done-when (research phase):** 10-15 notes + screenshots in coordination/references/ui/, 12-idea board, 3 direction mockups shown to Braden → his pick.

## T93e
**Opener fix for utility-bill-draft** (Braden typed 2026-10-07; run 9fb7b8ec failed "opener not recognized"). Real page: lease Summary has a "Get set up" card with a button labeled CREATE CHARGE (all caps, row "Create a Charge"); the card disappears after Dismiss or when setup is done.
1. Match the opener case-insensitively, by role=button and accessible name "create charge".
2. Fallback: if absent on Summary, open the PAYMENTS tab and look for the same button there. If still absent, stop and say so in chat. Never guess a click.
3. Test with a fixture of both layouts. Failure line goes to chat per T109 item 6.
Ships in the next agent-core bump (hotfix, ahead of T89), then Braden reruns the bill. **Needs Braden** (bill skill click path).

## T111
**Oasis vault connector — names and metadata only** (Braden typed 2026-10-07). Design first, then build; **needs Braden**; never DeepSeek (#227).
Vault: OpenBao at https://vault.cluer.internal:8200. Per-person login; token in the keychain, never in a file, log or prompt.
1. Code allowlist: only kv/metadata/* (list, read) and sys/health. Any other path is refused in code. The result type has no value field.
2. Policy per person comes from vault (<project>-meta); the connector adds no permissions of its own.
3. Tests with a canary secret stored in the vault: the canary must never reach the RAG index, any log row, the scrubber input, or any model prompt or context. Wrong-project names must be invisible.
4. Ingest refuses vault output unless it is names/metadata.
5. (Braden 2026-10-07, CA) TLS verification always ON, never disabled. The vault uses a private CA: the connector trusts it explicitly via a pinned public CA certificate (PEM, not secret) set in Cluer's config, used for the vault connection ONLY — never added to system-wide trust. Fails closed if the file is missing or does not match. Tests: wrong CA = connection refused; no CA configured = connector disabled, not insecure.
**Proof:** canary test plus a mutant for each allowlist check.

## T112
**Bill-run bugs on 0.7.74** (Braden typed 2026-10-08). One task, ahead of T109's PRs; **needs Braden** (sign-in + ask-first gate); hold for his "merge N". Screenshots and steps at each stop.
1. **Sign-in window LOG IN stays greyed out** (TurboTenant Landlord Login): after typing email and password by hand, LOG IN stays disabled and Enter does nothing. A worker finds the cause first: does the sign-in window block input events (so the page never sees the typing), or does the login check keep it disabled? **Report the cause and fix options to Braden before any change to how sign-in works.** Do not move sign-in to the person's normal Chrome (not approved).
2. **"Run utility-bill-draft with: ..." in a new chat** replies "Nothing was sent. Actions only run after you press Yes on a preview card." and never starts the skill; no Yes card. **Braden 2026-10-08:** the same message FAILS in a NEW chat ("Nothing was sent") but STARTS the skill in the existing Utility Bill Draft chat; compare what a new thread lacks (skill/tool binding, coworker/profile, thread context) vs the existing one. Find why, then fix so the message starts the skill and the Yes card appears; the gate stays unchanged (ask-first in skill.yaml decides).
**Proof:** a failing-then-passing test per bug, mutants on any gate touched, screenshots of the fixed window and the Yes card. PR body has Changed / Could break / Proof lines.

## T113
**Login helper** (Braden typed 2026-10-08, do today; **needs Braden**; never DeepSeek #227). An agent signs in to a site with a saved login without ever seeing the username or password.
1. Flow: agent calls `sign_in(site)` → Rig shows an approval card "Sign in to <site>? Yes/No" → on Yes, the Rig itself (never the agent) reads `kv/logins/<site>/main` from the vault and types username + password into the page with real key presses (not paste, not autofill; also covers T112 bug 1). The agent gets only "signed in" or "failed" plus a screenshot taken with password fields hidden.
2. Values never in prompts, logs, transcripts, screenshots, errors or crash reports; run the scrubber over them.
3. Only entries with both a username and a password work; raw-text-only entries are never handed out.
4. Approval every time, 10 min timeout, one audit line (site, time, yes/no, no values). No TOTP yet.
5. Vault side (Braden's assistant builds it): read-only login `logins-broker` on `kv/data/logins/*` only. Rig reads `BAO_ADDR=https://vault.cluer.internal:8200`, `BAO_CACERT=~/vault-ca.crt`, broker credentials from macOS Keychain service `oasis-logins-broker`. Code against those names.
6. (Braden 2026-10-08, vault side done) Keychain service `oasis-logins-broker`, accounts `role_id` and `secret_id`. Auth: AppRole, role `logins-broker`, at BAO_ADDR with BAO_CACERT=~/vault-ca.crt. Token lasts 15 min, bound to this Mac. Denied on purpose (never try to read): `recovery-pin`, `password-for-the-encrypted-*`, `unnamed-*`, `swarm-skill-*` → code refuses these names before any vault call (defense in depth).
7. (Braden 2026-10-08) Vault key = host name: kv/logins/<host>/main. Fallback on not-found: kv/logins/_aliases/main, field = host, value = vault key (no secrets). Miss shows "no saved login for <host>", never a path or error text. Ship today; screenshots hide only username + password fields; one generic success rule.
**Done when:** a test with a fake local login page and a fake vault shows the canary password never appears in any log, prompt, transcript or screenshot, and a failed login shows the failure. One PR, Changed / Could break / Proof lines, held for his "merge N".

## T114
**Watch-it-work browser** (Braden typed 2026-10-08; **needs Braden**; queued after T113; #227 applies: no DeepSeek on anything from the page when sign-in or secrets are involved). The OASIS/RAG agent works in a browser while Braden watches and can work next to it.
1. Visible cursor that moves and clicks as the agent acts + a coloured glow around the page while the agent works.
2. Chat panel docked beside the page with live steps ("Using browser, 1m 13s, +4 steps"), expandable.
3. "Stop" always visible; halts the agent at once.
4. Question cards in the panel: multiple choice + "Other" + "Skip".
5. Take-over any time: Braden clicks or types in the page → agent pauses; resumes on request.
6. Agent works in its own tab group; never touches other tabs.
7. Stops and asks at: sign-in (T113 helper), "verify you are human", payments, sending, deleting. Every irreversible click shows a Yes/No card first.
8. Never shows passwords: password fields hidden in screenshots and in the step list.
9. **A confirmed by Braden 2026-10-08: Rig's own browser window** (builds on the T112/T113 sign-in window) first; B) his real Chrome via extension later. Ideas only from other products; never copy Claude in Chrome's code or art. MIT/Apache/BSD code may be reused with credit (CREDITS.md); GPL/AGPL ideas only.
10. (Braden) Panel layout: screenshots, one per variation; he picks. Layouts unfreeze after his T110 A/B/C answer.
**Done when:** a recorded run on a fake local site shows cursor, glow, panel, Stop, a question card and take-over all working. One PR, Changed / Could break / Proof lines, held for "merge N".

## T115 — Tasks for Amber: list, sub-steps, capture, calendar, mail tracking (desktop-app + agent-core) — Braden typed 2026-10-08, needs Braden

**What (Braden):** Amber's first request. Extends T104's Tasks page (one place for tasks, not a new screen) plus agent tools so she can say "add this to my list" in chat. Her data stays on her own machine/account (drawer, never git).
- **Phase 1 (build first):** add a task by typing or voice. Fields: title, company, priority (+ optional reminder), optional entry date, completion date set automatically, notes. Sub-steps, each markable complete. Sort/filter by company, priority, date. Color coded by priority and company, clean. Per-task "where I left off" log (e.g. "sent email 8/7, waiting for reply").
- **Phase 2, capture:** paste text, paste/drop a screenshot, or a photo of handwritten sticky notes → agent reads it → preview card with the task found → her Yes before it is added.
- **Phase 3, calendar:** add a task to her calendar or schedule an item from a task via her calendar connector; one Yes per event.
- **Phase 4, email tracking:** link a task to a mail thread; notify her when a reply arrives. Read-only mail; never sends without a Yes card.
- **Phase 5, chat apps (WhatsApp, Messenger, texts):** report only — what terms of service and connector options allow. No build until Braden decides.
**Rules (Braden):** keep #373: ticking stays on her machine; To Do items move a step only via an explicit link. If any phase would break #373, stop and ask. Never DeepSeek on her messages, emails or photos (#227). Nothing sends or books without a Yes. Scrubber covers anything pulled from messages. Ideas only from GPL/AGPL apps; MIT/Apache/BSD code borrowable with a CREDITS line. Text she pastes, photos, mail and titles are untrusted data (never system text, #73).
**First:** one-page design + Phase 1 screenshots of 2–3 layouts (#293), shown as a proposal (layouts frozen until T110 is answered). Then Phase 1 as one needs-Braden PR held for "merge N".
**Done when (Phase 1):** PR(s) merged on Braden's line with tests; on his Mac: add a task by typing and by voice, add/tick sub-steps, sort/filter, colors, left-off log; data in her drawer only.
**T115 scope change (Braden typed 2026-10-08):** main Tasks view = "Task Map" in Archify's architecture-diagram style (MIT; code may be reused with its notice in THIRD_PARTY_NOTICES): tasks as boxes coloured by priority/status, company subtitle, sub-steps as small connected boxes, companies as regions, arrows then / waiting on reply / blocked by, focus + upstream/downstream trace, search, light/dark, side cards Due today / Waiting on others / Overdue, left-off badge; built by code only, automatic layout. List view (layout C) stays as a toggle. Task-to-task links (waiting on, blocked by) in scope. 2 screenshots before build.

## Hardening and RAG tickets (Braden typed 2026-10-12: "File the proposed tickets"; do not start building yet)

Sources: agent-core docs/rig-hardening-checklist.md (agent-core#121) and rag-pipeline docs/rag-techniques-shortlist.md (rag-pipeline#4), both written in our own words (clean room for the two non-commercial references). **Status for all: filed, not started. Starting any of them needs Braden's typed go.**

## T116 — Injection and secret-leak test suites (agent-core + desktop-app) — priority: HIGH
**What:** one rig-wide injection matrix plus one secret-leak corpus. Hostile text goes through every input path: chat, attachments, browser pages, connector fields, profile data and model tool calls. A red-team set of fake secrets is checked against every sink: log, audit, event, model error, repr, URL and desktop response.
**Rules:** tool results are data, never instructions. Ask-first stays in skill.yaml (risky_steps / always_ask). Fake fixtures only (sk-FAKE-0000 style). No DeepSeek (#227).
**Done when:** hostile text through each listed path causes zero gate or plan changes, and no fake secret reaches any listed sink. Both suites run in CI and fail a release on any bypass; each guard is mutation-checked.

## T117 — Verified model identity per run (agent-core) — priority: HIGH
**What:** link each finished run to the model each call actually used, not the configured alias.
**Done when:** finished run records link to settled per-call model identities, or clearly say "identity unknown"; configuration is never treated as proof; the audit log carries it. Covered by tests (#287 verification rule still applies to route changes).

## T118 — Retention and model-view policy (agent-core) — priority: HIGH
**What:** (a) a model-view inventory: for each model call, the allowed fields, their sensitivity and a byte/token cap. (b) A drawer retention policy: a retention period per store, an authenticated delete/purge path where needed, and an audit record that keeps no deleted content.
**Rules:** profile stays in system text; untrusted text travels as its own messages (#73). Retention periods are Braden's decision before code.
**Done when:** every model call has a written allow-list and cap, with a test proving another thread or a secret field is not read. Every store has an owner-approved retention period with tested purge and audit.

## T119 — Durable job resume (agent-core) — priority: HIGH
**What:** an interrupted multi-step run keeps durable state and either resumes safely or offers an explicit human replay.
**Done when:** a killed or crashed run resumes or replays with no duplicate external change (send, write, charge), ask-first still pauses on resume, and a Yes given before the crash is never reused without the existing token rules. Tests use fakes; the gate is mutation-checked.

## T120 — On-prem model attestation (agent-core) — priority: HIGH
**What:** at startup, prove the approved local model endpoint and the no-cloud setting (e.g. OLLAMA_NO_CLOUD=1), and record the model identity and version.
**Done when:** startup verifies endpoint and no-cloud, records identity and version, and refuses sensitive work when either can't be verified, with a plain message to the person. Tests cover pass, fail and missing setting. No rig-service restart by the orchestrator (#126).

## T121 — Hybrid local retrieval with rank fusion (rag-pipeline) — priority: LATER
**Done when:** with role-filtered fake fixtures, fused keyword+vector results are stable and carry source ids; drawer isolation holds; every retrieval logs. Our own code; no LangChain or LlamaIndex.

## T122 — Candidate reranking (rag-pipeline) — priority: LATER
**Done when:** a bounded reranker improves the ranked fake set without bypassing access checks or logging private text. Local-first; no data leaves the machine unless the model route allows it.

## T123 — Contextual chunk headers (rag-pipeline) — priority: LATER
**Done when:** derived chunks carry a context header and keep exact parent spans and versions; private text stays local; retrieval quality is measured on fake fixtures before and after.

## T124 — Trim the Mac app size (desktop-app, agent-core) — priority: LATER
**Done when:** OASIS.app with the bundled runtime (536 MB at desktop-app #98, agent-core 0.7.83) is measured per package, and a held PR cuts it without dropping a feature: e.g. Playwright's browser fetched on first use or shared rather than bundled (132 MB), PyMuPDF (104 MB) and onnxruntime (75 MB) checked for slimmer wheels or lazy install, and caches, tests and `__pycache__` stripped from the runtime. The bundled-python import check (`anorak`, `gates`, the catalog) still passes, and the size before and after is in the PR body. Filed by Braden 2026-10-12.

## T125 — Mac local model route can't reach dev2's model, and expects the old model name (agent-core) — priority: MEDIUM
**What:** the T99 local route (`anorak/models/local_route.py`, `docs/models.md`) has two problems. (1) It points at `http://10.10.10.220:8000/v1`, but dev2's model server listens on `127.0.0.1:8000` (loopback only, one python process), so the Mac's "Local (dev2)" route can't reach it without a tunnel. (2) It expects model id `llama-moe3`, and `wire.py`'s identity check also expects `llama-moe3`; that model no longer exists. dev2's `/v1/models` now lists only `qwen3.8-flash-next-iq2_xs` (loaded, context 393216), so even a reachable route would reject every answer (found 2026-10-13). **Done when:** the route reaches the model the documented way (an SSH tunnel on the Mac, or a deliberate LAN listener on dev2; Braden decides which), the route, `wire.py`'s identity check and the docs use `qwen3.8-flash-next-iq2_xs` (ideally from one setting, not hardcoded), and a check (route health shows online, a completion is tagged with the new id, and a test pins both the URL and the id) proves it. #357 still applies. Filed by Braden 2026-10-13; model-name half added 2026-10-13.


## T126 — Windows update: stop the app's own service before the installer (desktop-app) — priority: HIGH, blocks the first Windows release
**What:** on Windows, an approved update runs the NSIS installer while the app's bundled Python `rig-service` is still running, so the installer can meet locked runtime files and the old service keeps running next to the new app. Mac updater PR 4 (desktop-app#103) added verify → stop own service → install → restart, but Braden limited it to macOS (`update_flow::stops_service_before_install`). Extend it to Windows: stop only the service the app started, wait for its port with a time limit, refuse the install and restart the service if it won't stop, then run NSIS (which exits the app and relaunches the new one).
**Done when:** `stops_service_before_install("windows")` is true with tests for the same order and recovery as the Mac, and the Windows installer CI job (or a dispatch run) shows an update installs over a running app without a leftover service process. Must merge before the first Windows release is published. Filed by Braden 2026-10-13.
