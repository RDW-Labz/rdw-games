// One-off helper: applies all packages/db/migrations/*.sql to a hosted
// Supabase project, in filename order, in a single connection. Logs
// per-file pass/fail and exits non-zero on the first failure.
//
// Usage:
//   POSTGRES_URL='postgresql://postgres.<ref>:<pwd>@<region>.pooler.supabase.com:6543/postgres' \
//     node scripts/push-hosted-migrations.js
//
// Idempotency: each migration runs in its own transaction. If you re-
// run after a successful pass, most statements (CREATE ... IF NOT
// EXISTS, INSERT ... ON CONFLICT) no-op. Some (CREATE POLICY) will
// throw "already exists" — the runner stops there. For initial bring-
// up against a fresh project, that's exactly what we want.

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error('Set POSTGRES_URL.');
  process.exit(1);
}

const migrationsDir = path.join(__dirname, '..', 'packages', 'db', 'migrations');
const startAt = process.env.START_AT ?? '';
const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .filter((f) => f >= startAt)
  .sort();

(async () => {
  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  console.log('connected — applying', files.length, 'migrations');
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    process.stdout.write(`  ${f} ... `);
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('COMMIT');
      console.log('ok');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      console.log('FAIL');
      console.error(e.message);
      process.exit(1);
    }
  }
  await c.end();
  console.log('all migrations applied.');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
