# agent-core T16b PR input

## Commits (on main 9b6a8d2)
- 0fc6c6d T16b J5: wire daily-summary into rig-service, vendor connectors 0.3.0, bump 0.5.0
- 18c94f8 T16b J4: daily-summary tools, model summary and checker
- 028893b T16b J7: POST /skills/<name>/run through the scheduler (decision #52)
- 2bd27f9 T16b J1: pass accepted step outputs to later steps as read-only prior

## Diff stat
```
 CHANGELOG.md                             |  35 ++
 docs/local-service.md                    |  92 ++++-
 docs/loop.md                             |  13 +-
 docs/skill-tools.md                      | 243 +++++++++--
 pyproject.toml                           |   2 +-
 src/anorak/__init__.py                   |   2 +-
 src/anorak/daily_summary.py              | 593 ++++++++++++++++++++++++++
 src/anorak/local_service.py              |  39 +-
 src/anorak/loop.py                       |  13 +-
 src/anorak/service_cli.py                | 211 ++++++++--
 src/anorak/skill_tools.py                | 112 +++--
 tests/fixtures/daily-summary/case-1.yaml |  26 ++
 tests/fixtures/daily-summary/case-2.yaml |  19 +
 tests/fixtures/daily-summary/case-3.yaml |  27 ++
 tests/fixtures/daily-summary/skill.yaml  |  33 ++
 tests/test_daily_summary.py              | 690 +++++++++++++++++++++++++++++++
 tests/test_local_service.py              | 113 ++++-
 tests/test_loop_prior.py                 | 217 ++++++++++
 tests/test_service_cli.py                | 397 +++++++++++++++++-
 tests/test_skill_tools.py                |  54 ++-
 tests/test_vendor_provenance.py          |  52 +++
 uv.lock                                  |   2 +-
 vendor/PROVENANCE.md                     |  42 ++
 vendor/connectors-0.3.0-py3-none-any.whl | Bin 0 -> 25150 bytes
 vendor/runtime-requirements.txt          |   4 +
 25 files changed, 2886 insertions(+), 145 deletions(-)
```

## Checks (run by coordinator on 0fc6c6d)
```
uv run pytest -q → 436 passed, 2 skipped, 1 deselected
uv run ruff check . → All checks passed!
uv run ruff format --check <changed .py> → already formatted
uv run mypy --strict src → Success: no issues found in 33 source files
uv run mypy --strict --platform win32 src → Success: no issues found in 33 source files
git diff --check → clean
```

## Facts
- connectors wheel 0.3.0 built from connectors#4 merge fed1512, SHA256 00029ede59a3c2836277ac9f87254335367f6aad4c02c906274cb2cce62c5126; vendored, not a declared dependency (decision #50); install with pip install --no-deps -r vendor/runtime-requirements.txt (Braden approved).
- Graph query syntax is unproven until the live Mac run (TASK step 4).
