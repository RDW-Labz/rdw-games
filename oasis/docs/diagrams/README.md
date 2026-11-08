# Diagrams

Generated with [archify](https://github.com/tt-a1i/archify) (pinned `d5a1333`, MIT
license), installed read-only at `~/.project-swarm/toolchains/archify/`.
Generated 2026-09-30. No hooks, no network — only `validate`, `render`, and
`check` were run; `finalize`, `deliver`, `preview`, and `brands capture` were
not used.

The `.json` file for each diagram is the editable source; the `.html` file is
a rendered, checked artifact regenerated from it. Edit the JSON, then
regenerate the HTML with the commands below.

## architecture.json / architecture.html

OASIS system overview: the Rig (desktop app) talking to the local service
(agent-core / Anorak) over local HTTP/WebSocket, the service's use of skills
(Almanac), playbooks (Garage), connectors (Gates), the private per-person
drawer, remote (Zemeckis), the rag pipeline (Journals), and the nightly loop
(Scoreboard), all gated by the ask-first gate before any risky action.
Grouped into "On the person's Mac" and "Outside tools" regions. Connector
targets (Outlook mail/calendar, Teams, OneDrive, Google Drive & Calendar,
QuickBooks) are tagged `live` or `catalog-only`.

**Source of truth:** `README.md` sections "## 2. How it works" and "## 3. The
repos" (this repo, current working tree).

**Regenerate:**

```bash
node ~/.project-swarm/toolchains/archify/bin/archify.mjs validate architecture docs/diagrams/architecture.json --json
node ~/.project-swarm/toolchains/archify/bin/archify.mjs render architecture docs/diagrams/architecture.json docs/diagrams/architecture.html --quality showcase
node ~/.project-swarm/toolchains/archify/bin/archify.mjs check docs/diagrams/architecture.html --json
```

## t64-watcher.json / t64-watcher.html

T64 Watcher v1 (Windows) components and data flow: captured app traffic
(Edge, Chrome, desktop Outlook) through the mitmproxy capture step, the
in-process scrubber, the HAR-shaped raw trace, macro extraction into a
`.remote` file, and replay behind the ask-first gate — plus the fallback path
for apps that pin their own certificate or ignore the proxy, logged as
`"unseen: <host>"`. The service's `"watcher: not connected" -> "watcher:
connected"` state (decision #41) is kept as a note card rather than a
lifecycle, since this diagram uses the `workflow` type.

The fallback node's sublabel was corrected to "browser + per-app, apps that
pin their own cert" (decision #313).

**Source of truth:** `.swarm-manifests/t72-archify-src/watcher.md` (design
doc; matches `remote` repo's `docs/watcher.md` at commit `cd79271`), mermaid
flowchart near line 26.

**Regenerate:**

```bash
node ~/.project-swarm/toolchains/archify/bin/archify.mjs validate workflow docs/diagrams/t64-watcher.json --json
node ~/.project-swarm/toolchains/archify/bin/archify.mjs render workflow docs/diagrams/t64-watcher.json docs/diagrams/t64-watcher.html --quality showcase
node ~/.project-swarm/toolchains/archify/bin/archify.mjs check docs/diagrams/t64-watcher.html --json
```

## PNG export

Each `.png` is a screenshot of the matching `.html`, taken headless with
`docs/diagrams/export-png.mjs` (Chromium via Playwright, light theme, full
page, `deviceScaleFactor: 2`):

The PNG hides the viewer's toolbar and floating PATH/MAP/LENS/zoom bar
(screenshot-time only, via injected CSS; the `.html` keeps them).

```bash
node docs/diagrams/export-png.mjs docs/diagrams/architecture.html docs/diagrams/architecture.png
node docs/diagrams/export-png.mjs docs/diagrams/t64-watcher.html docs/diagrams/t64-watcher.png
```

## project-swarm.json / project-swarm.html / project-swarm.png

How the project-swarm repo works, at 1.40.0 (worktrees/swarm-y-pr, commit 4dbcb20): 73 components and 70 connections across the orchestrator inputs (manifest, skills, gotchas, config, env), the CLI commands and what each refuses, the run engine (claim, runs dir, workspace copy / detached worktree, concurrency, envelope parsing), the four adapter families (Claude CLI, claude-shell, Codex sandbox, OpenRouter/API single-request), inspect / integrate / ship / checks-from-ci / session-metrics, and install/update. Every component names its file or command; edges the worker could not verify in code are listed in `project-swarm-notes.md` under "unverified". Generated 2026-10-01 by a Codex worker (job swarm-diagram, run 1790896150784-519b2ccf) from the source, archify d5a1333, MIT; no hooks, no network. The diagram declares repository evidence, so validate needs the checkout:

```
node ~/.project-swarm/toolchains/archify/bin/archify.mjs validate architecture docs/diagrams/project-swarm.json --repo-root <project-swarm checkout> --json
node ~/.project-swarm/toolchains/archify/bin/archify.mjs render architecture docs/diagrams/project-swarm.json -o docs/diagrams/project-swarm.html
node ~/.project-swarm/toolchains/archify/bin/archify.mjs check docs/diagrams/project-swarm.html --json
node docs/diagrams/export-png.mjs docs/diagrams/project-swarm.html docs/diagrams/project-swarm.png
```

`check` passes with six warnings (five proper crossings, one desktop-readability warning: edge labels at 8 px source size project to 3.6 px at 1440 px wide because the canvas is 6954 px tall; zoom or the PNG at full size reads fine).

