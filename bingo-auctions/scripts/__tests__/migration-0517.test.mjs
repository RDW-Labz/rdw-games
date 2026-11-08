// 0517: additive bidder_credits buckets. File-shape checks that fail on the
// pre-fix rollback (reason-only refusal) and on a gated/missing append-only
// trigger. SQL behaviour is packages/db/test/bidder_credits_buckets.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url).pathname;
const MIG = join(root, 'packages/db/migrations/0517_bidder_credits_buckets.sql');
const ROLLBACK = join(root, 'scripts/prod-rig/0517_ROLLBACK_bidder_credits_buckets.sql');
const SQL_TEST = join(root, 'packages/db/test/bidder_credits_buckets.sql');
const MIG_0229 = join(root, 'packages/db/migrations/0229_referral_credits.sql');
const DEL_0089 = join(root, 'packages/db/migrations/0089_account_deletion.sql');
const DEL_0092 = join(root, 'packages/db/migrations/0092_delete_my_account_reorder.sql');

const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

const REFUSE_WHERE = `WHERE reason NOT IN (
       'referral_earn', 'referral_welcome', 'spend', 'spend_reversal',
       'manual', 'loyalty_redeem', 'promo', 'refund_return'
     )
        OR bucket IS NOT NULL
        OR spend_credit_cents IS NOT NULL
        OR spend_cash_cents IS NOT NULL
        OR owner_kind IS DISTINCT FROM 'bidder'
        OR business_id IS NOT NULL`;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.turbo') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

test('0517 rollback refuses cash-bucket, business-owned, and split-spend data', () => {
  const rb = readFileSync(ROLLBACK, 'utf8');
  const live = code(rb);
  const doBlock = rb.match(/DO \$\$[\s\S]*?END \$\$;/)?.[0] ?? '';
  assert.match(doBlock, /IF EXISTS/);
  assert.ok(doBlock.includes(REFUSE_WHERE), 'rollback DO block must use the expanded refusal WHERE');
  // DROP COLUMN lines mention bucket / spend_* / owner_kind, so a naive
  // /bucket/ match would pass the pre-fix script. The refusal predicate
  // must be the thing that names those columns.
  const refuseAt = doBlock.indexOf('bucket IS NOT NULL');
  const dropAt = live.indexOf('DROP COLUMN IF EXISTS bucket');
  assert.ok(refuseAt >= 0, 'refusal must name bucket IS NOT NULL');
  assert.ok(dropAt > 0, 'rollback still drops bucket after the guard');
  assert.ok(
    rb.indexOf('bucket IS NOT NULL') < rb.indexOf('DROP COLUMN IF EXISTS bucket'),
    'refusal must run before DROP COLUMN',
  );
  assert.match(doBlock, /spend_credit_cents IS NOT NULL/);
  assert.match(doBlock, /spend_cash_cents IS NOT NULL/);
  assert.match(doBlock, /owner_kind IS DISTINCT FROM 'bidder'/);
  assert.match(doBlock, /business_id IS NOT NULL/);
  assert.match(doBlock, /wallet or business funds as bidder credit/);
  assert.doesNotMatch(doBlock, /DROP COLUMN/);
});

test('0517 SQL test pins the same refusal predicate and the reason-only gap', () => {
  const sql = readFileSync(SQL_TEST, 'utf8');
  assert.ok(sql.includes(REFUSE_WHERE), 'SQL test must use the same expanded refusal WHERE');
  assert.match(sql, /rollback must refuse cash-bucket manual grant/);
  assert.match(sql, /rollback must refuse business-owned grant/);
  assert.match(sql, /rollback must refuse split spend columns/);
  assert.match(sql, /cash-bucket manual must keep a legacy reason/);
  assert.match(sql, /CASCADE silently deleted ledger rows/);
  assert.match(sql, /SET NULL silently rewrote invoice_id/);
  assert.match(sql, /bidder_credits has unexpected foreign keys/);
  assert.match(sql, /delete_my_account must not touch bidder_credits/);
});

test('0517 append-only trigger is live from apply-time (not flag-gated)', () => {
  const sql = readFileSync(MIG, 'utf8');
  const live = code(sql);
  assert.match(
    live,
    /CREATE TRIGGER bidder_credits_append_only\s+BEFORE UPDATE OR DELETE ON public\.bidder_credits/,
  );
  assert.match(live, /ERRCODE = 'restrict_violation'/);
  assert.doesNotMatch(live, /current_setting\s*\(\s*'bingo\./);
  assert.doesNotMatch(live, /BIDDER_CREDIT_BUCKETS_ENABLED/);
  assert.match(sql, /live from apply-time on purpose/);
  const topLevel = live.replace(/\$\$[\s\S]*?\$\$/g, '');
  assert.doesNotMatch(topLevel, /^\s*(UPDATE|DELETE)\b/im);
});

test('0517 passes the repo function-grants and lot-migration lints', () => {
  const sql = readFileSync(MIG, 'utf8');
  const { lintGrants } = require('../check-function-grants.cjs');
  const { lintMigration } = require('../check-new-lot-migrations.cjs');
  assert.deepEqual(lintGrants(sql), []);
  assert.deepEqual(lintMigration(sql).errors, []);
});

test('master ledger has no bidder_credits FKs and no UPDATE/DELETE writers', () => {
  const create = readFileSync(MIG_0229, 'utf8').match(
    /CREATE TABLE IF NOT EXISTS public\.bidder_credits \([\s\S]*?\);/,
  )?.[0];
  assert.ok(create, '0229 creates bidder_credits');
  assert.doesNotMatch(create, /REFERENCES/i);
  assert.doesNotMatch(create, /ON DELETE/i);

  const migDir = join(root, 'packages/db/migrations');
  for (const name of readdirSync(migDir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(migDir, name), 'utf8');
    const alterFk =
      /ALTER TABLE(?:\s+ONLY)?\s+(?:public\.)?bidder_credits[\s\S]{0,500}(?:FOREIGN KEY|REFERENCES)/i;
    assert.doesNotMatch(sql, alterFk, `${name} must not add an FK on bidder_credits`);
    if (name.startsWith('0517_')) continue;
    assert.doesNotMatch(sql, /UPDATE\s+(?:ONLY\s+)?(?:public\.)?bidder_credits\b/i, name);
    assert.doesNotMatch(sql, /DELETE\s+FROM\s+(?:ONLY\s+)?(?:public\.)?bidder_credits\b/i, name);
  }

  for (const file of [DEL_0089, DEL_0092]) {
    const sql = readFileSync(file, 'utf8');
    assert.doesNotMatch(sql, /bidder_credits/, file);
  }

  const mutate = /from\(\s*['"]bidder_credits['"]\s*\)\s*\.\s*(update|delete|upsert)\b/i;
  for (const file of walk(join(root, 'apps'))) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file)) continue;
    const src = readFileSync(file, 'utf8');
    if (!src.includes('bidder_credits')) continue;
    assert.doesNotMatch(src, mutate, file);
  }
});
