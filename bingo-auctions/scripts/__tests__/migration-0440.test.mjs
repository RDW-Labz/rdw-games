// 0440: revoke the unused anon/authenticated grants on 18 RLS-locked tables.
// The DB test runs against a scratch Postgres (its own database, dropped
// afterwards) only when TIGHTEN0440_PG_URL is set, e.g. local supabase :54322:
//   TIGHTEN0440_PG_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   TIGHTEN0440_MIGRATION=<path to 0440 file> node --test scripts/__tests__/migration-0440.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const URL0 = process.env.TIGHTEN0440_PG_URL;
const MIG = process.env.TIGHTEN0440_MIGRATION ?? new URL('../../packages/db/migrations/0440_tighten_public_grants.sql', import.meta.url).pathname;
const ROLLBACK = new URL('../prod-rig/0440_ROLLBACK_tighten_public_grants.sql', import.meta.url).pathname;
const DB = `tg0440_${process.pid}`;

const TABLES = [
  '_schema_migrations', 'bidder_sticker_scan_log', 'build_invoice_jobs', 'client_crash_reports',
  'image_enrichment_jobs', 'invariant_check_runs', 'marketing_campaign_sends', 'marketing_digest_sends',
  'meta_events_outbox', 'ops_alert_throttle', 'ota_publishes', 'platform_settings',
  'processed_webhook_events', 'product_cache_warm_jobs', 'promo_codes', 'refund_claims',
  'share_clicks', 'workers',
];
// Left alone on purpose: 0439 owns the backup tables; operators_public is meant to be public.
const NOT_TOUCHED = ['_catalog_misfire_20260921', '_manifest_rows_already_lotted_20260928', '_poisoned_tracking_lookups_20260924', 'operators_public'];

const dbUrl = (db) => `${URL0.replace(/\/[^/]*$/, '')}/${db}`;
const psql = (db, args, input) => execFileSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', dbUrl(db), ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
// Returns the row count, 'denied:42501', or the raw error.
const asRole = (role, sql) => {
  try {
    return psql(DB, ['-c', '\\set VERBOSITY verbose', '-c', `SET ROLE ${role}; ${sql}`]).trim();
  } catch (e) {
    const m = /ERROR:\s+([0-9A-Z]{5}):/.exec(String(e.stderr));
    return m ? `denied:${m[1]}` : `error: ${String(e.stderr).trim()}`;
  }
};
const acl = () => psql(DB, ['-c', `SELECT c.relname || ':' || pg_get_userbyid(a.grantee) || ':' || a.privilege_type || ':' || a.is_grantable
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.relnamespace = 'public'::regnamespace ORDER BY 1`]).trim();

test('0440 file shape (no database needed)', () => {
  const sql = readFileSync(MIG, 'utf8');
  for (const t of TABLES) assert.ok(sql.includes(`public.${t}`), `lists ${t}`);
  assert.equal((sql.match(/^\s+public\.[a-z_]+,?$/gm) ?? []).length, 18, 'exactly 18 tables in the REVOKE');
  for (const t of NOT_TOUCHED) assert.ok(!sql.includes(`public.${t}`), `does not touch ${t}`);
  assert.match(sql, /^SET lock_timeout = '3s';$/m);
  assert.match(sql, /^REVOKE ALL ON TABLE$/m);
  assert.match(sql, /^FROM anon, authenticated;$/m);
  assert.doesNotMatch(sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n'), /\bDO\s+\$|EXECUTE/i, 'no DO/EXECUTE (guard lint)');
  const { lintMigration } = require('../check-new-lot-migrations.cjs');
  assert.deepEqual(lintMigration(sql).errors, [], 'guard lint clean');
  const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /service_role/, 'service_role untouched');
  assert.doesNotMatch(code, /\b(DELETE FROM|TRUNCATE TABLE|DROP |UPDATE public|INSERT INTO|ROW LEVEL SECURITY|CREATE POLICY|GRANT )/i, 'no data, RLS, policy or grant changes');

  const rb = readFileSync(ROLLBACK, 'utf8');
  for (const t of TABLES) assert.ok(rb.includes(`'${t}'`), `rollback lists ${t}`);
  assert.match(rb, /GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public\.%I TO anon, authenticated/);
  const rbCode = rb.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(rbCode, /GRANT ALL/i, 'explicit privilege list, not GRANT ALL');
  assert.doesNotMatch(rbCode, /service_role|ROW LEVEL SECURITY/i, 'rollback only re-grants anon/authenticated');
});

test('0440 on a scratch DB: before 0 rows, after 42501, owner reads, rerun, rollback restores exactly', { skip: !URL0 }, () => {
  psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB}`, '-c', `CREATE DATABASE ${DB}`]);
  try {
    psql(DB, [], `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$;`);

    // (No empty-DB step: plain REVOKE needs the tables, which earlier migrations always create.)

    // Prod shape: RLS on, no policies, the Supabase default grants (ALL) to anon,
    // authenticated and service_role, one row each. Plus a bystander table 0440 must not touch.
    const ddl = TABLES.map((t) => `
      CREATE TABLE public.${t} (id int PRIMARY KEY, note text);
      INSERT INTO public.${t} VALUES (1, 'x');
      ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`).join('\n');
    psql(DB, [], `${ddl}
      CREATE TABLE public.bystander (id int PRIMARY KEY); INSERT INTO public.bystander VALUES (1);
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;`);
    const before = acl();

    // Before: RLS default deny, so anon/authenticated read 0 rows (no error).
    for (const t of TABLES) {
      assert.equal(asRole('anon', `SELECT count(*) FROM public.${t}`), '0', `before: anon reads 0 rows of ${t}`);
      assert.equal(asRole('authenticated', `SELECT count(*) FROM public.${t}`), '0', `before: authenticated reads 0 rows of ${t}`);
    }

    psql(DB, ['-f', MIG]);
    for (const t of TABLES) {
      assert.equal(asRole('anon', `SELECT count(*) FROM public.${t}`), 'denied:42501', `after: anon ${t}`);
      assert.equal(asRole('authenticated', `SELECT count(*) FROM public.${t}`), 'denied:42501', `after: authenticated ${t}`);
      assert.equal(asRole('authenticated', `INSERT INTO public.${t} VALUES (2, 'y')`), 'denied:42501', `after: authenticated insert ${t}`);
      assert.equal(psql(DB, ['-c', `SELECT count(*) FROM public.${t}`]).trim(), '1', `after: owner still reads ${t}`);
      assert.equal(psql(DB, ['-c', `SELECT has_table_privilege('service_role', 'public.${t}', 'SELECT,INSERT,UPDATE,DELETE')`]).trim(), 't', `after: service_role untouched on ${t}`);
      assert.equal(psql(DB, ['-c', `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${t}'::regclass`]).trim(), 't', `after: RLS still on for ${t}`);
      assert.equal(psql(DB, ['-c', `SELECT count(*) FROM public.${t}`]).trim(), '1', `no data change in ${t}`);
    }
    assert.equal(asRole('anon', 'SELECT count(*) FROM public.bystander'), '1', 'tables outside the list keep their grants');

    psql(DB, ['-f', MIG]); // rerun is harmless
    for (const t of TABLES) assert.equal(asRole('anon', `SELECT count(*) FROM public.${t}`), 'denied:42501', `rerun: anon ${t}`);

    psql(DB, ['-f', ROLLBACK]);
    assert.equal(acl(), before, 'rollback restores the exact pre-0440 ACL');
    for (const t of TABLES) assert.equal(asRole('anon', `SELECT count(*) FROM public.${t}`), '0', `rollback: anon back to 0 rows on ${t}`);
  } finally {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB}`]);
  }
});
