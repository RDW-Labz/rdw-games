// 0434 bidder ZIP: column, guard trigger, set/snooze RPCs, location report.
//
// Runs the migration on a scratch LOCAL Postgres against minimal mirror
// tables. Skipped unless ZIP0434_PG_URL is set. Needs psql on PATH.
//
//   ZIP0434_PG_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   ZIP0434_MIGRATION=/path/to/0434_bidder_postal_code.sql \
//   node --test scripts/__tests__/bidder-zip-0434.test.mjs
//
// It creates its own database (zip0434test_<pid>) and drops it at the end.
// Loopback hosts only; never point this at a hosted database. All data below
// is synthetic.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const BASE_URL = process.env.ZIP0434_PG_URL;
const MIGRATION =
  process.env.ZIP0434_MIGRATION ||
  path.join(root, 'packages/db/migrations/0434_bidder_postal_code.sql');
const skip = BASE_URL ? false : 'set ZIP0434_PG_URL to run (local Postgres only)';

const DB = `zip0434test_${process.pid}`;
let dbUrl = '';

function psql(url, sqlText) {
  const r = spawnSync('psql', [url, '-X', '-q', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: sqlText,
    encoding: 'utf8',
  });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** Run SQL as a PostgREST role with a given auth.uid(); returns rows as arrays. */
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

// ── Fixed ids (synthetic) ─────────────────────────────────────────────────────
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OP = id(1), OP2 = id(2);
const W1 = id(11), W2 = id(12), W3 = id(13);
const A1 = id(21), A2 = id(22), A3 = id(23);
const L1 = id(31), L2 = id(32), L3 = id(33), L9 = id(39);
const S1 = id(101), S2 = id(102), S3 = id(103); // staff: OP admin, OP picker, OP2 admin
const B = (n) => id(200 + n); // bidders B1..B8
const I = (n) => id(400 + n); // invoices I1..I9
const R1 = id(301), R2 = id(302); // bidders used by the RPC tests

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
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  email text NOT NULL UNIQUE,
  display_name text,
  phone text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lots (id uuid PRIMARY KEY, operator_id uuid REFERENCES operators, auction_id uuid REFERENCES auctions);
CREATE TABLE bids (id serial PRIMARY KEY, lot_id uuid REFERENCES lots, bidder_id uuid REFERENCES bidders, placed_at timestamptz NOT NULL);
CREATE TABLE invoices (
  id uuid PRIMARY KEY, operator_id uuid REFERENCES operators, auction_id uuid REFERENCES auctions,
  bidder_id uuid REFERENCES bidders, status invoice_status NOT NULL DEFAULT 'pending',
  subtotal_cents bigint NOT NULL DEFAULT 0, buyer_premium_cents bigint NOT NULL DEFAULT 0,
  tax_cents bigint NOT NULL DEFAULT 0, total_cents bigint NOT NULL DEFAULT 0, paid_at timestamptz,
  UNIQUE (auction_id, bidder_id)
);
CREATE TABLE invoice_lots (invoice_id uuid REFERENCES invoices, lot_id uuid REFERENCES lots,
  winning_bid_cents bigint NOT NULL, refunded_at timestamptz, PRIMARY KEY (invoice_id, lot_id));

-- Real definitions from 0002_rls.sql.
CREATE FUNCTION current_operator_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT operator_id FROM operator_users WHERE user_id = auth.uid() LIMIT 1 $$;
CREATE FUNCTION current_operator_role() RETURNS operator_user_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT role FROM operator_users WHERE user_id = auth.uid() LIMIT 1 $$;

-- bidders RLS + grants as on prod (0133; Supabase grants table-level ALL).
ALTER TABLE bidders ENABLE ROW LEVEL SECURITY;
CREATE POLICY bidders_self_read ON bidders FOR SELECT USING (id = (SELECT auth.uid()));
CREATE POLICY bidders_self_insert ON bidders FOR INSERT WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY bidders_self_update ON bidders FOR UPDATE USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
`;

// ── Seed (written before 0434's ZIPs are set, then ZIPs as the owner) ─────────
// Range under test: [2026-10-01, 2026-11-01).
//
//   bidder ZIP    activity
//   B1   72712    bid L1 (A1/W1) 10-05; I1 at A1 paid 10-06, partially refunded
//   B2   72712    bid L3 (A2/W2) 10-07; I2 at A2 paid 10-08; I3 at A1 paid 10-09 then refunded in full
//   B3   72712    bid L1 on 09-15 only (before range) → no activity in range
//   B4   72764    bid L1 10-10; I4 at A1 paid 10-11
//   B5   72701    I5 at A1 paid 09-20 (before range) → no activity in range
//   B6   (none)   bid L3 (W2) 10-12, no invoice
//   B7   (none)   nothing
//   B8   (none)   I8 at A2 pending (never paid) → no activity
//   R1,R2 (none)  nothing (used by the RPC tests, which run after the report tests)
//   B1 also bids on / pays an invoice at the OTHER operator (A3/W3): never counted.
//
// ZIP sizes (non-deleted): 72712 → 3 (own group); 72764 → 1 and 72701 → 1 → both
// roll into 'Other (fewer than 3)'.
const SEED = `
INSERT INTO operators VALUES ('${OP}'), ('${OP2}');
INSERT INTO auth.users SELECT unnest(ARRAY['${S1}','${S2}','${S3}','${B(1)}','${B(2)}','${B(3)}','${B(4)}','${B(5)}','${B(6)}','${B(7)}','${B(8)}','${R1}','${R2}']::uuid[]);
INSERT INTO operator_users VALUES ('${S1}','${OP}','admin'), ('${S2}','${OP}','picker'), ('${S3}','${OP2}','admin');
INSERT INTO warehouses VALUES ('${W1}','${OP}','Bentonville'), ('${W2}','${OP}','Springdale'), ('${W3}','${OP2}','Elsewhere');
INSERT INTO auctions VALUES ('${A1}','${OP}','${W1}'), ('${A2}','${OP}','${W2}'), ('${A3}','${OP2}','${W3}');
INSERT INTO lots VALUES ('${L1}','${OP}','${A1}'), ('${L2}','${OP}','${A1}'), ('${L3}','${OP}','${A2}'), ('${L9}','${OP2}','${A3}');
INSERT INTO bidders (id, email) VALUES
  ('${B(1)}','b1@example.test'), ('${B(2)}','b2@example.test'), ('${B(3)}','b3@example.test'),
  ('${B(4)}','b4@example.test'), ('${B(5)}','b5@example.test'), ('${B(6)}','b6@example.test'),
  ('${B(7)}','b7@example.test'), ('${B(8)}','b8@example.test'),
  ('${R1}','r1@example.test'), ('${R2}','r2@example.test');
INSERT INTO bids (lot_id, bidder_id, placed_at) VALUES
  ('${L1}','${B(1)}','2026-10-05'), ('${L1}','${B(1)}','2026-10-05 01:00'),
  ('${L3}','${B(2)}','2026-10-07'),
  ('${L1}','${B(3)}','2026-09-15'),
  ('${L1}','${B(4)}','2026-10-10'),
  ('${L3}','${B(6)}','2026-10-12'),
  ('${L9}','${B(1)}','2026-10-05');
-- I1: subtotal 10000 (L1 6000 + L2 4000), premium 1500, tax 800. L2 refunded.
INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, subtotal_cents, buyer_premium_cents, tax_cents, total_cents, paid_at) VALUES
  ('${I(1)}','${OP}','${A1}','${B(1)}','partially_refunded',10000,1500,800,12300,'2026-10-06'),
  ('${I(2)}','${OP}','${A2}','${B(2)}','paid',5000,750,400,6150,'2026-10-08'),
  ('${I(3)}','${OP}','${A1}','${B(2)}','refunded',2000,300,160,2460,'2026-10-09'),
  ('${I(4)}','${OP}','${A1}','${B(4)}','paid',3000,450,240,3690,'2026-10-11'),
  ('${I(5)}','${OP}','${A1}','${B(5)}','paid',1000,150,80,1230,'2026-09-20'),
  ('${I(8)}','${OP}','${A2}','${B(8)}','pending',700,105,56,861,NULL),
  ('${I(9)}','${OP2}','${A3}','${B(1)}','paid',9999,0,0,9999,'2026-10-05');
INSERT INTO invoice_lots VALUES
  ('${I(1)}','${L1}',6000,NULL), ('${I(1)}','${L2}',4000,'2026-10-15'),
  ('${I(2)}','${L3}',5000,NULL), ('${I(3)}','${L1}',2000,NULL), ('${I(4)}','${L1}',3000,NULL),
  ('${I(5)}','${L2}',1000,NULL), ('${I(8)}','${L3}',700,NULL), ('${I(9)}','${L9}',9999,NULL);
UPDATE bidders SET postal_code = '72712' WHERE id IN ('${B(1)}','${B(2)}','${B(3)}');
UPDATE bidders SET postal_code = '72764' WHERE id = '${B(4)}';
UPDATE bidders SET postal_code = '72701' WHERE id = '${B(5)}';
`;

const FROM = `'2026-10-01'::timestamptz`;
const TO = `'2026-11-01'::timestamptz`;
const report = (extra = '') =>
  `SELECT postal_code, warehouse_name, registered, active_bidders, buyers, paid_invoices, sales_net_cents
     FROM operator_bidder_location_summary(${FROM}, ${TO}${extra});`;

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

// ── Report ────────────────────────────────────────────────────────────────────

test('report: ZIP groups, roll-up, Unknown, tax and refunds excluded', { skip }, () => {
  const got = rows(as('authenticated', S1, report()));
  // Hand-worked (range October 2026, operator OP only):
  //  72712 / Bentonville: B1 (bid + I1) and B2 (I3) → registered 2, active 1 (B1),
  //    buyers 2, invoices 2.
  //    I1 net = 10000 + 1500 − refunded L2 (4000 + round(1500×4000/10000)=600)
  //           = 11500 − 4600 = 6900 (tax 800 never added).
  //    I3 is status 'refunded' → 0.   Row sales = 6900.
  //  72712 / Springdale: B2 (bid L3 + I2) → 1,1,1,1; I2 = 5000 + 750 = 5750.
  //  72712 / No activity: B3 (only bid was 09-15) → registered 1.
  //  Other / Bentonville: B4 (72764, alone) → 1,1,1,1; I4 = 3000 + 450 = 3450.
  //  Other / No activity: B5 (72701, paid 09-20, out of range) → 1.
  //  Unknown / Springdale: B6 bid only → 1,1,0,0,0.
  //  Unknown / No activity: B7, B8 (pending invoice is not a sale), R1, R2 → 4.
  //  OP2's lot L9 / invoice 9 never appear.
  assert.deepEqual(got, [
    ['72712', 'Bentonville', '2', '1', '2', '2', '6900'],
    ['72712', 'Springdale', '1', '1', '1', '1', '5750'],
    ['72712', 'No activity in range', '1', '0', '0', '0', '0'],
    ['Other (fewer than 3)', 'Bentonville', '1', '1', '1', '1', '3450'],
    ['Other (fewer than 3)', 'No activity in range', '1', '0', '0', '0', '0'],
    ['Unknown', 'Springdale', '1', '1', '0', '0', '0'],
    ['Unknown', 'No activity in range', '4', '0', '0', '0', '0'],
  ]);
  // No row carries a ZIP with fewer than 3 bidders.
  assert.ok(!got.some((r) => r[0] === '72764' || r[0] === '72701'));
});

test('report: warehouse filter keeps only that location (no idle rows)', { skip }, () => {
  const got = rows(as('authenticated', S1, report(`, '${W1}'::uuid`)));
  assert.deepEqual(got, [
    ['72712', 'Bentonville', '2', '1', '2', '2', '6900'],
    ['Other (fewer than 3)', 'Bentonville', '1', '1', '1', '1', '3450'],
  ]);
  const ids = rows(as('authenticated', S1,
    `SELECT DISTINCT warehouse_id FROM operator_bidder_location_summary(${FROM}, ${TO}, '${W1}'::uuid);`));
  assert.deepEqual(ids, [[W1]]);
});

test('report: ZIP prefix filter; Unknown drops out; bad prefix refused', { skip }, () => {
  // '7276' → only B4 (72764), who is still rolled up (1 bidder in that ZIP).
  assert.deepEqual(rows(as('authenticated', S1, report(`, NULL, '7276'`))), [
    ['Other (fewer than 3)', 'Bentonville', '1', '1', '1', '1', '3450'],
  ]);
  assert.deepEqual(rows(as('authenticated', S1, report(`, NULL, '72712'`))).map((r) => r[0]),
    ['72712', '72712', '72712']);
  const bad = as('authenticated', S1, report(`, NULL, '7%'`));
  assert.equal(bad.ok, false);
  assert.match(bad.err, /invalid_zip_prefix/);
});

test('report: only admin/manager of the operator; anon refused', { skip }, () => {
  const picker = as('authenticated', S2, report());
  assert.equal(picker.ok, false);
  assert.match(picker.err, /bidder_location_forbidden/);
  const bidder = as('authenticated', B(1), report());
  assert.equal(bidder.ok, false);
  assert.match(bidder.err, /bidder_location_forbidden/);
  // OP2's admin cannot pass OP's warehouse.
  const other = as('authenticated', S3, report(`, '${W1}'::uuid`));
  assert.equal(other.ok, false);
  assert.match(other.err, /bidder_location_forbidden/);
  // OP2's admin sees only OP2: B1's invoice 9 (9999, no premium) at Elsewhere;
  // idle rows still list the (global) bidders with no OP2 activity.
  const op2 = rows(as('authenticated', S3, report(`, '${W3}'::uuid`)));
  assert.deepEqual(op2, [['72712', 'Elsewhere', '1', '1', '1', '1', '9999']]);
  const anon = as('anon', null, report());
  assert.equal(anon.ok, false);
  assert.match(anon.err, /permission denied for function operator_bidder_location_summary/);
});

test('coverage: each registered bidder once; admin/manager only', { skip }, () => {
  // Non-deleted bidders: B1..B8, R1, R2 = 10. With a ZIP: B1..B5 = 5.
  assert.deepEqual(rows(as('authenticated', S1, `SELECT * FROM operator_bidder_zip_coverage();`)), [['10', '5']]);
  assert.match(as('authenticated', S2, `SELECT * FROM operator_bidder_zip_coverage();`).err, /bidder_location_forbidden/);
  assert.match(as('authenticated', B(1), `SELECT * FROM operator_bidder_zip_coverage();`).err, /bidder_location_forbidden/);
  assert.match(as('anon', null, `SELECT * FROM operator_bidder_zip_coverage();`).err,
    /permission denied for function operator_bidder_zip_coverage/);
});

test('coverage vs summed rows: one bidder at two locations', { skip }, () => {
  // Inside a rolled-back transaction, keep only B2 (72712): bid at Springdale +
  // I2 at Springdale, and I3 at Bentonville. B2 has activity at BOTH locations,
  // so the summary lists B2 on two rows (registered 1 + 1 = 2), while the
  // coverage function counts B2 once (registered 1, with_zip 1).
  const out = mustOk(psql(dbUrl, `
    BEGIN;
    DELETE FROM invoice_lots WHERE invoice_id IN (SELECT id FROM invoices WHERE bidder_id <> '${B(2)}');
    DELETE FROM invoices WHERE bidder_id <> '${B(2)}';
    DELETE FROM bids WHERE bidder_id <> '${B(2)}';
    DELETE FROM bidders WHERE id <> '${B(2)}';
    SELECT set_config('request.jwt.claim.sub', '${S1}', true) \\g /dev/null
    SET LOCAL ROLE authenticated;
    SELECT 'sum', sum(registered), count(*) FROM operator_bidder_location_summary(${FROM}, ${TO});
    SELECT 'cov', registered, with_zip FROM operator_bidder_zip_coverage();
    ROLLBACK;`));
  assert.deepEqual(out.split('\n'), ['sum|2|2', 'cov|1|1']);
});

// ── set_my_postal_code / snooze / guard ──────────────────────────────────────

const zipOf = (uid) =>
  mustOk(psql(dbUrl, `SELECT coalesce(postal_code, '<null>') FROM bidders WHERE id = '${uid}';`));

test('set_my_postal_code: valid (trimmed), invalid, empty and NULL clear', { skip }, () => {
  mustOk(as('authenticated', R1, `SELECT set_my_postal_code('  72762 ');`));
  assert.equal(zipOf(R1), '72762');
  assert.equal(
    mustOk(psql(dbUrl, `SELECT postal_code_updated_at > now() - interval '1 minute' FROM bidders WHERE id = '${R1}';`)),
    't',
  );
  for (const bad of ['7276', '727621', 'abcde', '72-62', '72 62']) {
    const r = as('authenticated', R1, `SELECT set_my_postal_code('${bad}');`);
    assert.equal(r.ok, false, bad);
    assert.match(r.err, /invalid_postal_code/);
  }
  const code = as('authenticated', R1,
    `DO $$ BEGIN PERFORM set_my_postal_code('x'); EXCEPTION WHEN others THEN RAISE NOTICE 'code=%', SQLSTATE; END $$;`);
  assert.match(code.err, /code=22023/);
  assert.equal(zipOf(R1), '72762', 'a refused value leaves the ZIP alone');
  mustOk(as('authenticated', R1, `SELECT set_my_postal_code('');`));
  assert.equal(zipOf(R1), '<null>');
  mustOk(as('authenticated', R1, `SELECT set_my_postal_code('72762');`));
  mustOk(as('authenticated', R1, `SELECT set_my_postal_code(NULL);`));
  assert.equal(zipOf(R1), '<null>');
});

test('a bidder edits only their own ZIP; direct writes are refused', { skip }, () => {
  mustOk(as('authenticated', R2, `SELECT set_my_postal_code('72703');`));
  mustOk(as('authenticated', R1, `SELECT set_my_postal_code('72762');`));
  assert.equal(zipOf(R2), '72703', "R1's call did not touch R2");
  // Direct UPDATE of another bidder's row: RLS → 0 rows.
  assert.equal(
    mustOk(as('authenticated', R1,
      `WITH u AS (UPDATE bidders SET display_name = 'x' WHERE id = '${R2}' RETURNING 1) SELECT count(*) FROM u;`)),
    '0',
  );
  // Direct UPDATE of their own ZIP: guard trigger.
  const own = as('authenticated', R1, `UPDATE bidders SET postal_code = '11111' WHERE id = '${R1}';`);
  assert.equal(own.ok, false);
  assert.match(own.err, /postal_code_via_rpc_only/);
  const cnt = as('authenticated', R1, `UPDATE bidders SET postal_code_prompt_count = 99 WHERE id = '${R1}';`);
  assert.match(cnt.err, /postal_code_via_rpc_only/);
  // Other self-updates keep working (profile/edit.tsx pattern).
  mustOk(as('authenticated', R1, `UPDATE bidders SET display_name = 'Tester', phone = '+15550000000' WHERE id = '${R1}';`));
  // Staff/operator paths: service role cannot write a ZIP either.
  const svc = as('service_role', null, `UPDATE bidders SET postal_code = '11111' WHERE id = '${R2}';`);
  assert.match(svc.err, /postal_code_via_rpc_only/);
  const ins = as('service_role', null,
    `INSERT INTO auth.users VALUES ('${id(399)}'); INSERT INTO bidders (id, email, postal_code) VALUES ('${id(399)}', 'n@example.test', '72712');`);
  assert.match(ins.err, /postal_code_via_rpc_only|permission denied/);
  // A staff account (no bidder row) calling the RPC changes nothing.
  const staff = as('authenticated', S1, `SELECT set_my_postal_code('11111');`);
  assert.match(staff.err, /bidder_not_found/);
  assert.equal(zipOf(R2), '72703');
  assert.equal(zipOf(R1), '72762');
});

test('snooze: count + 1 and hidden for 30 days, caller only', { skip }, () => {
  mustOk(as('authenticated', R1, `SELECT snooze_my_postal_code_prompt();`));
  const q = (uid) =>
    rows(psql(dbUrl, `SELECT postal_code_prompt_count,
        postal_code_prompt_after BETWEEN now() + interval '30 days' - interval '1 minute' AND now() + interval '30 days'
      FROM bidders WHERE id = '${uid}';`))[0];
  assert.deepEqual(q(R1), ['1', 't']);
  mustOk(as('authenticated', R1, `SELECT snooze_my_postal_code_prompt();`));
  assert.deepEqual(q(R1), ['2', 't']);
  assert.equal(rows(psql(dbUrl, `SELECT postal_code_prompt_count, postal_code_prompt_after IS NULL FROM bidders WHERE id = '${R2}';`))[0].join(), '0,t');
});

test('anon cannot call the bidder RPCs', { skip }, () => {
  const a = as('anon', null, `SELECT set_my_postal_code('72712');`);
  assert.match(a.err, /permission denied for function set_my_postal_code/);
  const b = as('anon', null, `SELECT snooze_my_postal_code_prompt();`);
  assert.match(b.err, /permission denied for function snooze_my_postal_code_prompt/);
  // Signed-in role with no uid (expired JWT edge): refused, nothing written.
  const c = as('authenticated', null, `SELECT set_my_postal_code('72712');`);
  assert.match(c.err, /not_authenticated/);
});

test('CHECK constraint holds even for the table owner', { skip }, () => {
  const r = psql(dbUrl, `UPDATE bidders SET postal_code = '1234' WHERE id = '${R1}';`);
  assert.equal(r.ok, false);
  assert.match(r.err, /bidders_postal_code_format/);
});

test('account deletion clears the ZIP', { skip }, () => {
  mustOk(as('service_role', null, `UPDATE bidders SET deleted_at = now() WHERE id = '${R2}';`));
  assert.equal(zipOf(R2), '<null>');
});
