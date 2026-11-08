# Prompt — T01 Repo template and CI (playbooks)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T01 — Repo template and CI (playbooks)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `playbooks`, then applied to all nine.
**Build:** A template folder with `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/`, `src/`, `tests/`, `.gitignore`, `.github/workflows/ci.yml`. Python repos get `pyproject.toml` (uv, pytest, ruff, mypy). `desktop-app` gets `package.json` + Tauri scaffold. CI runs tests, lint and types on every PR.
**Done when:** All nine repos exist under `Btabor11`, private, CI green on an empty test.

Finish with the done report from `AGENTS.md`.
