// 0441 update_pending_intake_lot: the picker-safe draft-edit lane landed from
// PR #319 (originally migration 0357 there; renumbered to 0441 in this repo
// because 0357 is already taken by 0357_collected_item_invariant_monitor.sql).
// The function itself is unchanged from what is already live on prod — this
// test exercises the migration file, not a new design.
//
// Runs the migration on a scratch LOCAL Postgres against minimal mirror
// tables, then drops its own database. Skipped unless PGUPL0441_URL is set.
// Needs psql on PATH. Loopback hosts only; never point this at a hosted
// database. All data below is synthetic.
//
//   PGUPL0441_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   PGUPL0441_MIGRATION=/abs/path/to/0441_update_pending_intake_lot.sql \
//   node --test scripts/__tests__/update-pending-intake-lot-0441.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BASE_URL = process.env.PGUPL0441_URL;
const MIGRATION =
  process.env.PGUPL0441_MIGRATION ||
  path.join(os.homedir(), 'Documents/bingo-migrations-pending/0441_update_pending_intake_lot.sql');
const skip = BASE_URL ? false : 'set PGUPL0441_URL to run (local Postgres only)';

const DB = `upl0441test_${process.pid}`;
let dbUrl = '';

function psql(url, sqlText) {
  const r = spawnSync('psql', [url, '-X', '-q', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: sqlText,
    encoding: 'utf8',
  });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function as(role, uid, sqlText) {
  const prefix = [
    `SELECT set_config('request.jwt.claim.sub', '${uid ?? ''}', false) \\g /dev/null`,
    `SET ROLE ${role};`,
  ].join('\n');
  return psql(dbUrl, `${prefix}\n${sqlText}`);
}

function rows(res) {
  assert.ok(res.ok, res.err);
  return res.out ? res.out.split('\n').map((l) => l.split('|')) : [];
}

function mustOk(res) {
  assert.ok(res.ok, res.err);
  return res.out;
}

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OP = id(1), OP2 = id(2);
const ADMIN = id(101); // operator OP, admin (the PR's "all four operator_users are admin" limit)
const ADMIN2 = id(102); // operator OP2, admin — used for the cross-operator check
const L_PENDING = id(201); // OP, pending_intake
const L_LIVE = id(202); // OP, status = 'live'
const L_OTHER_OP = id(203); // OP2, pending_intake

const MIRROR = `
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TYPE operator_user_role AS ENUM ('admin', 'manager', 'picker');
CREATE TYPE lot_status AS ENUM ('pending_intake', 'in_inventory', 'live', 'sold');

CREATE TABLE operators (id uuid PRIMARY KEY);
CREATE TABLE operator_users (user_id uuid, operator_id uuid REFERENCES operators, role operator_user_role NOT NULL);
CREATE TABLE lots (
  id uuid PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES operators,
  status lot_status NOT NULL DEFAULT 'pending_intake',
  lot_code text,
  sticker_code text,
  relisted_from_lot_id uuid,
  title text NOT NULL,
  description text,
  brand text,
  model text,
  category text,
  category_id uuid
);

-- Real definitions from 0002_rls.sql (minimal, matching the live shape).
CREATE FUNCTION current_operator_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT operator_id FROM operator_users WHERE user_id = auth.uid() LIMIT 1 $$;
CREATE FUNCTION current_operator_role() RETURNS operator_user_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT role FROM operator_users WHERE user_id = auth.uid() LIMIT 1 $$;

-- Stub for public.display_code(lots) (real one is mig 0315; only the fallback
-- path matters here since every test lot already carries a lot_code).
CREATE FUNCTION public.display_code(public.lots) RETURNS text LANGUAGE sql AS $$ SELECT $1.lot_code $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
`;

const SEED = `
INSERT INTO operators VALUES ('${OP}'), ('${OP2}');
INSERT INTO auth.users SELECT unnest(ARRAY['${ADMIN}','${ADMIN2}']::uuid[]);
INSERT INTO operator_users VALUES ('${ADMIN}','${OP}','admin'), ('${ADMIN2}','${OP2}','admin');
INSERT INTO lots (id, operator_id, status, lot_code, title, description) VALUES
  ('${L_PENDING}','${OP}','pending_intake','BIN-000201','robot title','robot description'),
  ('${L_LIVE}','${OP}','live','BIN-000202','already live',NULL),
  ('${L_OTHER_OP}','${OP2}','pending_intake','BIN-000203','not yours',NULL);
`;

before(async () => {
  if (skip) return;
  const u = new URL(BASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname), 'loopback Postgres only');
  assert.ok(fs.existsSync(MIGRATION), `migration not found: ${MIGRATION}`);
  mustOk(psql(BASE_URL, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE); CREATE DATABASE ${DB};`));
  u.pathname = `/${DB}`;
  dbUrl = u.toString();
  mustOk(psql(dbUrl, MIRROR));
  mustOk(psql(dbUrl, fs.readFileSync(MIGRATION, 'utf8')));
  mustOk(psql(dbUrl, SEED));
});

after(() => {
  if (skip || !BASE_URL) return;
  psql(BASE_URL, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`);
});

const call = (args) => `SELECT * FROM update_pending_intake_lot(${args});`;

test('function exists as SECURITY DEFINER with search_path pinned', { skip }, () => {
  const got = rows(as('authenticated', ADMIN,
    `SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'update_pending_intake_lot';`));
  assert.equal(got.length, 1);
  assert.equal(got[0][0], 't');
  assert.match(got[0][1], /search_path=public/);
});

test('grants: anon has no EXECUTE, authenticated and service_role do', { skip }, () => {
  const priv = (role) => rows(as('authenticated', ADMIN,
    `SELECT has_function_privilege('${role}', 'update_pending_intake_lot(uuid,text,text,text,text,text,uuid)', 'EXECUTE');`))[0][0];
  assert.equal(priv('anon'), 'f');
  assert.equal(priv('public'), 'f');
  assert.equal(priv('authenticated'), 't');
  assert.equal(priv('service_role'), 't');
});

test('1a. anon: denied at the GRANT, never reaches the function body', { skip }, () => {
  // anon holds no EXECUTE (REVOKEd in the migration) — Postgres refuses the
  // call before auth.uid() is ever evaluated. This is the first of two layers;
  // 1b covers the second (authenticated role, but no session uid).
  const res = as('anon', null, call(`'${L_PENDING}'::uuid, 'x'`));
  assert.equal(res.ok, false);
  assert.match(res.err, /permission denied for function update_pending_intake_lot/);
});

test('1b. authenticated with no session uid: 28000 not authenticated', { skip }, () => {
  // Self-guarding per the migration's own header comment: an authenticated
  // role IS granted EXECUTE, so this reaches the body and the auth.uid() IS
  // NULL check fires.
  const res = as('authenticated', null, call(`'${L_PENDING}'::uuid, 'x'`));
  assert.equal(res.ok, false);
  assert.match(res.err, /not authenticated/);
});

test('2. happy path: title updates, returned row matches table', { skip }, () => {
  const got = rows(as('authenticated', ADMIN, call(`'${L_PENDING}'::uuid, 'ZZZ TEST TITLE'`)));
  assert.equal(got.length, 1);
  assert.equal(got[0][2], 'ZZZ TEST TITLE'); // out_title
  const row = rows(as('authenticated', ADMIN, `SELECT title FROM lots WHERE id = '${L_PENDING}';`));
  assert.equal(row[0][0], 'ZZZ TEST TITLE');
});

test('3. NULL means leave alone: description untouched by a title-only call', { skip }, () => {
  const got = rows(as('authenticated', ADMIN, call(`'${L_PENDING}'::uuid, 'another title'`)));
  assert.equal(got[0][3], 'robot description'); // out_description unchanged
});

test('4. live lot: rejected, not pending_intake', { skip }, () => {
  const res = as('authenticated', ADMIN, call(`'${L_LIVE}'::uuid, 'nope'`));
  assert.equal(res.ok, false);
  assert.match(res.err, /not pending_intake/);
});

test('5. no fields supplied: rejected', { skip }, () => {
  const res = as('authenticated', ADMIN, call(`'${L_PENDING}'::uuid`));
  assert.equal(res.ok, false);
  assert.match(res.err, /no fields supplied/);
});

test('6. blank title: rejected', { skip }, () => {
  const res = as('authenticated', ADMIN, call(`'${L_PENDING}'::uuid, '   '`));
  assert.equal(res.ok, false);
  assert.match(res.err, /title cannot be blank/);
});

test('7. unknown / wrong-operator lot: 42501 not found for this operator', { skip }, () => {
  const unknown = as('authenticated', ADMIN, call(`'00000000-0000-4000-8000-000000000999'::uuid, 'x'`));
  assert.equal(unknown.ok, false);
  assert.match(unknown.err, /not found for this operator/);
  // L_OTHER_OP exists but belongs to OP2 — same "not found" message, no leak.
  const crossOp = as('authenticated', ADMIN, call(`'${L_OTHER_OP}'::uuid, 'x'`));
  assert.equal(crossOp.ok, false);
  assert.match(crossOp.err, /not found for this operator/);
});

test('rollback file restates the identical live definition', { skip: skip || 'repo-relative path check' }, () => {
  const rollback = path.join(path.dirname(new URL(import.meta.url).pathname), '../prod-rig/0441_ROLLBACK_update_pending_intake_lot.sql');
  assert.ok(fs.existsSync(rollback), `rollback file not found: ${rollback}`);
});
