# connectors T16b follow-ups PR input

## Commit
389cd38 T16b follow-ups: packaged catalog, python -m gates, Entra /callback redirect (0.3.1)

Ship the catalog in the wheel (gates/_catalog) with a plain error and
--catalog-dir; add gates/__main__.py and the gates console script so
python -m gates runs with no RuntimeWarning; document the
http://localhost/callback redirect in registrations.md.


## Diff stat
```
 CHANGELOG.md              | 20 +++++++++++++++++
 docs/connect.md           | 32 +++++++++++++++++++++------
 docs/registrations.md     | 12 +++++++---
 pyproject.toml            |  8 ++++++-
 src/gates/__main__.py     | 25 +++++++++++++++++++++
 src/gates/catalog.py      | 34 ++++++++++++++++++++++++++--
 src/gates/connect.py      | 22 ++++++++++++-------
 tests/test_catalog.py     | 46 +++++++++++++++++++++++++++++++++++++-
 tests/test_connect_cli.py | 29 ++++++++++++++++++++++++
 tests/test_main.py        | 56 +++++++++++++++++++++++++++++++++++++++++++++++
 uv.lock                   |  2 +-
 11 files changed, 263 insertions(+), 23 deletions(-)
```
## Checks (coordinator, on 389cd38)
```
uv run pytest -q → 225 passed
uv run ruff check . → All checks passed!
uv run ruff format --check <changed .py> → 6 files already formatted
uv run mypy --strict src → Success: no issues found in 14 source files
uv run mypy --strict --platform win32 src → Success: no issues found in 14 source files
uv build --wheel → connectors-0.3.1-py3-none-any.whl, 7 catalog files under gates/_catalog/
python -W error::RuntimeWarning -m gates status --person braden → runs, no warning
git diff --check → clean
```
## Facts
- Found in the T16b live Mac run (2026-09-23). (d) gates.connect crashed with a traceback from an installed wheel because the catalog was not in it. (e) Braden had to add the Entra redirect http://localhost/callback by hand. (f) python -m gates.connect printed a RuntimeWarning.
- agent-core's vendored wheel stays 0.3.0 for now (it only needs gates.graph_read); re-vendoring 0.3.1 is a later choice.
