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
51:- **Splash / opening screen idea (Braden, 2026-09-25, later):** on app open, the gold-rim visor logo (T30) opens and zooms into the world reflected in the visor, "Welcome to the OASIS", cinematic and seamless, Higgsfield for the world footage, several review rounds, no AI slop. Suggested plan (not approved): logo motion and text built as real vector animation in the app; Higgsfield only for the world inside the visor; storyboard stills first; ≤3 s, cold start only, skippable, covers service start-up; reduce-motion gets a still fade. Draft a ticket (T31) when Braden says go.
