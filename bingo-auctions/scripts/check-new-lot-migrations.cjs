#!/usr/bin/env node
// Deliberately a syntax lint, not a PostgreSQL parser or authorization control.
const { execFileSync } = require('node:child_process');

function tokens(sql) {
  const out = [];
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { i++; continue; }
    if (sql.startsWith('--', i)) { i = sql.indexOf('\n', i); if (i < 0) break; continue; }
    if (sql.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (depth && i < sql.length) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('Unterminated SQL comment');
      continue;
    }
    if (/^[uU]&['"]/.test(sql.slice(i))) throw new Error('Unicode-escaped SQL is outside this lint; use ordinary identifiers/literals');
    const dollar = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/);
    if (dollar) {
      const start = i + dollar[0].length;
      const end = sql.indexOf(dollar[0], start);
      if (end < 0) throw new Error('Unterminated dollar-quoted SQL');
      out.push({ kind: 'literal', value: sql.slice(start, end) });
      i = end + dollar[0].length; continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const escaped = sql[i] === "'" && /(?:^|[^A-Za-z_0-9$])[eE]$/.test(sql.slice(0, i));
      const quote = sql[i++]; let value = ''; let closed = false;
      while (i < sql.length) {
        const c = sql[i++];
        if (c === quote) {
          if (sql[i] === quote) { value += quote; i++; }
          else { closed = true; break; }
        } else {
          if (escaped && c === '\\') {
            if (i >= sql.length) throw new Error('Unterminated escape string');
            value += c + sql[i++];
          } else value += c;
        }
      }
      if (!closed) throw new Error('Unterminated quoted SQL');
      out.push({ kind: quote === '"' ? 'id' : 'literal', value, escaped });
      continue;
    }
    const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z_0-9$]*/);
    if (word) { out.push({ kind: 'word', value: word[0].toLowerCase() }); i += word[0].length; }
    else out.push({ kind: 'symbol', value: sql[i++] });
  }
  return out;
}
const keyword = (t, value) => t?.kind === 'word' && t.value === value;
const identifier = (t, value) => ['word', 'id'].includes(t?.kind) && t.value === value;
const symbol = (t, value) => t?.kind === 'symbol' && t.value === value;

function lotsAt(ts, i) {
  if (keyword(ts[i], 'only')) i++;
  if (symbol(ts[i], '(')) i++;
  if (identifier(ts[i], 'public') && symbol(ts[i + 1], '.')) i += 2;
  return identifier(ts[i], 'lots');
}
function writesLots(ts) {
  // TRUNCATE accepts a comma-separated relation list.
  for (let i = 0; i < ts.length; i++) {
    if (!keyword(ts[i], 'truncate')) continue;
    let j = i + (keyword(ts[i + 1], 'table') ? 2 : 1);
    if (lotsAt(ts, j)) return true;
    while (j < ts.length && !symbol(ts[j], ';')) {
      if (symbol(ts[j], ',') && lotsAt(ts, j + 1)) return true;
      j++;
    }
  }
  return ts.some((t, i) =>
    (keyword(t, 'update') && lotsAt(ts, i + 1)) ||
    (keyword(t, 'delete') && keyword(ts[i + 1], 'from') && lotsAt(ts, i + 2)) ||
    (keyword(t, 'merge') && keyword(ts[i + 1], 'into') && lotsAt(ts, i + 2)) ||
    (keyword(t, 'truncate') && lotsAt(ts, i + (keyword(ts[i + 1], 'table') ? 2 : 1))));
}
function standaloneGuard(ts) {
  // Only this top-level form counts. Definitions, strings, conditional SELECTs,
  // PERFORM inside DO, and calls after the mutation do not discharge the lint.
  if (!keyword(ts[0], 'select')) return false;
  let i = 1;
  if (!identifier(ts[i++], 'public') || !symbol(ts[i++], '.') ||
      !identifier(ts[i++], 'assert_no_physical_footprint') || !symbol(ts[i++], '(')) return false;
  let depth = 1;
  while (i < ts.length && depth) {
    if (symbol(ts[i], '(')) depth++;
    if (symbol(ts[i], ')')) depth--;
    i++;
  }
  return depth === 0 && i === ts.length;
}
function lintSql(sql) {
  const statements = [[]];
  for (const t of tokens(sql)) {
    if (symbol(t, ';')) statements.push([]);
    else statements.at(-1).push(t);
  }
  let transaction = false; let guarded = false;
  const errors = [];
  for (const [index, ts] of statements.entries()) {
    if (!ts.length) continue;
    const label = `statement ${index + 1}`;
    if (keyword(ts[0], 'begin') || (keyword(ts[0], 'start') && keyword(ts[1], 'transaction'))) {
      transaction = true; guarded = false;
    }
    if (['commit', 'end', 'rollback', 'abort'].some(k => keyword(ts[0], k)) ||
        (keyword(ts[0], 'prepare') && keyword(ts[1], 'transaction'))) {
      transaction = false; guarded = false;
    }
    // Definitions do not execute their bodies during migration. Invocations,
    // triggers and cascades require human impact review, outside this lint.
    const definition = keyword(ts[1], 'or') && keyword(ts[2], 'replace') ? 3 : 1;
    if (keyword(ts[0], 'create') && ['function', 'procedure'].some(k => keyword(ts[definition], k))) continue;
    if (standaloneGuard(ts) && transaction) guarded = true;
    let mutation = writesLots(ts);
    if (keyword(ts[0], 'do')) {
      for (const body of ts.filter(t => t.kind === 'literal')) {
        if (body.escaped) {
          errors.push(`${label}: escape-string DO bodies are outside this lint; use dollar quoting`);
          continue;
        }
        const inner = tokens(body.value);
        if (inner.some(t => keyword(t, 'do'))) {
          errors.push(`${label}: nested DO is outside this lint; use a top-level block with explicit maintenance SQL`);
        }
        if (inner.some(t => keyword(t, 'execute'))) {
          errors.push(`${label}: dynamic EXECUTE in DO is not analyzable; use explicit SQL for migration-time changes`);
        }
        mutation ||= writesLots(inner);
      }
    }
    if (mutation && !(transaction && guarded)) {
      errors.push(`${label}: lot mutation requires BEGIN, then a standalone SELECT public.assert_no_physical_footprint(...) before the mutation in the same transaction; see docs/PREFLIGHT.md`);
    }
  }
  return errors;
}
// A named, owner-approved exemption from the footprint omission only. It must
// sit in the file's leading comment block, before any SQL:
//   -- footprint-exempt: <reason, at least 10 characters>
// It waives "lot mutation requires ... assert_no_physical_footprint" and
// nothing else: dynamic EXECUTE, nested DO and malformed SQL still fail.
const EXEMPT_HEADER = /^--\s*footprint-exempt:(.*)$/i;
const OMISSION = 'lot mutation requires BEGIN';
function footprintExemption(sql) {
  for (const line of sql.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    if (!text.startsWith('--')) return null;
    const match = text.match(EXEMPT_HEADER);
    if (match) return { reason: match[1].trim() };
  }
  return null;
}
function lintMigration(sql) {
  const errors = lintSql(sql);
  const exemption = footprintExemption(sql);
  if (!exemption) return { errors, exempt: null };
  if (exemption.reason.length < 10) {
    return { errors: [...errors, 'footprint-exempt header needs a reason of at least 10 characters'], exempt: null };
  }
  const waived = errors.filter(e => e.includes(OMISSION));
  return { errors: errors.filter(e => !e.includes(OMISSION)), exempt: { reason: exemption.reason, waived } };
}
function newMigrationFiles(base, head = 'HEAD', cwd = process.cwd()) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!/^[a-f0-9]{40}$/i.test(base)) throw new Error('Supply the full base commit SHA via --base; missing/zero history must not silently pass');
  git(['rev-parse', '--verify', `${base}^{commit}`]);
  git(['rev-parse', '--verify', `${head}^{commit}`]);
  return git(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', base, head, '--', 'packages/db/migrations/'])
    .split('\0').filter(p => /^packages\/db\/migrations\/[^/]+\.sql$/.test(p));
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--base') throw new Error('Usage: node scripts/check-new-lot-migrations.cjs --base <full-base-commit-sha>');
    const files = newMigrationFiles(args[1]);
    let failures = 0; let exempted = 0;
    for (const file of files) {
      const { errors, exempt } = lintMigration(execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' }));
      if (exempt) {
        console.log(`${file}: exempt (${exempt.reason}): ${exempt.waived.length} footprint omission(s) waived`);
        exempted++;
      }
      for (const error of errors) { console.error(`${file}: ${error}`); failures++; }
    }
    console.log(`New lot-migration lint: ${files.length} new SQL file(s), ${failures} omission(s), ${exempted} exempt. This is not proof of safe scope or warehouse clearance.`);
    process.exitCode = failures ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { lintSql, newMigrationFiles, tokens };
module.exports.lintMigration = lintMigration;
