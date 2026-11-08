T06 turns scrubbed request recordings into private YAML macros and replays them with changed arguments. The controlled acceptance records a task across two local HTTP services, changes one argument, proves no request leaves while approval is pending, then verifies the resulting requests. Every v1 step requires approval.

**Done-when: MET in controlled two-service acceptance. Windows and Linux CI now pass.** This evidence uses synthetic local services, not a company workflow. Macros stay in the person's drawer outside every git ancestor. No macro files or credentials are committed.

Requests keep fixed origins, resolve explicit step-scoped header secrets only through agent-core 0.2.0 after approval, and reject unresolved scrubber masks, plaintext credential fields, unsafe YAML and shared/unverified drawers. The transport verifies TLS, refuses redirects, bounds payloads and slow responses, and never retries automatically. Audit logs contain metadata only. Rollback metadata is preserved but not executed automatically.

Validation (Python 3.12, macOS):
```
.venv/bin/pytest -q --disable-warnings
356 passed, 3 skipped in 1.41s
# Added cold-start regression: 4 passed, 3 skipped in focused Windows-helper tests
.venv/bin/ruff check .
All checks passed!
.venv/bin/mypy --strict src
Success: no issues found in 7 source files
git diff --check
(no output)
```
Windows CI now passes 360 tests, lint and strict types; Linux CI also passes. Native ACL creation, readback and private macro replay are verified on the disposable Windows runner. Permission handling uses direct .NET APIs to avoid the PowerShell Security-module autoload failure, and a bounded 20-second cold-start window without retries. Review also verified exclusive-creation race handling. Tests include T04's 200-trace leak gate, actual local two-service replay, approval waits, origin/secret isolation, unsafe argument/template rejection, private storage and failure behavior. Independent security review found the Windows ACL and sensitive-field findings fixed with regression coverage, with no remaining blocker.

Combined cross-branch integration also passed: actual T05 TraceWriter output fed the T06 compiler and private storage, then replayed two local HTTP services with one changed argument. Both steps waited for approval; eight audit events contained metadata only. Temporary traces/macros were removed.

One PR for T06. T05 is isolated on a separate branch with its own proxy modules and remains draft pending Windows app evidence. Both branches add the same shared CLI router and CI matrix; combine dependency/README/changelog additions when merging the second PR. Real authenticated replay requires the separately installed local agent-core 0.2.0 secrets interface. No actual keychain reads or live company requests were made for T06. Braden approves every merge.
