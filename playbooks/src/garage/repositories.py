"""The nine T01 repository identities; no employee data or runtime config."""

REPOSITORIES: dict[str, dict[str, str]] = {
    "agent-amber": {
        "codename": "Art3mis",
        "description": "Amber's agent: role file, config, skill list, "
        "private-drawer macros. Made from "
        "playbooks/agent-template.",
        "module": "art3mis",
        "repo_rules": "- This repo is an instance of "
        "`playbooks/agent-template`. Change the template, not "
        "this copy, for anything that should reach every agent.\n"
        "- Pins `agent-core`, `skills`, `connectors` by version "
        "in `agent.yaml`.",
    },
    "agent-core": {
        "codename": "Anorak",
        "description": "Agent shell: loop runner, memory, model switch, secrets "
        "interface, Scoreboard skill, network events.",
        "module": "anorak",
        "repo_rules": "- The loop runner is the only way a skill runs. No "
        "shortcuts around plan → act → check → fix → log.\n"
        "- The checker is never the same model grading its own "
        "output.\n"
        "- `secrets.py` never returns a value into a log, "
        "exception message or repr.\n"
        "- Every skill run, connector use and drawer read emits "
        "network events to `events.jsonl` (shape: PLAN.md → "
        "Network data model).",
    },
    "agent-michael": {
        "codename": "Parzival",
        "description": "Michael's agent. Same shape as agent-amber.",
        "module": "parzival",
        "repo_rules": "- This repo is an instance of "
        "`playbooks/agent-template`. Change the template, not "
        "this copy, for anything that should reach every "
        "agent.\n"
        "- Pins `agent-core`, `skills`, `connectors` by version "
        "in `agent.yaml`.",
    },
    "connectors": {
        "codename": "Gates",
        "description": "One-click connector catalog, app registrations, connect flows.",
        "module": "gates",
        "repo_rules": "- Client IDs and tokens go through the `secrets` "
        "interface from `agent-core`. Never in this repo.\n"
        "- Every connect flow emits plain-words step text and "
        "plain-words errors. No error codes reach a person.\n"
        "- One `connector.yaml` per connector in `catalog/`.",
    },
    "desktop-app": {
        "codename": "Rig",
        "description": "Tauri 2 app: installer, orb, side panel, full app, browser extension.",
        "module": "",
        "repo_rules": "- Tauri 2 + TypeScript/React. The UI talks only to the "
        "local `agent-core` service API.\n"
        "- Windows first; keep Mac building from day one.\n"
        "- The orb defaults to quiet. Glow only when there is a "
        "proposal or a needed yes.\n"
        "- No settings screen that asks for a key, a URL or a "
        "port. Ever.",
    },
    "playbooks": {
        "codename": "Garage",
        "description": "Playbooks, plan, decisions, agent-template, onboarding script.",
        "module": "garage",
        "repo_rules": "- `docs/PLAN.md` is the source of truth for the whole "
        "build.\n"
        "- `docs/DECISIONS.md` is append-only.\n"
        "- `agent-template/` is what every `agent-<person>` repo is "
        "made from.",
    },
    "rag-pipeline": {
        "codename": "Journals",
        "description": "Drawers, ingest, retrieval (Curator), role gate, model "
        "and tool routers, network graph store.",
        "module": "journals",
        "repo_rules": "- Phase 3 repo. Do not build here before Phase 3 unless "
        "a ticket says so.\n"
        "- Role gate filters before retrieval, never after.\n"
        "- Every answer carries its sources.",
    },
    "remote": {
        "codename": "Zemeckis",
        "description": "The watcher: local proxy, scrubber, macro format, replay, "
        "editor, MCP server.",
        "module": "remote",
        "repo_rules": "- Nothing writes a trace to disk except through "
        "`scrubber.py`.\n"
        "- `tests/fixtures/traces/` holds 200 synthetic traces with "
        "planted fake secrets. `test_no_leaks.py` must pass on every "
        "PR.\n"
        "- Fake secrets in fixtures look like `sk-FAKE-0000…`. Never "
        "use a real-looking key, even a revoked one.\n"
        "- Fail toward hiding: if a value cannot be proven safe, mask "
        "it.",
    },
    "skills": {
        "codename": "Almanac",
        "description": "Shared and personal skills, the three formats, test runner.",
        "module": "almanac",
        "repo_rules": "- A skill without `test_cases` is refused by the runner. No "
        "exceptions.\n"
        "- `docs/formats.md` is the single definition of "
        "`profile.yaml`, `skill.yaml`, `connector.yaml`. Change it "
        "only with a decision in `playbooks/docs/DECISIONS.md`.\n"
        "- `shared/` skills may be installed on any agent whose role "
        "matches. `personal/<person>/` skills are never pushed to "
        "anyone else.",
    },
}
