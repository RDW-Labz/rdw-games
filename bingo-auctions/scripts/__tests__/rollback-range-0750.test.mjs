// Rollback range self-check for issue #750.
//
// The RED TEAM PASS on #745/#740 documented `git revert d4b7e4e2..53bc539c`,
// which starts after the implementation commit `d4b7e4e2` and therefore leaves
// the feature in place. This test builds a throwaway repository that mirrors
// that shape (base -> implementation -> fixtures) and proves:
//   - a range that includes the implementation commit restores both files;
//   - the documented-but-short range is rejected;
//   - the caller's checkout is never mutated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'prod-rig', '0750-verify-rollback-range.sh');

const PREFLIGHT = 'scripts/prod-rig/0731-preflight.sql';
const TEST_FILE = 'packages/db/test/tracked_catalog_preflight.sql';
const UNRELATED = 'scripts/prod-rig/0750-unrelated.txt';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

function writeRepoFile(root, rel, body) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function commit(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD').trim();
}

function runScript(root, args, env = {}) {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// base -> implementation -> fixtures, the #745 shape.
function buildRepo() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'rb750-'));
  git(root, 'init', '-q');
  writeRepoFile(root, PREFLIGHT, '-- preflight v1\n');
  writeRepoFile(root, TEST_FILE, '-- test v1\n');
  const base = commit(root, 'base');
  writeRepoFile(root, PREFLIGHT, '-- preflight v2 (reader identity)\n');
  const impl = commit(root, 'implementation');
  writeRepoFile(root, TEST_FILE, '-- test v2 (fixtures)\n');
  const head = commit(root, 'fixtures');
  return { root, base, impl, head };
}

test('#750: a range including the implementation commit restores every file', (t) => {
  const { root, base, head } = buildRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const headBefore = git(root, 'rev-parse', 'HEAD').trim();
  const result = runScript(root, [base, base, head, PREFLIGHT, TEST_FILE]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /rollback-range: OK/);
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), headBefore, "caller's HEAD moved");
  assert.equal(git(root, 'status', '--porcelain').trim(), '', "caller's worktree was dirtied");
});

test('#750: the short range that starts after the implementation commit is rejected', (t) => {
  const { root, base, impl, head } = buildRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = runScript(root, [base, impl, head, PREFLIGHT, TEST_FILE]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /NOT RESTORED: scripts\/prod-rig\/0731-preflight\.sql/);
});

test('#750: inherited Git index/worktree variables cannot touch the caller', (t) => {
  const { root, base, head } = buildRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeRepoFile(root, PREFLIGHT, '-- preflight staged change\n');
  git(root, 'add', PREFLIGHT);
  writeRepoFile(root, TEST_FILE, '-- test unstaged change\n');

  const indexPath = resolve(root, git(root, 'rev-parse', '--git-path', 'index').trim());
  const indexBefore = readFileSync(indexPath);
  const statusBefore = git(root, 'status', '--porcelain');
  const headBefore = git(root, 'rev-parse', 'HEAD').trim();
  const preflightBefore = readFileSync(join(root, PREFLIGHT));

  const result = runScript(root, [base, base, head, PREFLIGHT, TEST_FILE], {
    GIT_WORK_TREE: root,
    GIT_INDEX_FILE: indexPath,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), headBefore, "caller's HEAD moved");
  assert.deepEqual(readFileSync(indexPath), indexBefore, "caller's index was rewritten");
  assert.equal(git(root, 'status', '--porcelain'), statusBefore, "caller's staging was lost");
  assert.deepEqual(
    readFileSync(join(root, PREFLIGHT)),
    preflightBefore,
    "caller's tracked file changed",
  );
});

test('#750: a range that reverts unrelated work fails, a narrow range passes', (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'rb750-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  writeRepoFile(root, PREFLIGHT, '-- preflight v1\n');
  writeRepoFile(root, TEST_FILE, '-- test v1\n');
  writeRepoFile(root, UNRELATED, '-- unrelated v1\n');
  const base = commit(root, 'base');
  writeRepoFile(root, UNRELATED, '-- unrelated v2\n');
  const fix = commit(root, 'unrelated fix');
  writeRepoFile(root, PREFLIGHT, '-- preflight v2\n');
  const head = commit(root, 'target change');

  const narrow = runScript(root, [base, fix, head, PREFLIGHT]);
  assert.equal(narrow.code, 0, narrow.stderr);
  assert.equal(readFileSync(join(root, UNRELATED), 'utf8'), '-- unrelated v2\n');

  const broad = runScript(root, [base, base, head, PREFLIGHT]);
  assert.equal(broad.code, 1);
  assert.match(broad.stderr, /also reverts unrelated paths/);
  assert.ok(broad.stderr.includes(UNRELATED), broad.stderr);
});

// A -> B -> C -> D, caller at D; C is the change under inspection.
function buildCallerAheadRepo() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'rb759-'));
  git(root, 'init', '-q');
  writeRepoFile(root, PREFLIGHT, '-- preflight v1\n');
  const a = commit(root, 'A');
  writeRepoFile(root, PREFLIGHT, '-- preflight v2\n');
  const b = commit(root, 'B');
  writeRepoFile(root, PREFLIGHT, '-- preflight v3\n');
  const c = commit(root, 'C');
  writeRepoFile(root, UNRELATED, '-- later unrelated change\n');
  commit(root, 'D');
  return { root, a, b, c };
}

test('#759: HEAD-relative inputs resolve once, in the caller', (t) => {
  const { root, a, b, c } = buildCallerAheadRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Caller HEAD is D: HEAD~2 = B (restore point), HEAD~1 = C (the head being
  // inspected). Inside the detached worktree HEAD is C, so re-resolving would
  // name A (HEAD~2) and B (HEAD~1) instead.
  const byExpr = runScript(root, ['HEAD~2', 'HEAD~2', 'HEAD~1', PREFLIGHT]);
  const bySha = runScript(root, [b, b, c, PREFLIGHT]);

  assert.equal(byExpr.code, 0, byExpr.stderr);
  assert.equal(bySha.code, 0, bySha.stderr);
  assert.equal(
    byExpr.stdout,
    bySha.stdout,
    'HEAD-relative inputs did not resolve to the caller SHAs',
  );
  assert.ok(byExpr.stdout.includes(b), byExpr.stdout);
  assert.ok(!byExpr.stdout.includes(a), byExpr.stdout);
});

test('#759: a caller-relative range start is not re-read against the worktree HEAD', (t) => {
  const { root, b, c } = buildCallerAheadRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Caller HEAD is D, which is not an ancestor of C. Re-reading `HEAD` inside
  // the worktree (HEAD = C) would turn this into a valid empty C..C range.
  const result = runScript(root, [b, 'HEAD', c, PREFLIGHT]);

  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /not an ancestor/);
});

test('#750: usage and unknown-file problems exit 2, not a silent pass', (t) => {
  const { root, base, head } = buildRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal(runScript(root, [base, base]).code, 2);
  assert.equal(runScript(root, [base, base, head, 'scripts/prod-rig/missing.sql']).code, 2);
  assert.equal(runScript(root, ['deadbeef'.repeat(5), base, head, PREFLIGHT]).code, 2);
});
