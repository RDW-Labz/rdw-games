// 0438 zip_reference + operator_bidder_location_summary_by_place +
// operator_bidder_places, on a throwaway LOCAL Postgres, on top of 0434.
// Synthetic data only (no customer data; ZIP/city pairs are public places).
//
// Skipped unless ZIP0438_PG_URL is set, e.g.
//   ZIP0438_PG_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   ZIP_0434_SQL=/path/to/0434_bidder_postal_code.sql \
//   ZIP_0438_SQL=/path/to/0438_zip_reference.sql \
//   node --test scripts/__tests__/zip-reference-0438.test.mjs
// Until the migrations are on master, point ZIP_0434_SQL / ZIP_0438_SQL at
// the files. The server needs the anon / authenticated / service_role roles
// (the local Supabase has them). Creates its own database and drops it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const PG_URL = process.env.ZIP0438_PG_URL;
const mig = (envPath, name) =>
  [envPath, new URL(`../../packages/db/migrations/${name}`, import.meta.url).pathname].find((p) => p && existsSync(p));
const MIG_0434 = mig(process.env.ZIP_0434_SQL, '0434_bidder_postal_code.sql');
const MIG_0438 = mig(process.env.ZIP_0438_SQL, '0438_zip_reference.sql');
const ROLLBACK = new URL('../prod-rig/0438_ROLLBACK_zip_reference.sql', import.meta.url).pathname;
const skip = !PG_URL
  ? 'ZIP0438_PG_URL not set'
  : !MIG_0434 || !MIG_0438
    ? '0434 / 0438 file not found (set ZIP_0434_SQL / ZIP_0438_SQL)'
    : false;

const DB = `zip0438test_${process.pid}`;
let dbUrl = '';

function psql(url, sqlText) {
  const r = spawnSync('psql', [url, '-X', '-q', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: sqlText,
    encoding: 'utf8',
  });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function as(role, uid, sqlText) {
  return psql(dbUrl, `SELECT set_config('request.jwt.claim.sub', '${uid ?? ''}', false) \\g /dev/null\nSET ROLE ${role};\n${sqlText}`);
}
function rows(res) {
  assert.ok(res.ok, res.err);
  return res.out ? res.out.split('\n').map((l) => l.split('|')) : [];
}
const mustOk = (res) => {
  assert.ok(res.ok, res.err);
  return res.out;
};

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OP = id(1);
const W1 = id(11);
const A1 = id(21);
const L1 = id(31);
const ADMIN = id(101), PICKER = id(102);
const B = (n) => id(200 + n);

const MIRROR = `
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TYPE operator_user_role AS ENUM ('admin', 'manager', 'picker');
CREATE TYPE invoice_status AS ENUM ('pending', 'paid', 'refunded', 'partially_refunded', 'canceled');
CREATE TABLE operators (id uuid PRIMARY KEY);
CREATE TABLE operator_users (user_id uuid, operator_id uuid REFERENCES operators, role operator_user_role NOT NULL);
CREATE TABLE warehouses (id uuid PRIMARY KEY, operator_id uuid REFERENCES operators, name text NOT NULL);
CREATE TABLE auctions (id uuid PRIMARY KEY, operator_id uuid REFERENCES operators, warehouse_id uuid NOT NULL REFERENCES warehouses);
CREATE TABLE bidders (
  id uuid PRIMARY KEY REFERENCES auth.users(id), email text NOT NULL UNIQUE, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE lots (id uuid PRIMARY KEY, operator_id uuid REFERENCES operators, auction_id uuid REFERENCES auctions);
CREATE TABLE bids (id serial PRIMARY KEY, lot_id uuid REFERENCES lots, bidder_id uuid REFERENCES bidders, placed_at timestamptz NOT NULL);
CREATE TABLE invoices (
  id uuid PRIMARY KEY, operator_id uuid REFERENCES operators, auction_id uuid REFERENCES auctions,
  bidder_id uuid REFERENCES bidders, status invoice_status NOT NULL DEFAULT 'pending',
  subtotal_cents bigint NOT NULL DEFAULT 0, buyer_premium_cents bigint NOT NULL DEFAULT 0,
  tax_cents bigint NOT NULL DEFAULT 0, total_cents bigint NOT NULL DEFAULT 0, paid_at timestamptz,
  UNIQUE (auction_id, bidder_id));
CREATE TABLE invoice_lots (invoice_id uuid REFERENCES invoices, lot_id uuid REFERENCES lots,
  winning_bid_cents bigint NOT NULL, refunded_at timestamptz, PRIMARY KEY (invoice_id, lot_id));
CREATE FUNCTION current_operator_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT operator_id FROM operator_users WHERE user_id = auth.uid() LIMIT 1 $$;
CREATE FUNCTION current_operator_role() RETURNS operator_user_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT role FROM operator_users WHERE user_id = auth.uid() LIMIT 1 $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
-- Supabase's default privileges: every NEW table is granted to the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
`;

// Bidders and ZIPs (non-deleted counts):
//   72764 Springdale AR ×3 (B1..B3)  → own group
//   72762 Springdale AR ×1 (B4)      → Other   (Springdale city total 4)
//   72701 Fayetteville AR ×2 (B5,B6) → Other   (Fayetteville total 2 → filter returns nothing)
//   65801 Springfield MO ×3 (B7..B9) → own group (MO total 3)
//   99999 not in zip_reference ×3 (B10..B12) → own group, city/state NULL
//   no ZIP ×2 (B13,B14) → Unknown;  B15 deleted (ZIP cleared by 0434) → Unknown via activity only
// AR total = 3 + 1 + 2 = 6.
// Activity in Oct 2026 at W1: B1 bid; B4 bid; B7 paid invoice 1000 + 150 premium.
const SEED = `
INSERT INTO operators VALUES ('${OP}');
INSERT INTO auth.users SELECT unnest(ARRAY['${ADMIN}','${PICKER}',${Array.from({ length: 15 }, (_, i) => `'${B(i + 1)}'`).join(',')}]::uuid[]);
INSERT INTO operator_users VALUES ('${ADMIN}','${OP}','admin'), ('${PICKER}','${OP}','picker');
INSERT INTO warehouses VALUES ('${W1}','${OP}','Harrison');
INSERT INTO auctions VALUES ('${A1}','${OP}','${W1}');
INSERT INTO lots VALUES ('${L1}','${OP}','${A1}');
INSERT INTO bidders (id, email) SELECT u, 'b' || n || '@example.test'
  FROM unnest(ARRAY[${Array.from({ length: 15 }, (_, i) => `'${B(i + 1)}'`).join(',')}]::uuid[]) WITH ORDINALITY AS t(u, n);
INSERT INTO bids (lot_id, bidder_id, placed_at) VALUES ('${L1}','${B(1)}','2026-10-05'), ('${L1}','${B(4)}','2026-10-06');
INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, subtotal_cents, buyer_premium_cents, tax_cents, total_cents, paid_at)
  VALUES ('${id(401)}','${OP}','${A1}','${B(7)}','paid',1000,150,80,1230,'2026-10-07');
INSERT INTO invoice_lots VALUES ('${id(401)}','${L1}',1000,NULL);
`;
// ZIPs are set as the owner (0434's guard only stops the PostgREST roles).
const ZIPS = `
UPDATE bidders SET postal_code = '72764' WHERE id IN ('${B(1)}','${B(2)}','${B(3)}');
UPDATE bidders SET postal_code = '72762' WHERE id = '${B(4)}';
UPDATE bidders SET postal_code = '72701' WHERE id IN ('${B(5)}','${B(6)}');
UPDATE bidders SET postal_code = '65801' WHERE id IN ('${B(7)}','${B(8)}','${B(9)}');
UPDATE bidders SET postal_code = '99999' WHERE id IN ('${B(10)}','${B(11)}','${B(12)}');
UPDATE bidders SET postal_code = '72764' WHERE id = '${B(15)}';
UPDATE bidders SET deleted_at = '2026-10-02' WHERE id = '${B(15)}';
`;
const REF = `
INSERT INTO zip_reference (postal_code, city, state, county, lat, lon) VALUES
  ('72764','Springdale','AR','Washington',36.1856,-94.0870),
  ('72762','Springdale','AR','Washington',36.1800,-94.2000),
  ('72701','Fayetteville','AR','Washington',36.0800,-94.1600),
  ('65801','Springfield','MO','Greene',37.2100,-93.2900),
  ('10001','New York','NY','New York',40.7500,-73.9970);
`;

const FROM = `'2026-10-01'::timestamptz`;
const TO = `'2026-11-01'::timestamptz`;
const COLS = 'postal_code, city, state, warehouse_name, registered, active_bidders, buyers, paid_invoices, sales_net_cents';
const byPlace = (extra = '') => `SELECT ${COLS} FROM operator_bidder_location_summary_by_place(${FROM}, ${TO}${extra});`;

before(() => {
  if (skip) return;
  const u = new URL(PG_URL);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname), 'loopback Postgres only');
  mustOk(psql(PG_URL, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE); CREATE DATABASE ${DB};`));
  u.pathname = `/${DB}`;
  dbUrl = u.toString();
  mustOk(psql(dbUrl, MIRROR));
  mustOk(psql(dbUrl, readFileSync(MIG_0434, 'utf8')));
  mustOk(psql(dbUrl, SEED));
  mustOk(psql(dbUrl, ZIPS));
  mustOk(psql(dbUrl, readFileSync(MIG_0438, 'utf8')));
  mustOk(psql(dbUrl, REF));
});
after(() => {
  if (skip || !PG_URL) return;
  psql(PG_URL, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`);
});

test('0438 lints: grants lint (REVOKE FROM PUBLIC per function), no lot writes', { skip: !MIG_0438 }, () => {
  const sql = readFileSync(MIG_0438, 'utf8');
  const req = createRequire(import.meta.url);
  assert.deepEqual(req('../check-new-lot-migrations.cjs').lintMigration(sql).errors, []);
  const grants = req('../check-function-grants.cjs');
  const lint = grants.lintGrants ?? grants.lintFunctionGrants;
  if (lint) assert.deepEqual(lint(sql), []);
  assert.match(sql, /CC BY 4\.0|Creative Commons Attribution 4\.0/);
  assert.match(sql, /geonames\.org/);
});

test('no filters: identical to 0434 (rows, roll-up, order), plus city/state', { skip }, () => {
  const old = rows(as('authenticated', ADMIN,
    `SELECT postal_code, warehouse_name, registered, active_bidders, buyers, paid_invoices, sales_net_cents FROM operator_bidder_location_summary(${FROM}, ${TO});`));
  const got = rows(as('authenticated', ADMIN, byPlace()));
  assert.deepEqual(got.map((r) => [r[0], ...r.slice(3)]), old);
  assert.deepEqual(got, [
    ['65801', 'Springfield', 'MO', 'Harrison', '1', '0', '1', '1', '1150'],
    ['65801', 'Springfield', 'MO', 'No activity in range', '2', '0', '0', '0', '0'],
    ['72764', 'Springdale', 'AR', 'Harrison', '1', '1', '0', '0', '0'],
    ['72764', 'Springdale', 'AR', 'No activity in range', '2', '0', '0', '0', '0'],
    ['99999', '', '', 'No activity in range', '3', '0', '0', '0', '0'],
    ['Other (fewer than 3)', '', '', 'Harrison', '1', '1', '0', '0', '0'],
    ['Other (fewer than 3)', '', '', 'No activity in range', '2', '0', '0', '0', '0'],
    ['Unknown', '', '', 'No activity in range', '2', '0', '0', '0', '0'],
  ]);
  // with a ZIP prefix too
  const oldP = rows(as('authenticated', ADMIN,
    `SELECT postal_code, warehouse_name, registered FROM operator_bidder_location_summary(${FROM}, ${TO}, NULL, '727');`));
  const gotP = rows(as('authenticated', ADMIN,
    `SELECT postal_code, warehouse_name, registered FROM operator_bidder_location_summary_by_place(${FROM}, ${TO}, NULL, '727');`));
  assert.deepEqual(gotP, oldP);
});

test('city filter: roll-up stays BEFORE the filter (72762 stays in Other)', { skip }, () => {
  // Springdale has 4 bidders: 72764 ×3 by name, 72762 ×1 stays rolled up.
  assert.deepEqual(rows(as('authenticated', ADMIN, byPlace(`, NULL, NULL, 'ar', '  springdale '`))), [
    ['72764', 'Springdale', 'AR', 'Harrison', '1', '1', '0', '0', '0'],
    ['72764', 'Springdale', 'AR', 'No activity in range', '2', '0', '0', '0', '0'],
    ['Other (fewer than 3)', '', '', 'Harrison', '1', '1', '0', '0', '0'],
  ]);
});

test('state filter; unlisted ZIP and Unknown drop out', { skip }, () => {
  const ar = rows(as('authenticated', ADMIN, byPlace(`, NULL, NULL, 'AR'`)));
  assert.deepEqual(ar, [
    ['72764', 'Springdale', 'AR', 'Harrison', '1', '1', '0', '0', '0'],
    ['72764', 'Springdale', 'AR', 'No activity in range', '2', '0', '0', '0', '0'],
    ['Other (fewer than 3)', '', '', 'Harrison', '1', '1', '0', '0', '0'],
    ['Other (fewer than 3)', '', '', 'No activity in range', '2', '0', '0', '0', '0'],
  ]);
  assert.ok(!ar.some((r) => r[0] === '99999' || r[0] === 'Unknown'));
  assert.deepEqual(rows(as('authenticated', ADMIN, byPlace(`, NULL, NULL, 'MO'`))).map((r) => r[0]), ['65801', '65801']);
});

test('a city or state with fewer than 3 bidders returns no rows', { skip }, () => {
  assert.deepEqual(rows(as('authenticated', ADMIN, byPlace(`, NULL, NULL, 'AR', 'Fayetteville'`))), []); // 2 bidders
  assert.deepEqual(rows(as('authenticated', ADMIN, byPlace(`, NULL, NULL, 'NY'`))), []); // 0 bidders
  assert.deepEqual(rows(as('authenticated', ADMIN, byPlace(`, NULL, NULL, 'MO', 'Springdale'`))), []); // wrong state
});

test('bad input refused: city without state, bad state', { skip }, () => {
  const noState = as('authenticated', ADMIN, byPlace(`, NULL, NULL, NULL, 'Springdale'`));
  assert.equal(noState.ok, false);
  assert.match(noState.err, /invalid_city/);
  const badState = as('authenticated', ADMIN, byPlace(`, NULL, NULL, 'A1'`));
  assert.equal(badState.ok, false);
  assert.match(badState.err, /invalid_state/);
});

test('operator_bidder_places: only states / cities with >= 3 bidders', { skip }, () => {
  assert.deepEqual(rows(as('authenticated', ADMIN, 'SELECT * FROM operator_bidder_places();')), [
    ['AR', '', '6'],
    ['AR', 'Springdale', '4'],
    ['MO', '', '3'],
    ['MO', 'Springfield', '3'],
  ]);
});

test('access: admin/manager only; anon cannot read the table or call the functions', { skip }, () => {
  for (const q of [byPlace(), 'SELECT * FROM operator_bidder_places();']) {
    const picker = as('authenticated', PICKER, q);
    assert.equal(picker.ok, false);
    assert.match(picker.err, /bidder_location_forbidden/);
    const anon = as('anon', null, q);
    assert.equal(anon.ok, false);
    assert.match(anon.err, /permission denied/);
  }
  const anonRead = as('anon', null, 'SELECT count(*) FROM zip_reference;');
  assert.equal(anonRead.ok, false);
  assert.match(anonRead.err, /permission denied/);
});

test('zip_reference: authenticated reads, only service_role writes', { skip }, () => {
  assert.equal(mustOk(as('authenticated', B(1), 'SELECT count(*) FROM zip_reference;')), '5');
  const w = as('authenticated', ADMIN, `INSERT INTO zip_reference (postal_code, city, state) VALUES ('72712','Bentonville','AR');`);
  assert.equal(w.ok, false);
  assert.match(w.err, /permission denied/);
  const u = as('authenticated', ADMIN, `UPDATE zip_reference SET city = 'X';`);
  assert.equal(u.ok, false);
  mustOk(as('service_role', null,
    `INSERT INTO zip_reference (postal_code, city, state) VALUES ('72712','Bentonville','AR')
       ON CONFLICT (postal_code) DO UPDATE SET city = EXCLUDED.city;
     DELETE FROM zip_reference WHERE postal_code = '72712';`));
  const bad = as('service_role', null, `INSERT INTO zip_reference (postal_code, city, state) VALUES ('7271','X','AR');`);
  assert.equal(bad.ok, false, 'ZIP format checked');
});

test('rollback drops the table and both functions; 0434 keeps working; rerun of 0438 after that is clean', { skip }, () => {
  mustOk(psql(dbUrl, readFileSync(ROLLBACK, 'utf8')));
  assert.equal(mustOk(psql(dbUrl, `SELECT count(*) FROM pg_proc WHERE proname IN ('operator_bidder_location_summary_by_place','operator_bidder_places');`)), '0');
  assert.equal(mustOk(psql(dbUrl, `SELECT to_regclass('public.zip_reference') IS NULL;`)), 't');
  assert.ok(rows(as('authenticated', ADMIN, `SELECT * FROM operator_bidder_location_summary(${FROM}, ${TO});`)).length > 0);
  mustOk(psql(dbUrl, readFileSync(MIG_0438, 'utf8')));
  mustOk(psql(dbUrl, readFileSync(MIG_0438, 'utf8'))); // rerun is idempotent
  assert.equal(mustOk(psql(dbUrl, 'SELECT count(*) FROM zip_reference;')), '0');
});
