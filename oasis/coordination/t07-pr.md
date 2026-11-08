T07 adds the skill loop and a four-worker resource scheduler. Trusted skill plans run registered tools, independent checks and at most three fixes per step, with time/step/spend budgets and serialized ask-first prompts. File and screen access are exclusive; connector/model access can run concurrently under declared limits. A failed worker does not stop other workers.

Audit logs are private, append-only and fsynced; every event names the worker and held resources. Windows private objects are created with an explicit owner and protected DACL; existing permissions are verified without repair. Unknown model identity stays unknown. Cancellation waits for cooperative tool cleanup before releasing resources.

Validation:
```
.venv/bin/pytest -q -m 'not native'
226 passed, 2 skipped, 1 deselected in 1.81s
.venv/bin/ruff check .
All checks passed!
.venv/bin/mypy --strict src/
Success: no issues found in 7 source files
.venv/bin/mypy --strict --platform win32 src/
Success: no issues found in 7 source files
```
The two local skips are native Windows ACL cases. Disposable Windows/macOS CI also exercises the existing fake-only OS-keychain roundtrip. No real provider calls or user keychain writes were used. Provider rate windows and effects adapters remain responsible for obeying their supplied remaining budget and cancellation contract; the scheduler enforces concurrency limits.
