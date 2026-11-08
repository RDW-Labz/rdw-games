# T51 item 1 — CI baseline tool (contract)

Script: `coordination/tools/ci_baseline.py` (Python 3.12 stdlib only; no third-party imports).
CLI: `python3 coordination/tools/ci_baseline.py --since YYYY-MM-DD [--until YYYY-MM-DD] [--owner RDW-Labz] [--repos a,b,...] [--out FILE.json] [--row]`
- Default repos: agent-core, remote, skills, connectors, rag-pipeline, playbooks, desktop-app, agent-amber, agent-michael, project-swarm.
- Data: `gh api --paginate repos/{owner}/{repo}/actions/runs?created=>=SINCE&per_page=100` then for each completed run `gh api repos/{owner}/{repo}/actions/runs/{id}/jobs?per_page=100`. All gh calls go through ONE function `gh_json(args: list[str]) -> Any` that tests replace (inject via a `fetch` parameter on `collect()`).
- Run seconds = updated_at − run_started_at (fallback created_at). Job seconds = completed_at − started_at; skip jobs with null times or conclusion "skipped".
- Output JSON: `{"since","until","generated","repos":{repo:{"runs":n,"runMedianS","runP90S","byEvent":{event:{"runs","medianS"}},"jobs":{jobName:{"n","medianS","p90S","failRate"}},"prWallMedianS"}}}`. `prWallMedianS` = median over PRs merged in the window of (merged_at − created_at), from `gh api --paginate repos/{o}/{r}/pulls?state=closed&per_page=100` filtered on merged_at in window.
- Median/p90: nearest-rank on sorted ints; empty → null.
- `--row` prints one markdown table row for swarm-metrics.md "CI baseline (T51)": `| week | repo | runs | run median | run p90 | slowest job (median) | PR wall median |`, one row per repo, durations as `Xm Ys`.
- A gh error on one repo records `{"error": "<first line>"}` for that repo and continues; exit 0 unless every repo errored.
Tests: `coordination/tools/test_ci_baseline.py` (pytest-style but runnable with `python3 -m pytest`), fixture `coordination/tools/fixtures/ci_baseline_gh.json` (recorded-shape fake responses keyed by the gh args string; fake repo names like `demo-repo`, no real ids). Cover: medians/p90 with odd/even counts; skipped/null-time jobs excluded; failRate; byEvent split; prWall only for merged-in-window PRs; one repo erroring does not stop others; `--row` format.
