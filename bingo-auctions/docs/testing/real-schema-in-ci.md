# Testing the seam between the app and the database

Three production incidents in one week (2026-09-14 → 2026-09-19) shared a root
cause that no test could see: **the code built the right query string, and the
database rejected the query PostgREST derived from it.** Unit tests assert the
first half; nothing asserted the second.

The sharpest example is the 2026-09-19 manifest outage. `commitImport` does:

```ts
.upsert(rows, { onConflict: 'operator_id,source_key' })
```

supabase-js turns that into `ON CONFLICT (operator_id, source_key)` — **no WHERE
clause**. mig 0310 had created `import_rows_source_key_uniq` as a **partial**
index (`… WHERE source_key IS NOT NULL`), and Postgres will not infer a partial
index for a predicate-less conflict clause. So the query the app *actually
sends* could never match the index that existed. Every untracked import 500'd.

The mig-0310 SQL test didn't catch it because it spoke **raw SQL**, where the
predicate is expressible — and it wrote exactly that:

```sql
on conflict (operator_id, source_key) where source_key is not null do nothing
```

It proved the database accepts a query the application can never send.

## What already exists

The `schema migrations` job in `ci.yml` is most of the way to a real-schema
harness:

- a real `pgvector/pgvector:pg16` Postgres service,
- Supabase-only objects stubbed (roles `authenticated`/`anon`/`service_role`,
  the `auth`/`storage`/`cron`/`extensions` schemas, `auth.uid()`),
- **every migration replayed from empty**, in order, with `ON_ERROR_STOP`,
- a growing set of `packages/db/test/*.sql` behavioural tests run with `psql`.

What it does **not** have is anything that speaks the app's transport. Every
test is raw SQL, so every test can express predicates, casts, and conflict
arbiters the app cannot — the exact blind spot above.

## Tier 1 — the contract test (shipped)

`packages/db/test/onconflict_targets_resolvable.sql` enumerates every
`onConflict:` target in the app and asserts each is inferable by a
**predicate-less** `ON CONFLICT` — i.e. backed by a FULL unique index on exactly
those columns (partial and expression indexes do not count, because PostgREST
cannot name them). It reproduces the failure at the metadata layer, needs no
fixtures, runs in the job that already exists, and covers all ten upsert targets
at once. Verified red against a partial index, green against 0364's full one.

This class — "does the schema accept the shape PostgREST emits" — is worth
pinning for more than ON CONFLICT. The same idea extends to: every RPC the app
calls exists with the argument types supabase-js sends (`rpc(name, args)`), and
every column named in a `.select()`/`.or()` exists.

Keep the target list in sync:

```
grep -rn "onConflict:" apps/operator-web/src --include='*.ts' --include='*.tsx'
```

## Tier 2 — run the real app code through PostgREST

Tier 1 catches the ON CONFLICT class structurally, but it still restates the
rule in SQL. The stronger form runs the **actual application code** against the
**real migrated schema**, which also covers RPC signatures and RLS assumptions —
both of which, like ON CONFLICT inference, only fail at the PostgREST/Postgres
boundary.

What it takes, on top of the existing `schema migrations` job:

1. **A PostgREST container** in front of the migrated DB
   (`postgrest/postgrest`), with `PGRST_DB_SCHEMAS=public`,
   `PGRST_DB_ANON_ROLE=anon`, and a `PGRST_JWT_SECRET`.
2. **Role wiring** — the stubbed `authenticated`/`anon`/`service_role` roles
   already exist; PostgREST needs `authenticator` to `SET ROLE` into them, plus
   the column/table grants the migrations already issue.
3. **JWT minting** in the test harness so a request can act as a specific
   `service_role` (what `commitImport` uses) or a specific bidder (for RLS).
4. **A Node integration test** that points supabase-js at
   `http://localhost:3000` with a minted key and calls the real functions —
   `commitImport` for the ON CONFLICT path, an RLS read as a bidder for the
   policy assumptions.
5. **Seed helpers** for the minimum rows each path needs (an operator, an
   import), inside a transaction or a truncate-between-tests fixture.

Effort is moderate: the DB half is done, and the missing pieces are a service
definition, a JWT secret, and a small harness. The payoff is that the three
seams that produced this month's incidents — conflict inference, RPC
signatures, RLS — all become testable against the schema they actually run on.

### Why not just mock supabase-js for `commitImport`?

Because the mock would return whatever we tell it, reproducing the same blind
spot: it would prove `commitImport` builds `onConflict: 'operator_id,source_key'`
and nothing about whether Postgres accepts it. The bug lives below the query
string. A `commitImport` test is only worth writing against a real PostgREST,
which is why it is Tier 2 and not this PR.
