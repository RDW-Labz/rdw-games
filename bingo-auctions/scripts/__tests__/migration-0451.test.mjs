// 0451: sq-ft bidding PR 1/11 — schema only (auctions.bid_mode,
// auctions.unit_start_cents, lots.unit_qty, lots.unit_label). File-shape
// checks only; the behaviour proof (apply,
// re-apply, CHECKs, row counts, timing on ~40k lots, RLS/grants, rollback)
// runs on the Docker prod copy: scripts/prod-rig/0451-rig/run.sh.
//
// Per the deny-rule on packages/db/migrations for this PR, the real file
// lives at ~/Documents/bingo-migrations-pending/0451_sqft_bid_mode_unit_qty.sql
// until the owner copies it into packages/db/migrations/. This test reads
// from the normal in-repo path by default, so it fails on purpose (ENOENT)
// until that copy happens — override SQFT0451_MIGRATION /
// SQFT0451_ROLLBACK to point at the pending-file locations for a local check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { readFileSync } from 'node:fs';

const MIG = process.env.SQFT0451_MIGRATION
  ?? new URL('../../packages/db/migrations/0451_sqft_bid_mode_unit_qty.sql', import.meta.url).pathname;
const ROLLBACK = process.env.SQFT0451_ROLLBACK
  ?? new URL('../prod-rig/0451_ROLLBACK_sqft_bid_mode_unit_qty.sql', import.meta.url).pathname;
const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

test('0451 file shape: columns, defaults, NOT VALID + VALIDATE, lock_timeout', () => {
  const raw = readFileSync(MIG, 'utf8');
  const body = code(raw);

  assert.match(raw, /^SET lock_timeout = '3s';$/m);
  assert.match(body, /^BEGIN;$/m);
  assert.match(body, /^COMMIT;$/m);

  // auctions.bid_mode
  assert.match(body, /ALTER TABLE public\.auctions\s+ADD COLUMN IF NOT EXISTS bid_mode text NOT NULL DEFAULT 'standard';/);
  assert.match(body, /ADD CONSTRAINT auctions_bid_mode_check\s+CHECK \(bid_mode IN \('standard', 'per_unit'\)\) NOT VALID;/);
  assert.match(body, /ALTER TABLE public\.auctions VALIDATE CONSTRAINT auctions_bid_mode_check;/);
  assert.match(body, /DROP CONSTRAINT IF EXISTS auctions_bid_mode_check/, 'idempotent re-apply: drop-then-add constraint');

  // auctions.unit_start_cents (owner decision 2026-10-26: per-lot start price
  // with an auction-level default)
  assert.match(body, /ALTER TABLE public\.auctions\s+ADD COLUMN IF NOT EXISTS unit_start_cents integer NULL;/);
  assert.match(body, /ADD CONSTRAINT auctions_unit_start_cents_positive\s+CHECK \(unit_start_cents IS NULL OR unit_start_cents > 0\) NOT VALID;/);
  assert.match(body, /ALTER TABLE public\.auctions VALIDATE CONSTRAINT auctions_unit_start_cents_positive;/);
  assert.match(body, /DROP CONSTRAINT IF EXISTS auctions_unit_start_cents_positive/, 'idempotent re-apply: drop-then-add constraint');
  assert.match(body, /COMMENT ON COLUMN public\.auctions\.unit_start_cents IS/);

  // lots.unit_qty
  assert.match(body, /ALTER TABLE public\.lots\s+ADD COLUMN IF NOT EXISTS unit_qty integer NULL;/);
  assert.match(body, /ADD CONSTRAINT lots_unit_qty_positive\s+CHECK \(unit_qty IS NULL OR unit_qty > 0\) NOT VALID;/);
  assert.match(body, /ALTER TABLE public\.lots VALIDATE CONSTRAINT lots_unit_qty_positive;/);
  assert.match(body, /DROP CONSTRAINT IF EXISTS lots_unit_qty_positive/);

  // lots.unit_label
  assert.match(body, /ALTER TABLE public\.lots\s+ADD COLUMN IF NOT EXISTS unit_label text NULL;/);
  assert.match(body, /ADD CONSTRAINT lots_unit_label_length\s+CHECK \(unit_label IS NULL OR length\(btrim\(unit_label\)\) BETWEEN 1 AND 20\) NOT VALID;/);
  assert.match(body, /ALTER TABLE public\.lots VALIDATE CONSTRAINT lots_unit_label_length;/);
  assert.match(body, /DROP CONSTRAINT IF EXISTS lots_unit_label_length/);

  // No behaviour change: no GRANT/REVOKE, no DML, no trigger, no function.
  assert.doesNotMatch(body, /\b(GRANT|REVOKE|INSERT INTO|UPDATE public|DELETE FROM|CREATE TRIGGER|CREATE OR REPLACE FUNCTION)\b/i);
  assert.doesNotMatch(body, /\bDO\s+\$/i, 'no DO blocks (guard lint)');

  // COMMENTs explain the no-behaviour-change story for all three columns.
  assert.match(body, /COMMENT ON COLUMN public\.auctions\.bid_mode IS/);
  assert.match(body, /COMMENT ON COLUMN public\.lots\.unit_qty IS/);
  assert.match(body, /COMMENT ON COLUMN public\.lots\.unit_label IS/);

  const { lintMigration } = require('../check-new-lot-migrations.cjs');
  const { errors, exempt } = lintMigration(raw);
  assert.deepEqual(errors, [], 'guard lint clean');
  assert.equal(exempt, null, 'no footprint-exempt header needed (ALTER TABLE is not a flagged lot mutation)');
});

test('0451 rollback drops only the three columns and their CHECKs', () => {
  const rb = code(readFileSync(ROLLBACK, 'utf8'));
  assert.match(rb, /^SET lock_timeout = '3s';$/m);
  assert.match(rb, /DROP CONSTRAINT IF EXISTS lots_unit_label_length/);
  assert.match(rb, /DROP CONSTRAINT IF EXISTS lots_unit_qty_positive/);
  assert.match(rb, /DROP COLUMN IF EXISTS unit_label/);
  assert.match(rb, /DROP COLUMN IF EXISTS unit_qty/);
  assert.match(rb, /DROP CONSTRAINT IF EXISTS auctions_unit_start_cents_positive/);
  assert.match(rb, /DROP COLUMN IF EXISTS unit_start_cents/);
  assert.match(rb, /DROP CONSTRAINT IF EXISTS auctions_bid_mode_check/);
  assert.match(rb, /DROP COLUMN IF EXISTS bid_mode/);
  assert.doesNotMatch(rb, /\b(DELETE FROM|TRUNCATE|INSERT INTO|UPDATE public|GRANT|REVOKE)\b/i, 'rollback only drops schema, no data/grant changes');
});
