# T13 → Rig scope: closing the done-when on Braden's Mac

T13 done-when (TICKETS.md:113): "Braden runs it as user zero in the Rig;
his `profile.yaml` reads true to him; a second run skips answered
questions and asks only the gaps." T13 merged in `playbooks`; this line is
not met because nothing outside `playbooks` calls it yet.

## What already exists

- `playbooks/onboarding/v1/skill.yaml` — shared skill, 4 steps, `write_profile` gated `risky_steps` (repos/playbooks/onboarding/v1/skill.yaml:7-17)
- `OnboardingSession.pending_question_ids` / `gap_question_ids` — gap-only second-run logic (repos/playbooks/src/garage/onboarding/session.py:42-57,78-80)
- `writer.write_answers` — validated, atomic write through `ProfileStore`, `access_level` never taken from answers (repos/playbooks/src/garage/onboarding/writer.py:79-91)
- `watch.py` `WatchAnswers` — Yes/No mirrored into `profile.yaml.watch_answers`, Not-now never saved (repos/playbooks/src/garage/onboarding/watch.py:53-141)
- `steps.py` — 4 `Tool` factories closing over Rig-supplied answers, ready to register by `skill.yaml`'s `do` names (repos/playbooks/src/garage/onboarding/steps.py:22-79)
- `playbooks` pins `agent-core==0.4.0` as a vendored wheel — dependency direction is playbooks → agent-core, not the reverse (repos/playbooks/pyproject.toml:7-11)
- `rig-service` (T12b) is a real, running loopback HTTP/WS service; its route table has no onboarding endpoint (worktrees/agent-core-guide-verify/src/anorak/local_service.py:308-323)
- T16's precedent for wiring an installed skill's `do` names into the real `LoopRunner`: `build_tools()`/`build_checkers()` built only for `daily-summary`, with a documented "garage.graph_read not importable → fall back to empty registry" pattern (worktrees/agent-core-guide-verify/src/anorak/service_cli.py:254-268)
- Connectors ("gates") already reach `agent-core` as a vendored, hash-pinned wheel loaded lazily via `importlib`, specifically to avoid a dependency cycle (docs/DECISIONS.md:68, decision #50) — the only existing precedent for a second package reaching into `agent-core` this way
- `desktop-app`'s `App.tsx` has exactly three tabs — chat, connect, activity — no onboarding screen (repos/desktop-app/src/App.tsx:12,120-138)
- `docs/mac-quickstart.md` step 4 has Braden hand-writing `profile.yaml`, and says plainly "Onboarding screen (write profile.yaml by hand, step 4)" is not built (repos/desktop-app/docs/mac-quickstart.md:76-98,180)

## What is missing to meet T13's done-when on Braden's Mac

1. No Rig UI: no screen shows the 4 intro texts, asks `pending_question_ids()`, or shows the watch-page prompt.
2. No `agent-core` endpoint: `local-api.md` and `local_service.py` have nothing for onboarding; a chat/skill-run round trip can't carry structured question ids and answers.
3. No tool/checker registration: `onboarding-v1`'s `do` names are not in any `LoopRunner`'s registry (only `daily-summary` is registered), so `POST /skills/onboarding-v1/run` would 404 or run against an empty tool map today.
4. Unresolved import direction: `playbooks` depends on `agent-core` (vendored wheel); nothing wires `garage.onboarding` back into `agent-core` without either a cycle or the lazy-import pattern connectors already uses.
5. No live acceptance run: `playbooks/docs/onboarding.md:182-184` says explicitly this is "covered by tests, not by a live Rig run."
6. Second-run gap logic is fixture-tested only (`fixtures/second-run.yaml`) — never exercised against Braden's real `profile.yaml` through any UI.

## Build plan (PRs per repo)

**`playbooks`** — no code PR planned. `garage.onboarding` already exposes both the plain-Python API and the `Tool` factories `docs/onboarding.md:133-166` describes; ship its wheel to `agent-core`'s `vendor/` the same way `agent-core==0.4.0` is vendored into `playbooks` today (repos/playbooks/pyproject.toml:9-11), mirroring connectors' `vendor/runtime-requirements.txt` hash-pinned install (repos/desktop-app/docs/mac-quickstart.md:41-42).

**`agent-core` PR A — onboarding runtime bridge.** Add a `garage`-loading adapter next to `GatesConnectorAdapter.from_installed` (worktrees/agent-core-guide-verify/src/anorak/local_service_adapters.py:275-294), lazily `importlib.import_module("garage.onboarding...")` so `local_service.py` still has zero import-time dependency on `playbooks`. Register `onboarding-v1`'s 4 `do` names into `build_tools()`/`build_checkers()` (anorak/skill_tools.py, same seam T16 used for `daily-summary`), falling back to the empty registry with one fixed log line when `garage` is not installed, exactly like the `gates.graph_read` fallback (worktrees/agent-core-guide-verify/src/anorak/service_cli.py:254-268).

**`agent-core` PR B — onboarding endpoints.** New loopback routes on `LocalService` (mirroring the `/connectors/*` shape): `GET /onboarding/screens`, `GET /onboarding/questions` (pending only), `POST /onboarding/answer`, `POST /onboarding/finish` (the risky, ask-first-gated write), `POST /onboarding/watch-page`. `write_profile`'s `risky_steps` gate (repos/playbooks/onboarding/v1/skill.yaml:17) must run through the real `LoopRunner`, same as `LoopModelChatAdapter` runs chat turns through it today (worktrees/agent-core-guide-verify/src/anorak/local_service_adapters.py:206-226).

**`desktop-app` PR — onboarding screen.** A new tab/flow shown before Chat/Connect/Activity when `profile.yaml` has gaps, driving PR B's endpoints; write the new contract into `docs/local-api.md` first, matching how `local-api.md` already governs every existing endpoint (repos/desktop-app/docs/local-api.md:77-93).

## Decisions for Braden

1. **Dependency direction (agent-core ↔ playbooks).** `AGENTS.md:32` fixes pin-by-version but not which repo imports which for onboarding. Options: (a) mirror the `gates` lazy-import pattern (decision #50, docs/DECISIONS.md:68) — `agent-core` lazily loads a vendored `garage` wheel; (b) move onboarding's runtime pieces into `agent-core` itself, leaving only the YAML content in `playbooks`; (c) run onboarding as a separate local process `desktop-app` calls directly, bypassing `agent-core`. **Recommend (a)** — it is the only pattern already proven in this codebase and keeps `playbooks` as the source of truth for the question set.
2. **Endpoint shape.** TICKETS.md:112 says onboarding is "delivered as a skill" but is silent on how a multi-turn conversation crosses the local API. Options: (a) dedicated `/onboarding/*` REST endpoints as sketched above; (b) drive it over the existing `WS /chat` channel with a special message type. **Recommend (a)** — `/chat`'s WS payload is a strict `{type, text}` shape with no room for question ids (worktrees/agent-core-guide-verify/src/anorak/local_service.py:628-637), and REST matches the existing `/connectors/*` start/status pattern.
3. **Where onboarding runs.** `docs/onboarding.md:133-166` (repos/playbooks) already supports both a plain synchronous call and `LoopRunner`-driven `Tool`s, and TICKETS.md is silent on which Phase-0 endpoints must use the loop. Options: (a) every step through `LoopRunner`; (b) only `write_profile` through `LoopRunner` (for its ask-first gate and log line), the 3 read-only steps called directly. **Recommend (b)** — matches how `/connectors/*` already splits a fast direct call from a background/gated one (worktrees/agent-core-guide-verify/src/anorak/local_service_adapters.py:401-433).
4. **Skill delivery mechanics.** PLAN.md is silent on whether a one-time, non-recurring skill like onboarding belongs in the T15 clock's scheduled-skill directory. Options: (a) install it as a normal clock-scheduled skill; (b) give it its own entry point outside the clock, like `POST /skills/:name/run` already does for `daily-summary` (decision #52, docs/DECISIONS.md). **Recommend (b)** — onboarding is not periodic, and `ScheduledSkillRunner` (worktrees/agent-core-guide-verify/src/anorak/service_cli.py:127-176) is already the precedent for a one-off, ask-first-respecting run outside the clock.
