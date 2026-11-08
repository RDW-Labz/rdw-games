// 0436 fill_bidder_postal_code_if_empty on a throwaway local Postgres, on top
// of 0434. Fake data only.
//
// Skipped unless ZIP0436_PG_URL is set, e.g.
//   ZIP0436_PG_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   node --test scripts/__tests__/fill-bidder-zip-0436.test.mjs
// The server needs the anon / authenticated / service_role roles (the local
// Supabase has them). The test creates its own database and drops it.
// Until they are on master, point ZIP_0434_SQL / ZIP_0436_SQL at the files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PG_URL = process.env.ZIP0436_PG_URL;
const mig = (envPath, name) =>
  [envPath, new URL(`../../packages/db/migrations/${name}`, import.meta.url).pathname].find(
    (p) => p && existsSync(p),
  );
const MIG_0434 = mig(process.env.ZIP_0434_SQL, '0434_bidder_postal_code.sql');
const MIG_0436 = mig(process.env.ZIP_0436_SQL, '0436_fill_bidder_postal_code_from_card.sql');
const ROLLBACK = new URL('../prod-rig/0436_ROLLBACK_fill_bidder_postal_code_from_card.sql', import.meta.url).pathname;

const skip = !PG_URL
  ? 'ZIP0436_PG_URL not set'
  : !MIG_0434 || !MIG_0436
    ? '0434 / 0436 file not found (set ZIP_0434_SQL / ZIP_0436_SQL)'
    : false;

const OP = '0a0a0a0a-0000-4000-8000-000000000001';
const EMPTY = '11111111-1111-4111-8111-111111111111';
const HAS_ZIP = '22222222-2222-4222-8222-222222222222';
const PLUS4 = '33333333-3333-4333-8333-333333333333';
const DELETED = '44444444-4444-4444-8444-444444444444';
const BLANKS = '55555555-5555-4555-8555-555555555555';
const MISSING = '99999999-9999-4999-8999-999999999999';

test('0436 fill_bidder_postal_code_if_empty on 0434', { skip }, () => {
  const db = `zip0436_scratch_${process.pid}`;
  const dbUrl = PG_URL.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);
  const run = (url, sql) =>
    execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const runFile = (url, sql) =>
    spawnSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-Atq', '-f', '-'], { input: sql, encoding: 'utf8' });
  const asRole = (role, sql) =>
    runFile(dbUrl, `\\set VERBOSITY verbose\nSET ROLE ${role};\n${sql}`);
  const fill = (id, zip) => {
    const r = asRole('service_role', `SELECT public.fill_bidder_postal_code_if_empty('${id}', ${zip === null ? 'NULL' : `'${zip}'`});`);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const zipOf = (id) => run(dbUrl, `SELECT coalesce(postal_code, '-') FROM public.bidders WHERE id = '${id}'`);
  const audits = (id) =>
    run(dbUrl, `SELECT count(*) FROM public.operator_audit_log WHERE action_type = 'bidder.postal_code_from_card' AND target_id = '${id}'`);

  run(PG_URL, `DROP DATABASE IF EXISTS ${db}`);
  run(PG_URL, `CREATE DATABASE ${db}`);
  try {
    // Minimal stand-ins for the tables 0434 / 0436 touch.
    const base = runFile(dbUrl, `
      CREATE TABLE public.operators (id uuid PRIMARY KEY, code text UNIQUE);
      CREATE TABLE public.bidders (id uuid PRIMARY KEY, email text, deleted_at timestamptz);
      CREATE TABLE public.operator_audit_log (
        id bigserial PRIMARY KEY, operator_id uuid NOT NULL REFERENCES public.operators(id),
        actor_user_id uuid, action_type text NOT NULL, target_id uuid,
        before_state jsonb, after_state jsonb, reason_note text,
        created_at timestamptz NOT NULL DEFAULT now());
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT ALL ON public.bidders TO service_role;
      INSERT INTO public.operators VALUES ('${OP}', 'BIN');
      INSERT INTO public.bidders (id, email, deleted_at) VALUES
        ('${EMPTY}',   'a@example.invalid', NULL),
        ('${HAS_ZIP}', 'b@example.invalid', NULL),
        ('${PLUS4}',   'c@example.invalid', NULL),
        ('${DELETED}', 'd@example.invalid', now()),
        ('${BLANKS}',  'e@example.invalid', NULL);
    `);
    assert.equal(base.status, 0, base.stderr);
    const m34 = runFile(dbUrl, readFileSync(MIG_0434, 'utf8'));
    assert.equal(m34.status, 0, m34.stderr);
    const m36 = runFile(dbUrl, readFileSync(MIG_0436, 'utf8'));
    assert.equal(m36.status, 0, m36.stderr);

    // The 0434 guard still refuses a direct service_role write...
    const direct = asRole('service_role', `UPDATE public.bidders SET postal_code = '10001' WHERE id = '${EMPTY}';`);
    assert.notEqual(direct.status, 0);
    assert.match(direct.stderr, /postal_code_via_rpc_only/);

    // HAS_ZIP set their own ZIP (as set_my_postal_code would, owner role).
    run(dbUrl, `UPDATE public.bidders SET postal_code = '72764', postal_code_updated_at = now() - interval '1 day' WHERE id = '${HAS_ZIP}'`);

    // ...but the SECURITY DEFINER function's write passes it. Empty ZIP gets filled.
    assert.equal(fill(EMPTY, '72701'), 't');
    assert.equal(zipOf(EMPTY), '72701');
    assert.equal(run(dbUrl, `SELECT postal_code_updated_at IS NOT NULL FROM public.bidders WHERE id = '${EMPTY}'`), 't');
    assert.equal(audits(EMPTY), '1');
    // Second call: already set, so false and no second audit row.
    assert.equal(fill(EMPTY, '90210'), 'f');
    assert.equal(zipOf(EMPTY), '72701');
    assert.equal(audits(EMPTY), '1');

    // An existing ZIP is not overwritten.
    assert.equal(fill(HAS_ZIP, '10001'), 'f');
    assert.equal(zipOf(HAS_ZIP), '72764');
    assert.equal(audits(HAS_ZIP), '0');

    // ZIP+4 → 5 digits (whitespace trimmed).
    assert.equal(fill(PLUS4, ' 72712-1234 '), 't');
    assert.equal(zipOf(PLUS4), '72712');

    // Deleted account and unknown bidder: false, nothing written.
    assert.equal(fill(DELETED, '72701'), 'f');
    assert.equal(zipOf(DELETED), '-');
    assert.equal(fill(MISSING, '72701'), 'f');

    // Non-US / blank / malformed: false, no write.
    for (const bad of [null, '', '   ', 'A1B 2C3', 'SW1A 1AA', '1234', '123456', '12345-67', '123456789', '12345 6789', '12a45']) {
      assert.equal(fill(BLANKS, bad), 'f', `input ${JSON.stringify(bad)}`);
    }
    assert.equal(zipOf(BLANKS), '-');
    assert.equal(audits(BLANKS), '0');

    // One audit row per fill, with the 0436 shape.
    assert.equal(
      run(dbUrl, `SELECT count(*) FROM public.operator_audit_log`),
      '2',
    );
    const row = run(dbUrl, `SELECT a.operator_id, a.actor_user_id IS NULL, a.before_state ? 'postal_code' AND a.before_state->>'postal_code' IS NULL,
        a.after_state->>'postal_code',
        (a.after_state->>'postal_code_updated_at')::timestamptz = b.postal_code_updated_at
      FROM public.operator_audit_log a JOIN public.bidders b ON b.id = a.target_id WHERE a.target_id = '${PLUS4}'`);
    assert.equal(row, `${OP}|t|t|72712|t`);

    // Grants: service_role only. authenticated and anon get 42501.
    for (const role of ['authenticated', 'anon']) {
      const r = asRole(role, `SELECT public.fill_bidder_postal_code_if_empty('${BLANKS}', '72701');`);
      assert.notEqual(r.status, 0, `${role} must not execute`);
      assert.match(r.stderr, /42501/, `${role}: ${r.stderr}`);
    }
    assert.equal(zipOf(BLANKS), '-');
    assert.equal(
      run(dbUrl, `SELECT has_function_privilege('public', 'public.fill_bidder_postal_code_if_empty(uuid, text)', 'EXECUTE')`),
      'f',
    );
    assert.equal(
      run(dbUrl, `SELECT p.prosecdef, p.proconfig::text FROM pg_proc p WHERE p.proname = 'fill_bidder_postal_code_if_empty'`),
      't|{search_path=public}',
    );

    // No BinGo operator → false, nothing written (no ZIP without its audit row).
    run(dbUrl, `ALTER TABLE public.operator_audit_log DROP CONSTRAINT operator_audit_log_operator_id_fkey; UPDATE public.operators SET code = 'XXX'`);
    assert.equal(fill(BLANKS, '72701'), 'f');
    assert.equal(zipOf(BLANKS), '-');
    run(dbUrl, `UPDATE public.operators SET code = 'BIN'`);

    // Re-running 0436 is idempotent.
    const again = runFile(dbUrl, readFileSync(MIG_0436, 'utf8'));
    assert.equal(again.status, 0, again.stderr);

    // Rollback drops the function; filled ZIPs stay.
    const rb = runFile(dbUrl, readFileSync(ROLLBACK, 'utf8'));
    assert.equal(rb.status, 0, rb.stderr);
    assert.equal(run(dbUrl, `SELECT count(*) FROM pg_proc WHERE proname = 'fill_bidder_postal_code_if_empty'`), '0');
    assert.equal(zipOf(EMPTY), '72701');
    const gone = asRole('service_role', `SELECT public.fill_bidder_postal_code_if_empty('${BLANKS}', '72701');`);
    assert.notEqual(gone.status, 0);
    assert.match(gone.stderr, /42883/);
  } finally {
    run(PG_URL, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  }
});
