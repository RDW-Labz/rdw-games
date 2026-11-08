const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { lintSql, newMigrationFiles, lintMigration } = require('../check-new-lot-migrations.cjs');

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'scripts/check-new-lot-migrations.cjs');
const historicalName = '0366_softdelete_catalog_misfire_20260921.sql';
const historical = fs.readFileSync(path.join(root, 'packages/db/migrations', historicalName), 'utf8');
const guard = "SELECT public.assert_no_physical_footprint(ARRAY['00000000-0000-4000-8000-000000000001']::uuid[])";

for (const mutation of [
  'UPDATE lots SET deleted_at=now()',
  'DELETE FROM public.lots WHERE false',
  'UPDATE ONLY (public.lots) SET title=title',
  'DELETE FROM ONLY "public"."lots" WHERE false',
  'WITH changed AS (UPDATE lots SET deleted_at=now() RETURNING id) SELECT * FROM changed',
  'DO $$ BEGIN UPDATE public.lots SET deleted_at=now(); END $$',
]) {
  test(`accepts ordered guard and transaction: ${mutation}`, () => {
    assert.deepEqual(lintSql(`BEGIN; ${guard}; ${mutation}; COMMIT;`), []);
  });
  test(`rejects missing guard: ${mutation}`, () => {
    assert.ok(lintSql(`BEGIN; ${mutation}; COMMIT;`).length > 0);
  });
}

for (const [label, sql] of [
  ['actual historical 0366', historical],
  ['CREATE TABLE AS modifying CTE', 'CREATE TABLE captured AS WITH removed AS (DELETE FROM lots RETURNING *) SELECT * FROM removed;'],
  ['guard after mutation', `BEGIN; DELETE FROM lots; ${guard}; COMMIT;`],
  ['comment-only guard', `BEGIN; /* ${guard}; */ DELETE FROM lots; COMMIT;`],
  ['line-comment guard', `BEGIN; -- ${guard};\nDELETE FROM lots; COMMIT;`],
  ['string-only guard', `BEGIN; SELECT $s$${guard}$s$; DELETE FROM lots; COMMIT;`],
  ['function-defined guard', `BEGIN; CREATE FUNCTION pretend_guard() RETURNS void LANGUAGE sql AS $$ ${guard}; $$; DELETE FROM lots; COMMIT;`],
  ['conditional guard', `BEGIN; ${guard} WHERE false; DELETE FROM lots; COMMIT;`],
  ['guard without transaction', `${guard}; DELETE FROM lots;`],
  ['guard from another schema', `BEGIN; ${guard.replace('public.', 'other_schema.')}; DELETE FROM lots; COMMIT;`],
  ['guard in previous transaction', `BEGIN; ${guard}; COMMIT; BEGIN; DELETE FROM lots; COMMIT;`],
  ['guard followed by rollback', `BEGIN; ${guard}; ROLLBACK; DELETE FROM lots;`],
  ['guard followed by END', `BEGIN; ${guard}; END; DELETE FROM lots;`],
  ['guard followed by PREPARE TRANSACTION', `BEGIN; ${guard}; PREPARE TRANSACTION 'fixture'; DELETE FROM lots;`],
  ['guard in DO body', `BEGIN; DO $$ BEGIN PERFORM public.assert_no_physical_footprint(ARRAY[]::uuid[]); END $$; DELETE FROM lots; COMMIT;`],
  ['dynamic SQL in DO', `BEGIN; ${guard}; DO $$ BEGIN EXECUTE 'DELETE FROM lots'; END $$; COMMIT;`],
  ['nested DO', `BEGIN; ${guard}; DO $outer$ BEGIN DO $inner$ BEGIN DELETE FROM lots; END $inner$; END $outer$; COMMIT;`],
  ['escape-string DO', String.raw`BEGIN; ${guard}; DO E'BEGIN\nDELETE FROM lots; END'; COMMIT;`],
  ['quoted identifiers', 'DELETE FROM "public"."lots" WHERE false;'],
  ['TRUNCATE', 'TRUNCATE TABLE public.lots;'],
  ['TRUNCATE second relation', 'TRUNCATE unrelated, public.lots;'],
  ['MERGE', 'MERGE INTO public.lots USING source ON false WHEN MATCHED THEN DELETE;'],
]) {
  test(`rejects ${label}`, () => assert.ok(lintSql(sql).length > 0, label));
}

test('function definitions are intentionally outside executable migration-time DML detection', () => {
  assert.deepEqual(lintSql(`
    CREATE OR REPLACE FUNCTION deferred_delete() RETURNS void LANGUAGE plpgsql
    AS $$ BEGIN DELETE FROM public.lots; END $$;
  `), []);
});

test('comments and strings containing destructive SQL do not create a mutation', () => {
  assert.deepEqual(lintSql("SELECT 'DELETE FROM lots'; /* UPDATE lots SET title = NULL; */"), []);
  assert.deepEqual(lintSql(String.raw`SELECT E'quoted\' DELETE FROM lots';`), []);
});

for (const sql of ['/* unclosed comment', "SELECT 'unclosed string", 'DO $body$ BEGIN DELETE FROM lots;']) {
  test(`malformed SQL fails closed: ${sql}`, () => assert.throws(() => lintSql(sql), /Unterminated/));
}

test('Unicode-escaped executable SQL fails closed', () => {
  assert.throws(() => lintSql(String.raw`DO U&'BEGIN UPD\0041TE lots SET title=NULL; END';`), /Unicode-escaped SQL/);
});

function gitFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lot-migration-lint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  function git(...args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function write(file, content) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  function commit() { git('add', '--all'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); }
  function cli(base) {
    return spawnSync(process.execPath, ['scripts/check-new-lot-migrations.cjs', '--base', base], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
    });
  }
  git('init', '-q');
  write(`packages/db/migrations/${historicalName}`, historical);
  write('scripts/check-new-lot-migrations.cjs', fs.readFileSync(script));
  write('README.md', 'Synthetic Git fixture only.\n');
  const base = commit();
  return { dir, git, write, commit, cli, base };
}

test('unchanged historical 0366 is ignored and CLI passes with no additions', t => {
  const f = gitFixture(t);
  f.write('README.md', 'Documentation-only change.\n');
  f.commit();
  assert.deepEqual(newMigrationFiles(f.base, 'HEAD', f.dir), []);
  const result = f.cli(f.base);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 new SQL file/);
});

test('new guarded migration is selected and passes without auditing historical SQL', t => {
  const f = gitFixture(t);
  const file = 'packages/db/migrations/0370_fixture.sql';
  f.write(file, `BEGIN; ${guard}; DELETE FROM lots WHERE false; COMMIT;`);
  f.commit();
  assert.deepEqual(newMigrationFiles(f.base, 'HEAD', f.dir), [file]);
  assert.equal(f.cli(f.base).status, 0);
});

for (const mode of ['copy', 'rename']) {
  test(`real 0366 introduced by ${mode} counts as new and fails CLI`, t => {
    const f = gitFixture(t);
    const file = 'packages/db/migrations/0370_unguarded_copy.sql';
    f.write(file, historical);
    if (mode === 'rename') fs.unlinkSync(path.join(f.dir, 'packages/db/migrations', historicalName));
    f.commit();
    assert.deepEqual(newMigrationFiles(f.base, 'HEAD', f.dir), [file]);
    const result = f.cli(f.base);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /0370_unguarded_copy\.sql/);
    assert.match(result.stderr, /assert_no_physical_footprint/);
    f.write(file, `BEGIN; ${guard}; DELETE FROM lots WHERE false; COMMIT;`);
    assert.equal(f.cli(f.base).status, 1, 'CLI must inspect committed HEAD, not an unstaged replacement');
  });
}

test('existing migration edits, non-SQL files, and nested files are not new migration additions', t => {
  const f = gitFixture(t);
  f.write(`packages/db/migrations/${historicalName}`, `${historical}\n-- Historical edit is outside this lint.\n`);
  f.write('packages/db/migrations/README.md', 'DELETE FROM lots;');
  f.write('packages/db/migrations/nested/0370_fixture.sql', 'DELETE FROM lots;');
  f.commit();
  assert.deepEqual(newMigrationFiles(f.base, 'HEAD', f.dir), []);
});

test('missing or unavailable base fails closed, including the CLI', t => {
  const f = gitFixture(t);
  assert.throws(() => newMigrationFiles(undefined, 'HEAD', f.dir), /full base commit SHA/);
  assert.throws(() => newMigrationFiles(f.base.slice(0, 7), 'HEAD', f.dir), /full base commit SHA/);
  assert.throws(() => newMigrationFiles('0'.repeat(40), 'HEAD', f.dir));
  assert.equal(f.cli('0'.repeat(40)).status, 1);
});

// ── footprint-exempt header ─────────────────────────────────────────────────
const exemptHeader = '-- footprint-exempt: one stickerless relot copy, shelf checked by owner\n';
const unguarded = 'BEGIN;\nUPDATE public.lots SET status = status WHERE false;\nCOMMIT;\n';

test('footprint-exempt header in the leading comments waives the omission', () => {
  const { errors, exempt } = lintMigration(`-- 0999 fixture\n${exemptHeader}--\n${unguarded}`);
  assert.deepEqual(errors, []);
  assert.equal(exempt.reason, 'one stickerless relot copy, shelf checked by owner');
  assert.equal(exempt.waived.length, 1);
});

test('the same file without the header still fails', () => {
  const { errors, exempt } = lintMigration(`-- 0999 fixture\n${unguarded}`);
  assert.equal(exempt, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /assert_no_physical_footprint/);
});

for (const [label, sql] of [
  ['an empty reason', `-- footprint-exempt:\n${unguarded}`],
  ['a too-short reason', `-- footprint-exempt: ok\n${unguarded}`],
  ['a header after the first statement', `BEGIN;\n${exemptHeader}UPDATE public.lots SET status = status WHERE false;\nCOMMIT;\n`],
  ['a header inside a block comment', `/*\n${exemptHeader}*/\n${unguarded}`],
]) {
  test(`footprint-exempt does not count with ${label}`, () => {
    assert.ok(lintMigration(sql).errors.length > 0, label);
  });
}

test('footprint-exempt waives only the footprint omission, not dynamic EXECUTE', () => {
  const { errors, exempt } = lintMigration(`${exemptHeader}BEGIN; DO $$ BEGIN EXECUTE 'DELETE FROM lots'; END $$; COMMIT;`);
  assert.ok(exempt);
  assert.ok(errors.some(e => /dynamic EXECUTE/.test(e)), errors.join('\n'));
});

test('CLI reports an exempt migration as exempt and passes; without the header it fails', t => {
  const f = gitFixture(t);
  const file = 'packages/db/migrations/0999_exempt_fixture.sql';
  f.write(file, `-- 0999 fixture\n${exemptHeader}${unguarded}`);
  f.commit();
  const ok = f.cli(f.base);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /0999_exempt_fixture\.sql: exempt \(one stickerless relot copy, shelf checked by owner\): 1 footprint omission\(s\) waived/);
  assert.match(ok.stdout, /0 omission\(s\), 1 exempt/);
  f.write(file, `-- 0999 fixture\n${unguarded}`);
  f.commit();
  const bad = f.cli(f.base);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /0999_exempt_fixture\.sql: statement 2: lot mutation requires BEGIN/);
});
