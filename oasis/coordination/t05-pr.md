T05 adds a Windows learning proxy at 127.0.0.1:7788. It captures only operator-tested hosts after per-site Yes; pending, declined and untested hosts pass through unseen. Every request is scrubbed immediately before private JSONL storage. The CA private key stays in memory; stop/crash recovery restores current-user WinINET settings and removes only the session-owned public certificate.

**Done-when: NOT MET. Draft pending a Windows test box.** Real Edge, Chrome and desktop Outlook capture, usability and exact settings restoration remain unverified. Braden has no Windows box available. The chosen compatibility policy avoids intentionally failing an unknown app's first TLS handshake. Apps that bypass WinINET may remain unseen.

The implementation includes background consent, exclusive session ownership, safe stop despite audit failure, metadata-only audit, credential-free recovery state, private-file ACL/reparse checks and a clear uninstall path. No developer system proxy/trust or actual credentials were changed. The operator CLI is a seam for the later Rig UI.

Validation (Python 3.12, macOS):
```
.venv/bin/pytest -q --disable-warnings
340 passed, 3 skipped, 43 warnings in 1.84s
.venv/bin/ruff check .
All checks passed!
.venv/bin/mypy --strict src
Success: no issues found in 7 source files
git diff --check
(no output)
```
The local skips require native Windows. Windows CI passed 342 tests with one non-Windows guard skipped; Linux CI also passed. Dependency deprecation warnings remain. Tests include the T04 200-trace leak gate, real loopback HTTP through mitmproxy with fake system settings, real TLS-context creation with an in-memory CA, consent/pinning bypass, stop/audit failures and recovery. Linux/Windows CI also runs a read-only native WinINET/ACL smoke; it does not replace app acceptance.

Independent review found and verified fixes for TLS DH construction, blocking consent, unsafe snapshot strings, file ACL/reparse checks and audit-blocked stop. See docs/proxy.md for the outstanding Windows checklist.

Combined cross-branch integration also passed: actual T05 TraceWriter output fed the T06 compiler and private storage, then replayed two local HTTP services with one changed argument. Both steps waited for approval; eight audit events contained metadata only. Temporary traces/macros were removed.

Native Windows fixes now explicitly create private owner/DACL attributes before data and serialize audit writes across processes. Four concurrent processes retained all 80 unique audit records. Real Windows app checks are still pending.

One PR for T05. T06 is isolated on a separate branch with its own macro modules. Both branches add the same shared CLI router and CI matrix; combine dependency/README/changelog additions when merging the second PR. Braden approves every merge.
