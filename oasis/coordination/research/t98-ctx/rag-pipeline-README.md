# rag-pipeline — Journals

Drawers, ingest, retrieval (Curator), role gate, model and tool routers, network graph store.

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

## Fetching a web page (read-only)

```python
page = await fetch_page(
    "ann", "https://example.test/report", reason="check the quarterly report",
    tool=tool, log=log, never_automate_hosts=["bank.example"],
)
```

Only `open`, `read` and `screenshot` are used; any other action is refused in code. A `never_automate_hosts` host is refused before opening. Page text is labelled as untrusted and passed on as its own message, never mixed into instructions. Every fetch writes one log row. The `agent-core==0.7.60` pin needs T91 merged before it can be installed.

## Status

T01 provides build scaffolding and smoke checks. Product behavior belongs to later tickets.
The reusable template and its developer guide live in
[playbooks](https://github.com/Btabor11/playbooks/blob/main/docs/REPO-TEMPLATE.md).
The plan and tickets are in that repo's `docs/` directory.
