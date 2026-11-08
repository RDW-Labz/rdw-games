T04 adds the scrubber boundary required before REMOTE can save HTTP traces. It returns a copied, sanitized trace and a redaction count; it performs no logging, disk writes, capture, network calls or secret-store access.

Sensitive headers/field names and high-entropy values are masked as `••••••`. URLs handle user information, encoded query names/values, path segments and fragments. Structured, JSON and form bodies are scrubbed recursively; malformed/opaque/binary input is hidden. Recursion, collection and text limits fail toward masking. Short safe values survive, and removed values never appear in diagnostics. Full limits and heuristic limitations are in `docs/scrubber.md`.

The checked-in acceptance corpus has 200 distinct synthetic traces across 20 fake services and 500 planted fake credentials, with location-specific survivor expectations. Its test checks serialized output, stdout/stderr/logs, preservation and input immutability. Negative controls prove that passthrough leaks and blanket masking both fail the acceptance checker. Existing CI runs this gate through the full pytest suite on every PR.

Independent review caught and prompted regression fixes for hostile instance/metaclass exception paths, nested business fields being interpreted as HTTP envelope fields, and counting when masked names collide. A final malformed-Unicode reproduction also prompted guards and regression tests so form encoding cannot expose a raw exception. Implementation and corpus were owned by separate native agents; coordinator owns integration and final checks. Project-swarm's Claude launch was blocked by missing required safety flags; restrictions were not weakened.

Validation on Python 3.12.14 (existing locked local environment):
```text
.venv/bin/pytest -q
270 passed in 0.21s
.venv/bin/ruff check .
All checks passed!
.venv/bin/mypy --strict src
Success: no issues found in 2 source files
git diff --check
(no output; exit 0)
```
The full run includes all 200 leak cases plus corpus/control checks and 65 focused unit tests. Zero planted secrets leaked and every manifest constant survived. No real trace, account, secret store, network or external service is used by the tests.

No proxy, trace writer, macro replay or later-ticket work is included. No new runtime dependencies. T03 remains a separate draft PR after Google's one authorized probe returned `invalid_client`; Braden explicitly authorized T04 without waiting for T03 review. Await Braden's merge approval.

GitHub CI passed at `2c8b3281fb68c0d5df99c299c94ca55fb7571214`: https://github.com/RDW-Labz/remote/actions/runs/35657795263
