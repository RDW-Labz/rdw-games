T03 creates Microsoft/Google app registrations and a secret-safe endpoint readiness probe. Its revised acceptance criterion is **IDs stored + Microsoft passes + Google probe passes**. Real authenticated verification remains T11.

Google now sends exactly `grant_type=authorization_code`, a fake code, stored client ID/secret, and `redirect_uri=http://127.0.0.1`. No PKCE fields are sent in this readiness request. Values are read only through the T02 secrets interface and sent only to the fixed Google HTTPS endpoint. Missing secrets block the request; redirects are refused; audit records contain metadata only.

Per Braden's revised rule, Google passes on JSON `error=invalid_grant` independently of HTTP status; `invalid_client`, `unauthorized_client` and other error codes fail. Diagnostics report only bounded lowercase error codes and suppress direct stored-value reflections, descriptions and bodies. Malformed and token-bearing responses fail closed. Microsoft retains HTTP400 plus invalid_grant. This is readiness only; real sign-in remains T11.

Validation (Python 3.12, local):
```
.venv/bin/pytest -q
158 passed in 0.15s
.venv/bin/ruff check .
All checks passed!
.venv/bin/mypy --strict src scripts
Success: no issues found in 3 source files
```
Tests cover the exact five-field Google request, HTTP400/401 error handling, unknown/unsafe/secret-reflecting error fields, token rejection, encoding, missing secrets, no leaks to output/logs/audit, and redirect refusal. Independent read-only review found no blocking issue under the revised error-based rule. Unit tests use fake storage and HTTP only.

**Live acceptance: MET.** After Braden corrected the stored Google secret, exactly one newly authorized attempt passed on 2026-09-21:
```
microsoft: endpoint responded as expected
google: endpoint responded as expected
note: readiness probe only with a fake authorization code/refresh token; this is not registration validation
endpoint responded; registration, consent, scopes and real sign-in remain UNVERIFIED (T11)
```
Exit 0. Google returned `invalid_grant` under the requested acceptance rule. Credentials were read only through T02. No further attempt was made, no stored ID/secret was changed by the agent, and no response body or stored value was logged. Ready for Braden's review; no merge authorized.

Both registrations and requested scopes are saved. Google Gmail/Calendar/Drive APIs are enabled and the app is External/Testing with Braden as sole tester. The three stored IDs passed format validation; no identifiers appear in the repo or PR.

**Scope split:** T03b owns public homepage/privacy/domain prerequisites, Google verification submission, and Microsoft admin consent. It blocks T11 Gmail connect, not T03. Braden will arrange the Cluer 365 administrator sign-in. Workspace plan, ticket list, decision #35 and T03 prompt changes remain local (including playbooks mirrors), preserving pre-existing unstaged edits. T03b is not implemented. Any dependency on T11 for a genuine verification demo must be resolved with Braden without bypassing that gate.

Uses the sibling T02 agent-core 0.2.0 development checkout; no public package or mutable branch dependency is fetched. Await Braden's merge approval after acceptance is met.
