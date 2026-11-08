# agent-core T16b follow-ups PR input

## Commits
- 04d7e05 Remove the dormant agent-level budget (decision #8: no spend cap)
- 187053a T16b follow-ups: decision #54 accounting, ledger settle CLI, vendor path, drawer message (0.6.0)

## Diff stat
```
 CHANGELOG.md                         |  21 +++
 docs/local-service.md                |   4 +
 docs/models.md                       |  92 ++++++++++---
 pyproject.toml                       |   3 +-
 src/anorak/__init__.py               |   2 +-
 src/anorak/ledger_cli.py             | 102 ++++++++++++++
 src/anorak/local_service.py          |   2 +-
 src/anorak/local_service_adapters.py |   9 ++
 src/anorak/models/client.py          | 108 ++++++++++++---
 src/anorak/models/ledger.py          |  56 +++++---
 src/anorak/models/private_ledger.py  |  75 +++++++++--
 src/anorak/models/types.py           |  38 +++++-
 src/anorak/service_cli.py            |  11 +-
 tests/test_ledger_cli.py             | 128 ++++++++++++++++++
 tests/test_local_service.py          |   4 +-
 tests/test_models.py                 | 250 ++++++++++++++++++++++++++++++++---
 tests/test_models_private_ledger.py  |  91 ++++++++++---
 tests/test_service_cli.py            |  21 ++-
 tests/test_vendor_provenance.py      |  11 ++
 uv.lock                              |   2 +-
 vendor/PROVENANCE.md                 |   8 +-
 vendor/runtime-requirements.txt      |   6 +-
 22 files changed, 929 insertions(+), 115 deletions(-)
```
## Checks (coordinator, on 04d7e05)
```
uv run pytest -q → 467 passed, 2 skipped, 1 deselected
uv run pytest -q -k refused_call_then_good_call → 2 passed (memory and file ledger)
uv run ruff check . → All checks passed!
uv run ruff format --check <changed .py> → 15 files already formatted
uv run mypy --strict src → Success: no issues found in 34 source files
uv run mypy --strict --platform win32 src → Success: no issues found in 34 source files
git diff --check → clean
ledger settle braden --amount 0 --drawer ~/OASIS/drawers/braden → nothing to settle (live drawer)
```
## Facts
- All found in the T16b live Mac run 2026-09-23: a call refused for low credit left an uncertain charge that blocked every later model call until the ledger was repaired by hand (fixed by decision #54, Braden).
- Findings covered: (a) vendor install path from repo root, (b) plain message when the drawer folder is not private, (c) model audit failed stage with fixed reason, (g) decision #54 + ledger settle CLI.
- The first worker added an agent-level budget_usd; removed in the last commit because decision #8 says there is no spend cap.
