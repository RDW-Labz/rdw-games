# TOOL-REQUESTS.md — tools the build needs that are missing or down

One row per request. Braden resolves; the orchestrator notes the workaround in use.

| Date | Tool | Status | Needed for | Workaround until fixed |
|---|---|---|---|---|
| 2026-09-26 | Codex workspace credits (`gpt-6-astra`, `gpt-reserve`) | **Out of credits** (`ERROR: Your workspace is out of credits`), first seen ~15:37Z in T19 PR 3 fix round 1 | UI build jobs with their own screenshot loop (#104), checker agent (#134), shell-heavy jobs (#82) | Braden, 2026-09-26: UI jobs go to Opus (file tools only) until he refills; the orchestrator runs typecheck, lint, tests, the x5 suite and the screenshot harness after each job. Remove this row when he says credits are back. |
