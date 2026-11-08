# T16b follow-ups: packaged catalog, python -m gates, Entra /callback redirect

## Summary

- (d) Package the catalog in the wheel so gates.connect doesn't crash when installed from a wheel. The catalog now ships in gates/_catalog, default_catalog_dir() looks for a source checkout first then falls back to the packaged copy, and CatalogNotFoundError prints a single clean line with exit code 2.
- (e) Add the Entra redirect URI http://localhost/callback to docs/registrations.md. The Mobile and desktop applications platform needs this in addition to http://localhost, or the loopback listener's callback path won't match the registered redirect.
- (f) Stop the RuntimeWarning when running python -m gates. Added src/gates/__main__.py and the gates console script so python -m gates connect/status work with no warning, while keeping the old spellings for compatibility. Updated docs/connect.md.
- Version 0.3.1.

## Why

Found in the T16b live Mac run (2026-09-23).

## Tests

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

## Open for Braden

agent-core's vendored wheel stays 0.3.0 for now (it only needs gates.graph_read). Re-vendoring 0.3.1 is a later choice.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
