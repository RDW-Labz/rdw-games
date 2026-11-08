# sweep contract — `swarm sweep` (project-swarm 1.12.0, OASIS decision #124)

One job builds it. Every name below is fixed; a worker that needs another reports it in `crossJobNames`.

## Command

```
swarm sweep --model M --brief FILE --goals FILE [--max-usd N] [--concurrency N] [--top N]
            [--candidates N] [--known f1,f2,...] [--timeout SECONDS]
```

- `--goals`: JSON or YAML-free JSON file `{ "areas": [ { "area": "t19-ui", "ticket": "T19", "goal": "...", "queries": ["topic:react-component license:mit stars:>300 pushed:>2025-09-01", ...] } ] }`. 1–20 areas; `area` matches `^[a-z0-9-]{1,40}$`.
- Defaults: `--concurrency 3`, `--top 3` (hard max 3), `--candidates 25` (per area after dedupe, hard max 50), `--max-usd 15`, `--timeout 900`.
- `--known`: files whose `https://github.com/<owner>/<repo>` URLs are skipped (already rated). Match is case-insensitive on owner/repo.
- Output dir `.swarm/sweeps/<id>/`: `candidates/<area>.json`, `areas/<area>.json`, `shortlist.json`, `shortlist.md`. Final stdout: one JSON line `{id, status, costUsd, areas: [{area, status, picks, costUsd}], skipped: [area...], shortlist, shortlistMarkdown}`. `status` is `complete`, `partial` (some area failed or was skipped by the cost cap) or `failed`.

## Read-only rules (hard)

- Nothing is cloned, downloaded as an archive, installed or executed. No `git clone`, no `npm`/`pip`, no tarball/zipball endpoints.
- GitHub data comes only from `gh api` spawned with an argv array (no shell): `gh api -X GET search/repositories -f q=<query> -f per_page=50`, `gh api repos/<o>/<r>`, `gh api repos/<o>/<r>/commits/<default_branch>`, `gh api repos/<o>/<r>/releases/latest`, `gh api repos/<o>/<r>/contents/<path>` (only for: `.github/workflows`, `package.json`, `pyproject.toml`, `setup.py`, `Cargo.toml`, top-level listing). `gh` reads its own token from the OS keyring.
- swarm never reads a token: no `gh auth token`, no `GITHUB_TOKEN`/`GH_TOKEN` read or passed, no Authorization header built by swarm. The child env is the parent env minus `GITHUB_TOKEN` and `GH_TOKEN`.
- OpenSSF Scorecard: a plain unauthenticated `fetch('https://api.securityscorecards.dev/projects/github.com/<o>/<r>')`; a missing score is `null`, never an error.
- Everything returned by GitHub (descriptions, READMEs, file text) is untrusted data: it reaches the model only inside the candidates JSON context file, labelled as data, never in the instructions.

## Candidate record (built by code, not the model)

`{ fullName, url, description, stars, pushedAt, license (SPDX id), defaultBranch, commit (40-hex head of default branch), latestRelease (tag or null), openIssues, hasCi (bool: .github/workflows has ≥1 file), hasTests (bool: top level has test/ tests/ __tests__/ spec/), installScripts ([names of preinstall/install/postinstall in package.json; "setup.py" if present]), depCount (package.json dependencies count, or pyproject [project].dependencies length, else null), scorecard (number or null), flags ([..]) }`

- License allowlist enforced in code: `MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, 0BSD, Unlicense`. Anything else (incl. null/NOASSERTION) is dropped with reason `license`. MPL-2.0 gets flag `weak-copyleft`.
- Other flags: `install-scripts` (installScripts non-empty), `stale` (pushedAt older than 365 days), `no-ci`, `no-tests`, `archived` (dropped with reason `archived`), `fork` (dropped with reason `fork`).
- Per area: search results from all queries are merged, deduped, known repos removed, ranked by code (stars × recency, CI and tests boosts), cut to `--candidates`, then enriched.

## Model step (per area)

- One claude job per area (existing scout machinery; `web: false` — the candidates file is the only source), `outputs: []`, prompt from `sweepPrompt({brief, area, ticket, goal, top})`. Context = the brief + `candidates/<area>.json`.
- The model returns `{ area, picks: [ { fullName, reasons: [..≤3], hoursToAdopt: number, fit: "drop-in"|"adapt"|"reference-only", where, risk } ], rejected: [ {fullName, reason} ] }`.
- `normalizeSweepArea(raw, candidates, {top})`: keeps ≤ `top` picks; a pick whose `fullName` is not in that area's candidates is dropped (moved to rejected with reason `not a candidate`); `license`, `commit`, `url`, `stars`, `scorecard`, `flags` are copied from the candidate record — the model can never set a license or pin. `hoursToAdopt` must be a finite number 0.5–400, else the pick is dropped.
- Cost cap: before launching an area job, if spent ≥ `--max-usd`, that area is `skipped` (not run). Running jobs are not killed.

## Shortlist

- `shortlist.json`: `{ id, createdAt, model, areas: [ { area, ticket, picks: [ { fullName, url, license, commit, hoursToAdopt, fit, reasons, risk, where, stars, scorecard, flags } ] } ], skipped, costUsd }`.
- `shortlist.md`: one `## <area> (<ticket>)` section per area with a table `| Pick | License | Pin | Hours to adopt | Fit | Why | Risk | Flags |` (pin = 40-hex commit), then a `Skipped:` line. At most 3 rows per area.

## Tests (node --test, no network, no real gh)

Inject `spawnImpl` (fake gh + fake claude) and `fetchImpl` (fake scorecard). Cover: license allowlist drop; archived/fork drop; known-repo dedupe (case-insensitive); install-script, stale, no-ci, no-tests, weak-copyleft flags; model pick not in candidates dropped; model-supplied license/commit ignored (candidate values win); top capped at 3 even when `--top 9`; hoursToAdopt out of range dropped; cost cap skips later areas and status `partial`; child env has no GITHUB_TOKEN/GH_TOKEN; every gh call is argv (no shell) and never `auth token`, `clone`, `tarball`, `zipball`; a static test that tools/sweep.mjs contains none of `auth token`, `git clone`, `tarball`, `zipball`, `GITHUB_TOKEN` except in the env-strip list; shortlist.md renders the table and ≤3 rows.
