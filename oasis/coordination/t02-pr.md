T02 adds `anorak.secrets.get/set/delete/list` over Windows Credential Manager and macOS Keychain, a redacted `SecretValue`, and the hidden-input `secrets` CLI. Callers explicitly reveal values at their transport boundary; unsupported native platforms fail closed.

The keychain-resident names index is serialized across processes. Partial writes/deletes leave only recoverable stale names. Metadata-only audit records are durably appended before and after each operation; failed initial auditing prevents access. Backend errors and CLI parse failures never echo values.

Validation (Python 3.12, local):
```
pytest -q
165 passed, 1 deselected in 1.61s
ruff check .
All checks passed!
mypy --strict src
Success: no issues found in 4 source files
pytest -q tests/test_native_keychain.py
1 passed, 1 deselected in 0.03s
```
The focused test proves cleanup after audit failure. The deselected native test intentionally runs only on disposable Windows/macOS CI runners; it does not touch a developer's login keychain. CI also runs the complete unit/lint/types suite on Linux, Windows and macOS.

A local cross-repo smoke check used the actual 0.2.0 module facade, T03 probe and both audit files with fake storage/HTTP: passed. No live IDs or tokens were read. Version 0.2.0 is prepared here, not published. Await Braden's merge approval.

First CI exposed and fixed two platform assumptions: Windows deletes the lock marker on release; Linux mypy requires backend selection that does not rely on unreachable platform branches. Local strict type checks now also pass with `--platform linux` and `--platform win32`. Latest CI is green on Linux, Windows and macOS, including both real native keychain roundtrips: https://github.com/RDW-Labz/agent-core/actions/runs/35647570499 (head d2d581b).
