#!/usr/bin/env node
// Guard for docs/state/redteam-findings.md.
//
// Every RED TEAM finding we have paid for must be written down once, with the
// test that now covers it. This fails when the registry is malformed, when an
// ID is duplicated, or when a row marked `merged` names a dash, directory or
// non-test file instead of a real regression test. Rows marked `open-pr` are
// pending by design: their test lives on the PR branch until that PR lands.
//
// Malformed rows are errors, never silently skipped (#721 RED TEAM). A row
// whose finding contains a literal `|` must escape it as `\|`.
//
// There must be exactly one registry section: duplicate, nested or a second
// complete section escapes validation otherwise (#732).
//
// A cited test must really be a test, not a fixture or a symlink to a manifest
// (#732). Accepted forms: a `.test`/`.spec` JS/TS file, or a top-level
// `packages/db/test/*.sql` regression test, anchored at the repo root.
//
// Run locally before asking RED TEAM for a re-review:
//   node scripts/ci/red-team-checklist.mjs
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CHECKLIST = 'docs/state/redteam-findings.md';
const START = '<!-- redteam-registry:start -->';
const END = '<!-- redteam-registry:end -->';
const STATUSES = new Set(['merged', 'open-pr', 'planned']);
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SQL_TEST_RE = /^packages\/db\/test\/[^/]+\.sql$/;

// A real regression test, not merely a file living under a test directory.
// On POSIX a backslash is a literal filename character, not a path separator,
// so only normalize on Windows (#767).
function isTestPath(path) {
  const normalized = sep === '\\' ? path.replace(/\\/g, '/') : path;
  return TEST_FILE_RE.test(normalized) || SQL_TEST_RE.test(normalized);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function registrySlice(markdown) {
  const starts = countOccurrences(markdown, START);
  const ends = countOccurrences(markdown, END);
  if (starts === 0 && ends === 0) return { error: 'registry markers missing' };
  if (starts !== 1) {
    return { error: `expected exactly one registry START marker, found ${starts}` };
  }
  if (ends !== 1) {
    return { error: `expected exactly one registry END marker, found ${ends}` };
  }
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (end < start) return { error: 'registry END marker appears before START' };
  return { text: markdown.slice(start + START.length, end) };
}

// Split on unescaped pipes, keep escaped pipes inside the cell.
export function splitRow(line) {
  const cells = [];
  let current = '';
  let sawPipe = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\' && line[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (char === '|') {
      if (sawPipe) cells.push(current.trim());
      else sawPipe = true;
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '' || cells.length === 0) cells.push(current.trim());
  return cells;
}

function isSeparator(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function parseRegistry(markdown) {
  const slice = registrySlice(markdown);
  if (slice.error) return { error: slice.error };
  const rows = [];
  const problems = [];
  let sawHeader = false;
  const lines = slice.text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('|')) {
      // A row with a dropped leading pipe must fail, not vanish (#721 RED TEAM).
      if (line.includes('|')) {
        problems.push(`line ${index + 1}: row is missing its leading pipe`);
      }
      continue;
    }
    const cells = splitRow(line);
    if (cells[0] === 'ID') {
      sawHeader = true;
      continue;
    }
    if (isSeparator(cells)) continue;
    if (cells.length !== 4) {
      problems.push(`line ${index + 1}: expected 4 cells, got ${cells.length}`);
      continue;
    }
    const [id, finding, status] = [cells[0], cells[1], cells[3]];
    // A test path is shown in backticks in the table; compare the raw path.
    const test = cells[2].replace(/^`([^`]*)`$/, '$1');
    if (!id || !finding || !test || !status) {
      problems.push(`line ${index + 1}: empty cell`);
      continue;
    }
    rows.push({ id, finding, test, status });
  }
  if (!sawHeader) problems.push('registry table header missing');
  if (rows.length === 0) problems.push('registry has no rows');
  if (problems.length > 0) return { error: problems.join('; '), problems };
  return { rows };
}

export function validateRegistry(rows, fileCheck = isFile) {
  const problems = [];
  const seen = new Set();
  for (const row of rows) {
    if (!/^RT-[A-Z0-9]+-\d+$/.test(row.id)) {
      problems.push(`${row.id}: malformed ID (want RT-<area>-<n>)`);
    }
    if (seen.has(row.id)) problems.push(`${row.id}: duplicate ID`);
    seen.add(row.id);
    if (!STATUSES.has(row.status)) {
      problems.push(`${row.id}: unknown status "${row.status}" (want merged|open-pr|planned)`);
      continue;
    }
    const isDash = row.test === '—' || row.test === '-';
    if (row.status === 'merged') {
      if (isDash) {
        problems.push(`${row.id}: status merged must name a real test file`);
        continue;
      }
      const problem = testPathProblem(row.test, { fileCheck });
      if (problem) problems.push(`${row.id}: ${problem}`);
    }
  }
  return problems;
}

// A merged row's test path must stay inside the repo after normalization.
// `../` segments, absolute paths and symlinks that resolve outside the root
// could disguise a manifest or source file as a test (#721 RED TEAM). The
// resolved target must itself be a test, so a test-named symlink to
// `package.json` cannot pass (#732).
export function testPathProblem(path, { fileCheck = isFile, root = REPO_ROOT } = {}) {
  if (typeof path !== 'string' || path.length === 0) return 'status merged must name a test file';
  if (isAbsolute(path)) return `status merged test must be repo-relative: ${path}`;
  if (path.split(/[\\/]+/).includes('..')) {
    return `status merged test escapes the repo: ${path}`;
  }
  if (!isTestPath(path)) return `status merged test is not a test file: ${path}`;

  const rootPath = resolve(root);
  const full = resolve(rootPath, path);
  if (full !== rootPath && !full.startsWith(rootPath + sep)) {
    return `status merged test escapes the repo: ${path}`;
  }
  if (!fileCheck(full)) return `status merged but test file is missing: ${path}`;

  try {
    const realRoot = realpathSync(rootPath);
    const realFull = realpathSync(full);
    if (realFull !== realRoot && !realFull.startsWith(realRoot + sep)) {
      return `status merged test resolves outside the repo: ${path}`;
    }
    const realRelative = relative(realRoot, realFull);
    if (!isTestPath(realRelative)) {
      return `status merged test links to a non-test file: ${path}`;
    }
  } catch {
    return `status merged but test file is missing: ${path}`;
  }
  return null;
}

export function run(checklistPath = join(REPO_ROOT, CHECKLIST), fileCheck = isFile) {
  const parsed = parseRegistry(readFileSync(checklistPath, 'utf8'));
  if (parsed.error) {
    console.error(`red-team-checklist: ${parsed.error}`);
    return 1;
  }
  const problems = validateRegistry(parsed.rows, fileCheck);
  if (problems.length > 0) {
    console.error('red-team-checklist: failed');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  const counts = parsed.rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  console.log(`red-team-checklist: ok (${summary})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run();
}
