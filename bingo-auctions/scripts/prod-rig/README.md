# prod-rig — read-only prod queries and a prod-shaped test copy

Written up in `docs/state/HANDOFF-2026-09-29.md` §7.

| File | What |
|---|---|
| `q.sh <file.sql>` | Read-only prod query via `apply-migration.yml mode=query`; rows land in `<file>.out`. No double quotes in the SQL. Hard-coded to `/Users/prime/Developer/bingo-auctions`. |
| `close-check-after-0376.sql` | Tonight's close health check (stuck live lots, won without winner, notices, job failures, invoices built). |
| `pull-prod-functions.sql` | Dumps every prod `public` function definition, to lay over the copy. |
| `rig-stubs.sh` | Inside the `pgvector/pgvector:pg16` container: CI's Supabase stubs + every master migration. |
| `delete-lot-guard-scenario.sql` | Mig 0400 proof: footprint lots refuse a hard delete on every path (JWT, service role, SQL); bare lots delete with an `operator_audit_log` row. Run before and after applying 0400. |
| `finalize-scenario.sql` | Close with bids / without bids / soft-close extension, then invoice build. Run before and after an engine change and diff. |

Never writes to prod. Test data uses `example.test` addresses only.
