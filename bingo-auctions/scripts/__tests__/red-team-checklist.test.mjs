// Registry guard for docs/state/redteam-state.md (see module for the real path).
// Run: node --test scripts/__tests__/red-team-checklist.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECKLIST,
  parseRegistry,
  splitRow,
  testPathProblem,
  validateRegistry,
} from '../ci/red-team-checklist.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const START = '<!-- redteam-registry:start -->';
const END = '<!-- redteam-registry:end -->';
const wrap = (rows) =>
  `# checklist\n\n<!-- redteam-registry:start -->\n| ID | Finding | Test | Status |\n| --- | --- | --- | --- |\n${rows}\n<!-- redteam-registry:end -->\n`;
const row = (id, test = '—', status = 'planned') => `| ${id} | something | ${test} | ${status} |`;
const REAL_TEST = '`scripts/__tests__/red-team-checklist.test.mjs`';
const CANONICAL_TEST_RE =
  /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$|^packages\/db\/test\/[^/]+\.sql$/;
const isCanonicalTestPath = (path) => CANONICAL_TEST_RE.test(path);

test('the real checklist parses and validates', () => {
  const parsed = parseRegistry(readFileSync(join(ROOT, CHECKLIST), 'utf8'));
  assert.equal(parsed.error, undefined);
  assert.ok(parsed.rows.length > 0);
  assert.deepEqual(validateRegistry(parsed.rows), []);
});

test('missing registry markers are an error', () => {
  assert.equal(parseRegistry('# no markers').error, 'registry markers missing');
  assert.equal(parseRegistry('').error, 'registry markers missing');
});

test('a registry with no rows is an error', () => {
  assert.equal(parseRegistry(wrap('')).error, 'registry has no rows');
});

test('duplicate, nested or a second registry section is rejected', () => {
  const rowText = row('RT-A-1');
  assert.match(parseRegistry(`${START}\n${START}\n${rowText}\n${END}`).error, /START marker/);
  assert.match(parseRegistry(`${START}\n${rowText}\n${END}\n${END}`).error, /END marker/);
  assert.match(
    parseRegistry(`${wrap(rowText)}\n${START}\n${rowText}\n${END}`).error,
    /START marker/,
  );
  assert.match(
    parseRegistry(`${END}\n${rowText}\n${START}`).error,
    /END marker appears before START/,
  );
});

test('duplicate IDs fail', () => {
  const rows = parseRegistry(wrap([row('RT-A-1'), row('RT-A-1')].join('\n'))).rows;
  assert.ok(validateRegistry(rows).some((p) => p.includes('duplicate')));
});

test('malformed and unknown values fail', () => {
  const rows = parseRegistry(
    wrap([row('BAD', '—', 'merged'), row('RT-A-2', '—', 'shipped')].join('\n')),
  ).rows;
  const problems = validateRegistry(rows);
  assert.ok(problems.some((p) => p.includes('malformed ID')));
  assert.ok(problems.some((p) => p.includes('unknown status')));
});

test('malformed rows fail instead of disappearing', () => {
  const six = '| RT-A-1 | has | a | pipe | here |';
  const three = '| RT-A-2 | only | three |';
  const parsed = parseRegistry(wrap([six, three].join('\n')));
  assert.match(parsed.error, /expected 4 cells, got 5/);
  assert.match(parsed.error, /expected 4 cells, got 3/);
});

test('a row with a dropped leading pipe fails instead of disappearing', () => {
  const parsed = parseRegistry(
    wrap(['RT-A-1 | something | — | planned', row('RT-A-2')].join('\n')),
  );
  assert.match(parsed.error, /missing its leading pipe/);
});

test('merged test paths cannot escape the repo', () => {
  assert.match(testPathProblem('scripts/__tests__/../../package.json'), /escapes the repo/);
  assert.match(testPathProblem('../outside.test.mjs'), /escapes the repo/);
  assert.match(testPathProblem('/etc/passwd'), /repo-relative/);
  assert.equal(testPathProblem('scripts/__tests__/red-team-checklist.test.mjs'), null);
});

test('a symlinked test that resolves outside the repo is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'rt-reg-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'rt-reg-out-'));
  try {
    const realTest = join(outside, 'evil.test.mjs');
    writeFileSync(realTest, '');
    mkdirSync(join(root, 'scripts', '__tests__'), { recursive: true });
    symlinkSync(realTest, join(root, 'scripts/__tests__/evil.test.mjs'));
    assert.match(
      testPathProblem('scripts/__tests__/evil.test.mjs', { root }),
      /resolves outside the repo/,
    );

    const inside = join(root, 'scripts/__tests__/real.test.mjs');
    writeFileSync(inside, '');
    assert.equal(testPathProblem('scripts/__tests__/real.test.mjs', { root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a fixture under __tests__ is not accepted as a regression test', () => {
  assert.match(testPathProblem('scripts/__tests__/fixture.json'), /not a test file/);
});

test('a test-shaped symlink to a manifest is rejected; a link to a real test passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rt-reg-link-'));
  try {
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'scripts', '__tests__'), { recursive: true });
    symlinkSync(join(root, 'package.json'), join(root, 'scripts/__tests__/manifest.test.mjs'));
    assert.match(
      testPathProblem('scripts/__tests__/manifest.test.mjs', { root }),
      /links to a non-test file/,
    );

    writeFileSync(join(root, 'scripts/__tests__/real.test.mjs'), '');
    symlinkSync(
      join(root, 'scripts/__tests__/real.test.mjs'),
      join(root, 'scripts/__tests__/link.test.mjs'),
    );
    assert.equal(testPathProblem('scripts/__tests__/link.test.mjs', { root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a merged row accepts a real SQL regression test under packages/db/test', () => {
  const sql = '`packages/db/test/money_daily_revenue.sql`';
  const rows = parseRegistry(wrap(row('RT-A-1', sql, 'merged'))).rows;
  assert.deepEqual(validateRegistry(rows), []);

  assert.match(
    testPathProblem('packages/db/migrations/0198_payments_disabled_test_mode.sql'),
    /not a test file/,
  );
  assert.match(
    testPathProblem('packages/db/test/fixtures/physical-footprint-schema.sql'),
    /not a test file/,
  );
  assert.match(testPathProblem('packages/db/src/source.sql'), /not a test file/);
});

test('a nested SQL lookalike is not a regression test (#735)', () => {
  assert.match(
    testPathProblem('fixtures/packages/db/test/money_daily_revenue.sql'),
    /not a test file/,
  );
  assert.match(
    testPathProblem('scripts/fixtures/packages/db/test/money_daily_revenue.sql'),
    /not a test file/,
  );
});

test('a top-level SQL symlink passes only when it links to a test (#735)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rt-reg-sql-link-'));
  try {
    mkdirSync(join(root, 'packages/db/test/fixtures'), { recursive: true });
    writeFileSync(join(root, 'packages/db/test/real.sql'), '');
    writeFileSync(join(root, 'packages/db/test/fixtures/fixture.sql'), '');
    symlinkSync(join(root, 'packages/db/test/real.sql'), join(root, 'packages/db/test/link.sql'));
    symlinkSync(
      join(root, 'packages/db/test/fixtures/fixture.sql'),
      join(root, 'packages/db/test/bad-link.sql'),
    );
    assert.equal(testPathProblem('packages/db/test/link.sql', { root }), null);
    assert.match(
      testPathProblem('packages/db/test/bad-link.sql', { root }),
      /links to a non-test file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a literal-backslash filename and its canonical SQL symlink are rejected (#767)', () => {
  // A POSIX filename may contain literal backslashes; Windows cannot create one.
  if (sep === '\\') return;
  const root = mkdtempSync(join(tmpdir(), 'rt-reg-backslash-'));
  try {
    mkdirSync(join(root, 'packages/db/test'), { recursive: true });
    const lookalike = join(root, 'packages\\db\\test\\evil.sql');
    writeFileSync(lookalike, '');
    symlinkSync(lookalike, join(root, 'packages/db/test/evil.sql'));

    // The lookalike name is one literal filename, not a path into packages/db/test.
    assert.match(testPathProblem('packages\\db\\test\\evil.sql', { root }), /not a test file/);
    // The canonical link resolves to that literal filename, so it is not a test either.
    assert.match(
      testPathProblem('packages/db/test/evil.sql', { root }),
      /links to a non-test file/,
    );
    const rows = parseRegistry(
      wrap(row('RT-A-1', '`packages\\db\\test\\evil.sql`', 'merged')),
    ).rows;
    assert.ok(validateRegistry(rows).some((p) => p.includes('not a test file')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the canonical check accepts a top-level SQL test, not migrations/fixtures (#736)', () => {
  const sql = 'packages/db/test/money_daily_revenue.sql';
  const rows = parseRegistry(wrap(row('RT-A-1', `\`${sql}\``, 'merged'))).rows;
  assert.deepEqual(validateRegistry(rows), []);
  assert.ok(isCanonicalTestPath(sql), `${sql} is canonical`);
  assert.ok(isCanonicalTestPath('scripts/__tests__/real.test.mjs'));
  assert.ok(!isCanonicalTestPath('packages/db/migrations/0198_payments_disabled_test_mode.sql'));
  assert.ok(!isCanonicalTestPath('packages/db/test/fixtures/physical-footprint-schema.sql'));
  assert.ok(!isCanonicalTestPath('fixtures/packages/db/test/money_daily_revenue.sql'));
});

test('an escaped pipe inside a finding stays one cell', () => {
  const text =
    '| RT-GATE-01 | Only a real `VERDICT: GO \\| PASS` counts | ' + REAL_TEST + ' | merged |';
  const parsed = parseRegistry(wrap(text));
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.rows[0].finding, 'Only a real `VERDICT: GO | PASS` counts');
  assert.equal(parsed.rows[0].test, 'scripts/__tests__/red-team-checklist.test.mjs');
});

test('row splitting keeps escaped pipes and drops a trailing pipe', () => {
  assert.deepEqual(splitRow('| a | b \\| c | d | e |'), ['a', 'b | c', 'd', 'e']);
});

test('a merged row must cite a real test file', () => {
  const rows = parseRegistry(
    wrap(
      [
        row('RT-A-1', '`scripts/does-not-exist.test.mjs`', 'merged'),
        row('RT-A-2', '`package.json`', 'merged'),
        row('RT-A-3', '`scripts/ci`', 'merged'),
        row('RT-A-4', '—', 'merged'),
        row('RT-A-5', REAL_TEST, 'merged'),
      ].join('\n'),
    ),
  ).rows;
  const problems = validateRegistry(rows);
  assert.ok(problems.some((p) => p.includes('RT-A-1') && p.includes('missing')));
  assert.ok(problems.some((p) => p.includes('RT-A-2') && p.includes('not a test file')));
  assert.ok(problems.some((p) => p.includes('RT-A-3') && p.includes('not a test file')));
  assert.ok(problems.some((p) => p.includes('RT-A-4') && p.includes('real test file')));
  assert.equal(
    problems.some((p) => p.includes('RT-A-5')),
    false,
  );
});

test('a merged row accepts a real regression test under __tests__', () => {
  const rows = parseRegistry(wrap(row('RT-A-1', REAL_TEST, 'merged'))).rows;
  assert.deepEqual(validateRegistry(rows), []);
});

test('open-pr and planned rows may name a test that is not here yet', () => {
  const rows = parseRegistry(
    wrap([row('RT-A-1', 'not/here.test.mjs', 'open-pr'), row('RT-A-2', '—', 'planned')].join('\n')),
  ).rows;
  assert.deepEqual(validateRegistry(rows), []);
});

test('planned rows may name a dash', () => {
  const rows = parseRegistry(wrap(row('RT-A-1', '`—`', 'planned'))).rows;
  assert.deepEqual(validateRegistry(rows), []);
});

test('the real registry keeps RT-GATE-01 and its escaped pipe', () => {
  const parsed = parseRegistry(readFileSync(join(ROOT, CHECKLIST), 'utf8'));
  const gate = parsed.rows.find((r) => r.id === 'RT-GATE-01');
  assert.ok(gate, 'RT-GATE-01 must not disappear');
  assert.equal(gate.test, 'scripts/__tests__/ship-gate.test.mjs');
  assert.match(gate.finding, /VERDICT: GO \| PASS/);
});

test('the real registry uses canonical __tests__ paths, not literal **tests**', () => {
  const text = readFileSync(join(ROOT, CHECKLIST), 'utf8');
  assert.doesNotMatch(text, /\*\*tests\*\*/);
  const parsed = parseRegistry(text);
  for (const row of parsed.rows) {
    if (row.test === '—') continue;
    assert.ok(isCanonicalTestPath(row.test), `${row.id} path is canonical`);
  }
});

test('rows owned by this PR name tests that exist in this checkout', () => {
  const parsed = parseRegistry(readFileSync(join(ROOT, CHECKLIST), 'utf8'));
  const owned = parsed.rows.filter(
    (r) => r.id.startsWith('RT-LABEL-') || r.id.startsWith('RT-REG-'),
  );
  assert.ok(owned.length > 0);
  for (const row of owned) {
    assert.ok(statSync(join(ROOT, row.test)).isFile(), `${row.id} test exists: ${row.test}`);
  }
});
