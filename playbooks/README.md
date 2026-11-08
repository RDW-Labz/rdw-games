# playbooks — Garage

Playbooks, plan, decisions, agent-template, onboarding script.

Part of OASIS, built for Cluer Holdings. Private repo under `Btabor11`.

## Layout

Every OASIS repo has the same shape:

```
README.md                    this file
AGENTS.md                    rules for coding agents in this repo
AGENTS.workspace.md          full root rules, copied in by the coordinator
CHANGELOG.md                 one entry per ticket
docs/                        repo docs
src/                         source
tests/                       tests
.github/workflows/ci.yml     tests, lint and types on every PR
```

## Checks

Run all of these locally before you open a PR, and paste the output in the PR.

```
uv sync --locked
uv run --no-sync pytest -q
uv run --no-sync ruff check .
uv run --no-sync mypy --strict src
```

## Ventures

`ventures.yaml` at the repo root is the single source of truth mapping each
venture's short code to its full name (decision #61); `profile.yaml`'s
`ventures[]` stores only the codes, resolved through `garage.ventures`.

## Status

T01 provides build scaffolding and smoke checks. Product behavior belongs to later tickets.
The reusable template and its developer guide live in
[playbooks](https://github.com/RDW-Labz/playbooks/blob/main/docs/REPO-TEMPLATE.md).
The plan and tickets are in that repo's `docs/` directory.
