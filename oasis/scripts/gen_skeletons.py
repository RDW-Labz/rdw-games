#!/usr/bin/env python3
"""Generate the nine repo skeletons under repos/ and the Codex prompts under prompts/.
Safe to re-run: it never overwrites a file that already exists."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
REPOS = {
    "remote":       ("Zemeckis", "The watcher: local proxy, scrubber, macro format, replay, editor, MCP server.", "py"),
    "agent-core":   ("Anorak",   "Agent shell: loop runner, memory, model switch, secrets interface, Scoreboard skill, network events.", "py"),
    "skills":       ("Almanac",  "Shared and personal skills, the three formats, test runner.", "py"),
    "connectors":   ("Gates",    "One-click connector catalog, app registrations, connect flows.", "py"),
    "agent-amber":  ("Art3mis",  "Amber's agent: role file, config, skill list, personal macros. Made from playbooks/agent-template.", "py"),
    "agent-michael":("Parzival", "Michael's agent. Same shape as agent-amber.", "py"),
    "rag-pipeline": ("Journals", "Drawers, ingest, retrieval (Curator), role gate, model and tool routers, network graph store.", "py"),
    "desktop-app":  ("Rig",      "Tauri 2 app: installer, orb, side panel, full app, browser extension.", "ts"),
    "playbooks":    ("Garage",   "Playbooks, plan, decisions, agent-template, onboarding script.", "py"),
}

CI_PY = """name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --all-extras
      - run: uv run ruff check .
      - run: uv run mypy src
      - run: uv run pytest -q
"""
CI_TS = """name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run lint
      - run: npm test
"""
GITIGNORE = """.env
*.env
.venv/
__pycache__/
node_modules/
dist/
target/
*.log
*.jsonl
macros/*.remote
drawer/
"""

def pyproject(name):
    mod = {"remote":"remote","agent-core":"anorak","skills":"almanac","connectors":"gates",
           "rag-pipeline":"journals","playbooks":"garage","agent-amber":"art3mis","agent-michael":"parzival"}[name]
    return f"""[project]
name = "{name}"
version = "0.1.0"
description = "OASIS — {REPOS[name][0]}"
requires-python = ">=3.12"
dependencies = ["pyyaml>=6", "pydantic>=2"]

[project.optional-dependencies]
dev = ["pytest>=8", "ruff>=0.6", "mypy>=1.11"]

[tool.ruff]
line-length = 100
[tool.mypy]
strict = true
[tool.pytest.ini_options]
testpaths = ["tests"]
"""

def readme(name, code, desc):
    return f"""# {name} — {code}

{desc}

Part of **OASIS** (Cluer Holdings). The plan lives in the `playbooks` repo (`docs/PLAN.md`). Tickets for this repo are in `playbooks/docs/TICKETS.md`.

## Layout

```
README.md      this file
AGENTS.md      rules for coding agents in this repo
CHANGELOG.md   one line per change, newest first
docs/          design notes for this repo only
src/           code
tests/         tests; nothing merges without them
```

## Versioning

Semantic versions, tagged. Other repos pin this repo by tag, never by branch.

## Status

Skeleton. No code yet.
"""

def agents_md(name, code):
    extra = {
        "remote": "\n## Repo-specific\n\n- Nothing writes a trace to disk except through `scrubber.py`.\n- `tests/fixtures/traces/` holds 200 synthetic traces with planted fake secrets. `test_no_leaks.py` must pass on every PR.\n- Fake secrets in fixtures look like `sk-FAKE-0000…`. Never use a real-looking key, even a revoked one.\n- Fail toward hiding: if a value cannot be proven safe, mask it.\n",
        "agent-core": "\n## Repo-specific\n\n- The loop runner is the only way a skill runs. No shortcuts around plan → act → check → fix → log.\n- The checker is never the same model grading its own output.\n- `secrets.py` never returns a value into a log, exception message or repr.\n- Every skill run, connector use and drawer read emits network events to `events.jsonl` (shape: PLAN.md → Network data model).\n",
        "skills": "\n## Repo-specific\n\n- A skill without `test_cases` is refused by the runner. No exceptions.\n- `docs/formats.md` is the single definition of `profile.yaml`, `skill.yaml`, `connector.yaml`. Change it only with a decision in `playbooks/docs/DECISIONS.md`.\n- `shared/` skills may be installed on any agent whose role matches. `personal/<person>/` skills are never pushed to anyone else.\n",
        "connectors": "\n## Repo-specific\n\n- Client IDs and tokens go through the `secrets` interface from `agent-core`. Never in this repo.\n- Every connect flow emits plain-words step text and plain-words errors. No error codes reach a person.\n- One `connector.yaml` per connector in `catalog/`.\n",
        "desktop-app": "\n## Repo-specific\n\n- Tauri 2 + TypeScript/React. The UI talks only to the local `agent-core` service API.\n- Windows first; keep Mac building from day one.\n- The orb defaults to quiet. Glow only when there is a proposal or a needed yes.\n- No settings screen that asks for a key, a URL or a port. Ever.\n",
        "rag-pipeline": "\n## Repo-specific\n\n- Phase 3 repo. Do not build here before Phase 3 unless a ticket says so.\n- Role gate filters before retrieval, never after.\n- Every answer carries its sources.\n",
        "playbooks": "\n## Repo-specific\n\n- `docs/PLAN.md` is the source of truth for the whole build.\n- `docs/DECISIONS.md` is append-only.\n- `agent-template/` is what every `agent-<person>` repo is made from.\n",
    }.get(name, "\n## Repo-specific\n\n- This repo is an instance of `playbooks/agent-template`. Change the template, not this copy, for anything that should reach every agent.\n- Pins `agent-core`, `skills`, `connectors` by version in `agent.yaml`.\n")
    return f"""# AGENTS.md — {name} ({code})

Read the workspace-level `AGENTS.md` in `playbooks` first; it applies here in full. This file adds only what is specific to this repo.
{extra}
## Done report

```
Ticket: <number and name>
Done-when: <restated> → met / not met
Changed: <files>
Tests: <command> → <result>
Open: <anything Braden must decide>
```
"""

FORMATS = """# The three formats

Fixed in Phase 0. Everything else depends on these. Change only with a decision in `playbooks/docs/DECISIONS.md`.

## profile.yaml — the role file (one per person, lives in their drawer)

```yaml
name: Amber
title: COO, Cluer Holdings
reports_to: Michael
access_level: admin            # member | admin
ventures: [holdings, rdw, bin-there, alpena-trucking, wk-trucking, jmac, gold-run, glory-road, evage]
tools: [outlook, gmail, onedrive, google-drive, teams, quickbooks, square, gusto]
people:
  - {name: Michael, role: owner, how_often: daily}
day:
  - "Mornings: email and Teams triage"
  - "Thursdays: payroll in Gusto"
preferences:
  tone: short and direct
  ask_before: [send email, pay anything, sign anything]
  quiet_hours: "18:00-07:00"
watch_answers:                 # saved answers to "Can I watch this page?"
  quickbooks.intuit.com: yes
  facebook.com: no
```

## skill.yaml — one skill (beside its SKILL.md)

```yaml
name: weekly-numbers-pull
version: 1.3.0
tier: shared                   # shared | personal
goal: Pull this week's sales by location into the ops report
done_when: Report tab "Week" has one row per location and totals match Square within $1
schedule: "0 7 * * MON"        # optional cron
model: default                 # or a named model; Scoreboard may change this
steps:
  - id: fetch
    do: connectors.square.sales(range: this_week)
  - id: write
    do: files.excel.write(path: profile.reports.ops, tab: Week)
  - id: verify
    do: compare(totals, connectors.square.totals)
checker: compare_totals        # a callable, never the model grading itself
risky_steps: []                # step ids that pause for a yes
always_ask: []                 # step ids that never stop asking (pay, sign, delete, send money)
undo: "Restore previous Week tab from the backup made at start"
budget: {max_steps: 20, max_seconds: 300, max_usd: 0.50}
resources:                     # what the scheduler must grant before this runs
  shared: [connector:square, model]
  exclusive: [file:profile.reports.ops]   # or screen, person-attention
test_cases:
  - {fixture: 2026-09-08, expect: {rows: 6, totals_match: true}}
  - {fixture: 2026-09-15, expect: {rows: 6, totals_match: true}}
  - {fixture: 2026-08-25, expect: {rows: 5, totals_match: true}}
```

## connector.yaml — one connector (in connectors/catalog/)

```yaml
name: gmail
provider: google
auth_type: oauth               # oauth | admin_key | own_login
scopes: [gmail.readonly, gmail.compose]
can_do: [read_mail, search_mail, draft_mail]
cannot_do_without_yes: [send_mail]
roles_allowed: [member, admin]
setup_steps:
  - "We'll open Google in your browser."
  - "Click Allow on the screen that opens."
  - "Come back here. We'll test it for you."
errors:
  denied: "Google said no. Try again, or ask Braden."
  expired: "Your Gmail link needs a quick refresh. Click Connect again."
```
"""

AGENT_TEMPLATE_README = """# agent-template

Every `agent-<person>` repo is made from this folder. Change the template for anything that should reach every agent; change the person's repo only for that person.

```
agent.yaml          pins: agent-core, skills, connectors versions; model defaults; schedule of proactive skills
profile.yaml        the person's role file (written by onboarding; the person owns it)
skills.yaml         which shared skills are installed; personal skills listed by path
macros/             the person's buttons (Zemeckis macro files) — gitignored, synced privately
docs/ONBOARDING.md  the onboarding transcript summary, if they chose to keep it
```
"""

PROMPT_KICKOFF = """# Kickoff prompt — paste this to Codex first

You are joining the OASIS build for Cluer Holdings. Before touching any code:

1. Read `AGENTS.md` at the root of this workspace. Those rules apply to everything you do here.
2. Read `docs/PLAN.md` fully. Then `docs/DECISIONS.md`, `docs/TICKETS.md`, `docs/CODENAMES.md`.
3. Reply with, in this order and nothing else:
   - The mission in three sentences, your words.
   - The build order and why agents come before the pipeline.
   - The seven loop rules from "Agent loops", one line each.
   - Every hard rule from `AGENTS.md`, one line each.
   - Anything in the plan you find unclear or contradictory, as questions. If none, say "No questions."
4. Stop and wait. Do not create files, do not run `scripts/create-repos.sh`, do not start T01 until Braden says go.
"""

def ticket_prompt(num, title, body):
    return f"""# Prompt — {num} {title}

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **{num} — {title}** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

{body}

Finish with the done report from `AGENTS.md`.
"""

def main():
    # repos
    for name,(code,desc,kind) in REPOS.items():
        r = ROOT/"repos"/name
        for d in ["docs","src","tests",".github/workflows"]:
            (r/d).mkdir(parents=True, exist_ok=True)
        files = {
            "README.md": readme(name,code,desc),
            "AGENTS.md": agents_md(name,code),
            "CHANGELOG.md": f"# Changelog — {name}\n\nNewest first.\n\n- 0.1.0 — skeleton created\n",
            ".gitignore": GITIGNORE,
            ".github/workflows/ci.yml": CI_PY if kind=="py" else CI_TS,
            "docs/.gitkeep": "", "src/.gitkeep": "", "tests/.gitkeep": "",
        }
        if kind=="py":
            files["pyproject.toml"] = pyproject(name)
            files["tests/test_smoke.py"] = "def test_smoke() -> None:\n    assert True\n"
        else:
            files["package.json"] = '{\n  "name": "oasis-rig",\n  "private": true,\n  "version": "0.1.0",\n  "scripts": { "lint": "echo lint-placeholder", "test": "echo test-placeholder" }\n}\n'
            files["docs/README.md"] = "Tauri 2 scaffold is created in T11 with `npm create tauri-app@latest`. Keep Windows and Mac targets from the first commit.\n"
        if name=="skills":
            files["docs/formats.md"] = FORMATS
            for d in ["shared","personal"]: (r/d).mkdir(exist_ok=True); files[f"{d}/.gitkeep"]=""
        if name=="playbooks":
            (r/"agent-template").mkdir(exist_ok=True)
            files["agent-template/README.md"] = AGENT_TEMPLATE_README
            files["agent-template/agent.yaml"] = "pins:\n  agent-core: 0.1.0\n  skills: 0.1.0\n  connectors: 0.1.0\nmodel:\n  default: openrouter/anthropic/claude-sonnet\n  restricted_data: ollama/llama3\nproactive:\n  morning-brief: \"0 7 * * MON-FRI\"\n  daily-proposals: \"0 16 * * MON-FRI\"\n"
            files["agent-template/skills.yaml"] = "shared: [daily-summary, file-filing, meeting-prep]\npersonal: []\n"
            for f in ["PLAN.md","DECISIONS.md","TICKETS.md","CODENAMES.md"]:
                (r/"docs"/f).write_text((ROOT/"docs"/f).read_text())
            (r/"AGENTS.workspace.md").write_text((ROOT/"AGENTS.md").read_text())
        if name=="connectors":
            (r/"catalog").mkdir(exist_ok=True); files["catalog/.gitkeep"]=""
        for rel,content in files.items():
            p=r/rel
            if not p.exists():
                p.write_text(content)
    # prompts
    pr = ROOT/"prompts"; pr.mkdir(exist_ok=True)
    (pr/"00-kickoff.md").write_text(PROMPT_KICKOFF)
    tickets = (ROOT/"docs/TICKETS.md").read_text()
    parts = re.split(r"\n## (T\d\d) — ", tickets)
    for i in range(1,len(parts),2):
        num = parts[i]; rest = parts[i+1]
        title, _, body = rest.partition("\n")
        body = body.split("\n---")[0].strip()
        slug = re.sub(r"[^a-z0-9]+","-",title.lower()).strip("-")
        (pr/f"{num[1:]}-{slug}.md").write_text(ticket_prompt(num,title,body))
    print("ok")

if __name__=="__main__":
    main()
