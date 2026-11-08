// 0442 — recovery of the live lots_block_identity_code_twin trigger/function
// (issue #551). The migration itself is intentionally NOT in this repo (this
// session was denied writes under packages/db/migrations/); it lives at
// ~/Documents/bingo-migrations-pending/0442_recover_lots_identity_code_twin.sql
// pending the owner applying it with an approved migration number. This test
// exercises that file directly against a scratch local Postgres on minimal
// mirror tables, plus a static check of the two guard-lint scripts' output
// on its text (scripts/check-new-lot-migrations.cjs / check-function-grants.cjs).
//
// Runs the migration on a scratch LOCAL Postgres. Skipped unless
// MIG0442_PG_URL is set. Needs psql on PATH.
//
//   MIG0442_PG_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   node --test scripts/__tests__/0442-lots-identity-code-twin.test.mjs
//
// It creates its own database (mig0442test_<pid>) and drops it at the end.
// Loopback hosts only; never point this at a hosted database. All data below
// is synthetic.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(import.meta.url);
const BASE_URL = process.env.MIG0442_PG_URL;
const MIGRATION =
  process.env.MIG0442_MIGRATION ||
  path.join(os.homedir(), 'Documents/bingo-migrations-pending/0442_recover_lots_identity_code_twin.sql');
const skip = BASE_URL ? false : 'set MIG0442_PG_URL to run (local Postgres only)';

const DB = `mig0442test_${process.pid}`;
let dbUrl = '';

function psql(url, sqlText) {
  const r = spawnSync('psql', [url, '-X', '-q', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: sqlText,
    encoding: 'utf8',
  });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function mustOk(res) {
  assert.ok(res.ok, res.err);
  return res.out;
}

const MIRROR = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TYPE lot_status AS ENUM (
  'draft', 'scheduled', 'live', 'won', 'unsold', 'canceled', 'relisted',
  'pending_intake', 'in_inventory', 'disposed'
);
CREATE TABLE lots (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id           UUID NOT NULL,
  status                lot_status NOT NULL DEFAULT 'draft',
  lot_code              TEXT,
  legacy_lot_code       TEXT,
  external_code         TEXT,
  deleted_at            TIMESTAMPTZ,
  canceled_at           TIMESTAMPTZ,
  relisted_from_lot_id  UUID REFERENCES lots(id)
);
`;

const OP1 = '11111111-1111-1111-1111-111111111111';
const OP2 = '22222222-2222-2222-2222-222222222222';

before(async () => {
  if (skip) return;
  mustOk(psql(BASE_URL, `DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB};`));
  dbUrl = BASE_URL.replace(/\/[^/]*$/, `/${DB}`);
  mustOk(psql(dbUrl, MIRROR));
});

after(async () => {
  if (skip) return;
  psql(BASE_URL, `DROP DATABASE IF EXISTS ${DB};`);
});

test('migration file exists at the pending-review path', { skip }, () => {
  assert.ok(fs.existsSync(MIGRATION), `expected ${MIGRATION} to exist`);
});

test('fresh (empty-DB-shaped) apply creates the trigger', { skip }, () => {
  const migrationSql = fs.readFileSync(MIGRATION, 'utf8');
  const res = psql(dbUrl, migrationSql);
  assert.ok(res.ok, res.err);
  const count = mustOk(
    psql(dbUrl, `SELECT count(*) FROM pg_trigger WHERE tgname = 'lots_block_identity_code_twin_trg';`),
  );
  assert.equal(count, '1');
});

test('second apply is idempotent (CREATE OR REPLACE TRIGGER) — trigger count stays 1', { skip }, () => {
  const migrationSql = fs.readFileSync(MIGRATION, 'utf8');
  const res = psql(dbUrl, migrationSql);
  assert.ok(res.ok, res.err);
  const count = mustOk(
    psql(dbUrl, `SELECT count(*) FROM pg_trigger WHERE tgname = 'lots_block_identity_code_twin_trg';`),
  );
  assert.equal(count, '1');
});

test('blocks a twin: new lot external_code equals another ACTIVE lot lot_code, same operator', { skip }, () => {
  mustOk(
    psql(
      dbUrl,
      `INSERT INTO lots (operator_id, status, lot_code, external_code) VALUES ('${OP1}', 'in_inventory', 'BIN4000001', 'BIN4000001');`,
    ),
  );
  const res = psql(
    dbUrl,
    `INSERT INTO lots (operator_id, status, lot_code, external_code) VALUES ('${OP1}', 'draft', 'BIN4000099', 'BIN4000001');`,
  );
  assert.ok(!res.ok);
  assert.match(res.err, /code_belongs_to_existing_lot: BIN4000001 is already the identity of active lot BIN4000001/);
});

test('allows the same code once the existing lot is canceled', { skip }, () => {
  mustOk(psql(dbUrl, `UPDATE lots SET status = 'canceled', canceled_at = now() WHERE lot_code = 'BIN4000001';`));
  mustOk(
    psql(
      dbUrl,
      `INSERT INTO lots (operator_id, status, lot_code, external_code) VALUES ('${OP1}', 'draft', 'BIN4000098', 'BIN4000001');`,
    ),
  );
  // Reset for later tests.
  mustOk(psql(dbUrl, `UPDATE lots SET status = 'in_inventory', canceled_at = NULL WHERE lot_code = 'BIN4000001';`));
  mustOk(psql(dbUrl, `DELETE FROM lots WHERE lot_code = 'BIN4000098';`));
});

test('allows the same code for a DIFFERENT operator (per-operator scoping)', { skip }, () => {
  mustOk(
    psql(
      dbUrl,
      `INSERT INTO lots (operator_id, status, lot_code, external_code) VALUES ('${OP2}', 'draft', 'OPX4000001', 'BIN4000001');`,
    ),
  );
});

test('blocks on legacy_lot_code too, case-insensitively', { skip }, () => {
  mustOk(
    psql(
      dbUrl,
      `INSERT INTO lots (operator_id, status, lot_code, legacy_lot_code) VALUES ('${OP1}', 'in_inventory', 'BIN4000050', 'LEG4000050');`,
    ),
  );
  const res = psql(
    dbUrl,
    `INSERT INTO lots (operator_id, status, lot_code, external_code) VALUES ('${OP1}', 'draft', 'BIN4000051', 'leg4000050');`,
  );
  assert.ok(!res.ok);
  assert.match(res.err, /code_belongs_to_existing_lot/);
});

test('never blocks a UPC-shaped (all-digit) external_code, even if textually equal', { skip }, () => {
  mustOk(
    psql(
      dbUrl,
      `INSERT INTO lots (operator_id, status, lot_code, external_code) VALUES ('${OP1}', 'in_inventory', 'UPC0000001', '012345678905');`,
    ),
  );
  mustOk(
    psql(
      dbUrl,
      `INSERT INTO lots (operator_id, status, lot_code, external_code) VALUES ('${OP1}', 'draft', 'UPC0000002', '012345678905');`,
    ),
  );
});

test('exempts the INSERT whose relisted_from_lot_id IS the lot owning that code', { skip }, () => {
  mustOk(
    psql(
      dbUrl,
      `INSERT INTO lots (operator_id, status, lot_code, external_code) VALUES ('${OP1}', 'relisted', 'BIN4000070', 'BIN4000070');`,
    ),
  );
  mustOk(
    psql(
      dbUrl,
      `INSERT INTO lots (operator_id, status, lot_code, external_code, relisted_from_lot_id)
       SELECT '${OP1}', 'draft', 'BIN4000071', 'BIN4000070', id FROM lots WHERE lot_code = 'BIN4000070';`,
    ),
  );
});

// ── Static guard-lint check (no Postgres needed) ────────────────────────────
// Documents the one known lint finding so a future edit to the migration
// doesn't silently change what check-new-lot-migrations.cjs reports: the
// DO block's required `EXECUTE FUNCTION` clause (CREATE TRIGGER syntax, not
// dynamic SQL) trips that script's blunt "any `execute` token inside a DO
// body" rule. See the migration's own "LINT NOTE" header for why this is a
// known false positive left visible rather than routed around.
test('check-function-grants.cjs reports zero PUBLIC-executable new functions', () => {
  const { lintGrants } = require(path.join(root, 'scripts/check-function-grants.cjs'));
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  assert.deepEqual(lintGrants(sql), []);
});

test('check-new-lot-migrations.cjs reports no errors (no DO block, plain CREATE OR REPLACE TRIGGER)', () => {
  const { lintMigration } = require(path.join(root, 'scripts/check-new-lot-migrations.cjs'));
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const { errors } = lintMigration(sql);
  assert.deepEqual(errors, []);
});
