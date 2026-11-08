// Tests for scripts/check-function-grants.cjs: new functions must revoke PUBLIC.
//   node --test scripts/__tests__/function-grants-lint.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lintGrants } = require('../check-function-grants.cjs');

const root = path.resolve(__dirname, '../..');
const fn = (name, args = 'p uuid', ret = 'boolean') =>
  `CREATE OR REPLACE FUNCTION ${name}(${args}) RETURNS ${ret} LANGUAGE sql AS $$ SELECT true $$;`;

test('the 0389 shape fails: GRANT to service_role alone leaves PUBLIC', () => {
  const sql = `BEGIN; ${fn('public.claim_refund')} GRANT EXECUTE ON FUNCTION public.claim_refund(uuid) TO service_role; COMMIT;`;
  const errs = lintGrants(sql);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^public\.claim_refund: created without a REVOKE/);
});

test('the 0390 shape fails: revoking anon and authenticated by name is not revoking PUBLIC', () => {
  const sql = `${fn('public.claim_refund')} REVOKE EXECUTE ON FUNCTION public.claim_refund(uuid) FROM anon, authenticated;`;
  assert.equal(lintGrants(sql).length, 1);
});

test('the fixed shape passes: revoke PUBLIC, then grant explicitly', () => {
  const sql = `BEGIN; ${fn('public.claim_refund')}
    REVOKE EXECUTE ON FUNCTION public.claim_refund(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.claim_refund(uuid) TO service_role; COMMIT;`;
  assert.deepEqual(lintGrants(sql), []);
});

test('PUBLIC may sit anywhere in the grantee list, any case', () => {
  assert.deepEqual(lintGrants(`${fn('public.f')} revoke all on function public.f(uuid) from anon, public;`), []);
  assert.deepEqual(lintGrants(`${fn('public.f')} REVOKE EXECUTE ON FUNCTION f(uuid) FROM Public;`), []);
});

test('unqualified and quoted names resolve to public.<name>', () => {
  assert.deepEqual(lintGrants(`${fn('f')} REVOKE EXECUTE ON FUNCTION public.f(uuid) FROM PUBLIC;`), []);
  assert.deepEqual(lintGrants(`${fn('"public"."f"')} REVOKE EXECUTE ON FUNCTION f(uuid) FROM PUBLIC;`), []);
  assert.equal(lintGrants(`${fn('public.f')} REVOKE EXECUTE ON FUNCTION public.g(uuid) FROM PUBLIC;`).length, 1);
});

test('a different schema is a different function', () => {
  assert.equal(lintGrants(`${fn('private.f')} REVOKE EXECUTE ON FUNCTION public.f(uuid) FROM PUBLIC;`).length, 1);
  assert.deepEqual(lintGrants(`${fn('private.f')} REVOKE EXECUTE ON FUNCTION private.f(uuid) FROM PUBLIC;`), []);
});

test('two overloads need two revokes; one statement may name both', () => {
  const two = `${fn('public.f', 'a uuid')} ${fn('public.f', 'a uuid, b text')}`;
  assert.equal(lintGrants(`${two} REVOKE EXECUTE ON FUNCTION public.f(uuid) FROM PUBLIC;`).length, 1);
  assert.deepEqual(
    lintGrants(`${two} REVOKE EXECUTE ON FUNCTION public.f(uuid), public.f(uuid, text) FROM PUBLIC;`),
    [],
  );
});

test('REVOKE ... ON ALL FUNCTIONS IN SCHEMA covers that schema', () => {
  assert.deepEqual(lintGrants(`${fn('public.f')} REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;`), []);
  assert.equal(lintGrants(`${fn('private.f')} REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;`).length, 1);
});

test('procedures are covered too; ON ROUTINE counts', () => {
  const proc = 'CREATE PROCEDURE public.p(x int) LANGUAGE sql AS $$ SELECT 1 $$;';
  assert.equal(lintGrants(proc).length, 1);
  assert.deepEqual(lintGrants(`${proc} REVOKE EXECUTE ON PROCEDURE public.p(int) FROM PUBLIC;`), []);
  assert.deepEqual(lintGrants(`${proc} REVOKE EXECUTE ON ROUTINE public.p(int) FROM PUBLIC;`), []);
});

test('trigger functions are exempt: Postgres will not call them directly', () => {
  assert.deepEqual(lintGrants(fn('public.t', '', 'trigger')), []);
  assert.deepEqual(lintGrants(fn('public.t', '', 'event_trigger')), []);
});

test('the opt-out comment names the function and allows it', () => {
  const sql = `-- lint:allow-public-execute public.get_recent_wins public storefront RPC\n${fn('public.get_recent_wins')}`;
  assert.deepEqual(lintGrants(sql), []);
  const other = `-- lint:allow-public-execute public.something_else reason\n${fn('public.get_recent_wins')}`;
  assert.equal(lintGrants(other).length, 1);
});

test('a revoke inside a comment or a string does not count', () => {
  assert.equal(lintGrants(`${fn('public.f')} -- REVOKE EXECUTE ON FUNCTION public.f(uuid) FROM PUBLIC;`).length, 1);
  assert.equal(lintGrants(`${fn('public.f')} SELECT 'REVOKE EXECUTE ON FUNCTION public.f(uuid) FROM PUBLIC';`).length, 1);
});

test('function bodies are not looked into (dollar-quoted)', () => {
  const sql = `${fn('public.f')} REVOKE EXECUTE ON FUNCTION public.f(uuid) FROM PUBLIC;
    DO $$ BEGIN EXECUTE 'CREATE FUNCTION public.g() RETURNS int LANGUAGE sql AS ''SELECT 1'''; END $$;`;
  assert.deepEqual(lintGrants(sql), []);
});

test('a migration that creates no function passes (e.g. 0391 itself)', () => {
  const sql = `BEGIN;
    REVOKE EXECUTE ON FUNCTION public.claim_refund(uuid, text, integer, uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.claim_refund(uuid, text, integer, uuid) TO service_role; COMMIT;`;
  assert.deepEqual(lintGrants(sql), []);
});

test('real history: 0389 as merged fails, as it should have', () => {
  const p = path.join(root, 'packages/db/migrations/0389_refund_claims.sql');
  if (!fs.existsSync(p)) return; // branch without 0389
  const errs = lintGrants(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(errs.map((e) => e.split(':')[0]).sort(), ['public.claim_refund', 'public.release_refund']);
});
