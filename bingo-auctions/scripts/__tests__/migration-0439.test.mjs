// 0439: backup tables locked from anon/authenticated. Runs against a scratch
// Postgres only when BACKUP0439_PG_URL is set (e.g. local supabase :54322):
//   BACKUP0439_PG_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   BACKUP0439_MIGRATION=<path to 0439 file> node --test scripts/__tests__/migration-0439.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const URL0 = process.env.BACKUP0439_PG_URL;
const MIG = process.env.BACKUP0439_MIGRATION ?? new URL('../../packages/db/migrations/0439_lock_backup_tables.sql', import.meta.url).pathname;
const ROLLBACK = new URL('../prod-rig/0439_ROLLBACK_lock_backup_tables.sql', import.meta.url).pathname;
const DB = `bk0439_${process.pid}`;
const psql = (db, args, input) => execFileSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', `${URL0.replace(/\/[^/]*$/, '')}/${db}`, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const tryAs = (role, sql) => { try { psql(DB, ['-c', `SET ROLE ${role}; ${sql}`]); return 'ok'; } catch (e) { return /permission denied/.test(String(e.stderr)) ? 'denied' : `error: ${String(e.stderr).trim()}`; } };

test('0439 file shape (no database needed)', () => {
  const sql = readFileSync(MIG, 'utf8');
  for (const t of ['_catalog_misfire_20260921', '_manifest_rows_already_lotted_20260928', '_poisoned_tracking_lookups_20260924']) assert.ok(sql.includes(`public.${t}`), t);
  assert.match(sql, /^SET lock_timeout = '3s';$/m);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /^REVOKE ALL ON TABLE$/m);
  assert.match(sql, /^FROM anon, authenticated;$/m);
  assert.doesNotMatch(sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n'), /\bDO\s+\$|EXECUTE/i, 'no DO/EXECUTE (guard lint)');
  assert.doesNotMatch(sql, /\b(DELETE|TRUNCATE|DROP TABLE|UPDATE)\b/i);
});

test('0439 on a scratch DB: anon/authenticated lose read, owner keeps it, rollback reopens', { skip: !URL0 }, () => {
  psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB}`, '-c', `CREATE DATABASE ${DB}`]);
  try {
    psql(DB, [], `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$;`);
    // (No empty-DB step: plain statements need the tables, which 0366/0372/0373 create.)
    // Prod shape: three tables, RLS off, Supabase default grants.
    psql(DB, [], `
      CREATE TABLE public._catalog_misfire_20260921 (lot_id uuid, prev_status text, captured_at timestamptz DEFAULT now());
      CREATE TABLE public._manifest_rows_already_lotted_20260928 (import_row_id uuid, target_lot_id uuid, kind text, row_data jsonb, captured_at timestamptz DEFAULT now());
      CREATE TABLE public._poisoned_tracking_lookups_20260924 (upc text, row_data jsonb, captured_at timestamptz DEFAULT now());
      INSERT INTO public._catalog_misfire_20260921 (lot_id, prev_status) VALUES (gen_random_uuid(), 'live');
      INSERT INTO public._manifest_rows_already_lotted_20260928 (kind, row_data) VALUES ('x', '{}');
      INSERT INTO public._poisoned_tracking_lookups_20260924 (upc, row_data) VALUES ('0', '{}');
      GRANT USAGE ON SCHEMA public TO anon, authenticated;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;`);
    const tables = ['_catalog_misfire_20260921', '_manifest_rows_already_lotted_20260928', '_poisoned_tracking_lookups_20260924'];
    for (const t of tables) assert.equal(tryAs('anon', `SELECT count(*) FROM public.${t}`), 'ok', `before: anon reads ${t} (the hole)`);
    psql(DB, ['-f', MIG]);
    for (const t of tables) {
      assert.equal(tryAs('anon', `SELECT count(*) FROM public.${t}`), 'denied', `after: anon ${t}`);
      assert.equal(tryAs('authenticated', `SELECT count(*) FROM public.${t}`), 'denied', `after: authenticated ${t}`);
      assert.equal(psql(DB, ['-c', `SELECT count(*) FROM public.${t}`]).trim(), '1', `after: owner still reads ${t}`);
      assert.equal(psql(DB, ['-c', `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${t}'::regclass`]).trim(), 't');
    }
    psql(DB, ['-f', MIG]); // rerun is harmless
    psql(DB, ['-f', ROLLBACK]);
    for (const t of tables) assert.equal(tryAs('anon', `SELECT count(*) FROM public.${t}`), 'ok', `rollback restores pre-0439 state for ${t}`);
  } finally {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB}`]);
  }
});
