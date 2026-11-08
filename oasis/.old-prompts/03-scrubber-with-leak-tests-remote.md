# Prompt — T03 Scrubber with leak tests (remote)

Paste this to Codex after the kickoff is approved and the previous ticket is merged.

---

Work ticket **T03 — Scrubber with leak tests (remote)** from `docs/TICKETS.md`. Rules in `AGENTS.md` apply.

Before writing code, reply with the done-when restated in one line and your step plan (5–10 small steps). Wait for "go".

Then:
- Work in the repo folder named in the ticket under `repos/` (or the cloned GitHub repo once `scripts/create-repos.sh` has run).
- One PR. Tests with the code. Run tests, lint and types; paste the output.
- Update that repo's `CHANGELOG.md`.
- Stop and ask if you need a secret, hit a design choice not in the plan, or fail the same step three times.

Ticket text:

**Repo:** `remote`
**Build:** `src/remote/scrubber.py`. Input: a raw HTTP trace (method, URL, headers, body). Output: same trace with secrets masked as `••••••`. Masks: `Authorization`, `Cookie`, `Set-Cookie`, any header or field named like `key|token|secret|password|passwd|auth|session|csrf`, query-string values for those keys, and any string value with Shannon entropy above a threshold and length ≥ 16. Constants and short human values survive. Reports only a count of secrets removed, never the values. **Fails toward hiding**: when unsure, mask.
**Tests:** `tests/fixtures/traces/` with 200 synthetic traces across 20 fake services, each with planted fake secrets and a manifest of what must survive. `test_no_leaks.py` asserts zero planted secrets in output and all manifest constants present.
**Done when:** 0 leaks on 200 traces; a secret never appears in any log or stdout during tests.

Finish with the done report from `AGENTS.md`.
