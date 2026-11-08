#!/usr/bin/env node
// New functions must not stay callable by PUBLIC.
//
// Postgres grants EXECUTE on every new function and procedure to PUBLIC,
// which includes the anon and authenticated roles PostgREST exposes. On
// 2026-10-05 mig 0389 created claim_refund / release_refund with a GRANT to
// service_role only, and 0390 revoked anon and authenticated by name; both
// changed nothing, because PUBLIC still covered every caller (prod ACL after
// 0390: {=X/postgres,postgres=X/postgres,service_role=X/postgres}). 0391
// fixed it. This lint makes the next one fail in CI instead.
//
// Rule, for every NEW migration file in the diff (history is grandfathered):
// each CREATE [OR REPLACE] FUNCTION / PROCEDURE must be followed, in the same
// file, by a REVOKE ... ON FUNCTION|PROCEDURE|ROUTINE <same name> ... FROM
// ... PUBLIC, or by REVOKE ... ON ALL FUNCTIONS|ROUTINES IN SCHEMA <schema>
// FROM PUBLIC. One REVOKE per overload created. Grant the roles that should
// call it explicitly afterwards (anon for a public RPC, service_role for a
// server-only one). CREATE OR REPLACE keeps the old ACL, so a replaced
// function is checked too.
//
// Exempt: functions RETURNS trigger / event_trigger (Postgres refuses to call
// them directly), and a function named in an opt-out comment
//   -- lint:allow-public-execute <schema.name> <reason>
// for the rare function PUBLIC really should keep.
//
// Deliberately a syntax lint over the shared tokenizer, not a parser:
// function bodies and DO blocks are dollar-quoted literals and are not looked
// into, so a CREATE FUNCTION built with EXECUTE inside a DO block is outside it.
const { execFileSync } = require('node:child_process');
const { tokens, newMigrationFiles } = require('./check-new-lot-migrations.cjs');

const isWord = (t, v) => t?.kind === 'word' && (v === undefined || t.value === v);
const isName = (t) => t?.kind === 'word' || t?.kind === 'id';
const isSym = (t, v) => t?.kind === 'symbol' && t.value === v;
const nameVal = (t) => (t.kind === 'id' ? t.value : t.value.toLowerCase());

/** Read a possibly schema-qualified name at i → { key: 'schema.name', next }. */
function readName(ts, i) {
  if (!isName(ts[i])) return null;
  let schema = 'public';
  let name = nameVal(ts[i]);
  let next = i + 1;
  if (isSym(ts[next], '.') && isName(ts[next + 1])) {
    schema = name;
    name = nameVal(ts[next + 1]);
    next += 2;
  }
  return { key: `${schema}.${name}`, schema, next };
}

/** Index just past the parenthesised group that starts at i, or -1. */
function skipParens(ts, i) {
  if (!isSym(ts[i], '(')) return -1;
  let depth = 0;
  for (let j = i; j < ts.length; j++) {
    if (isSym(ts[j], '(')) depth++;
    else if (isSym(ts[j], ')')) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

function optOuts(rawSql) {
  const out = new Set();
  for (const m of rawSql.matchAll(/--\s*lint:allow-public-execute\s+("?[A-Za-z_][\w$]*"?(?:\.\s*"?[A-Za-z_][\w$]*"?)?)/g)) {
    const parts = m[1].replace(/\s+/g, '').split('.').map((p) => (p.startsWith('"') ? p.slice(1, -1) : p.toLowerCase()));
    out.add(parts.length === 2 ? `${parts[0]}.${parts[1]}` : `public.${parts[0]}`);
  }
  return out;
}

function lintGrants(sql) {
  const ts = tokens(sql);
  const created = new Map(); // key → count of overloads created
  const revoked = new Map(); // key → count of REVOKE ... FROM PUBLIC
  const revokedSchemas = new Set();
  for (let i = 0; i < ts.length; i++) {
    // CREATE [OR REPLACE] FUNCTION|PROCEDURE name ( ... ) [RETURNS ...]
    if (isWord(ts[i], 'create')) {
      let j = i + 1;
      if (isWord(ts[j], 'or') && isWord(ts[j + 1], 'replace')) j += 2;
      if (isWord(ts[j], 'function') || isWord(ts[j], 'procedure')) {
        const n = readName(ts, j + 1);
        if (!n) continue;
        const after = skipParens(ts, n.next);
        const returnsTrigger =
          after > 0 && isWord(ts[after], 'returns') && (isWord(ts[after + 1], 'trigger') || isWord(ts[after + 1], 'event_trigger'));
        if (!returnsTrigger) created.set(n.key, (created.get(n.key) ?? 0) + 1);
        i = n.next;
      }
      continue;
    }
    // REVOKE ... ON <kind> ... FROM ... PUBLIC ... ;
    if (isWord(ts[i], 'revoke')) {
      let end = i;
      while (end < ts.length && !isSym(ts[end], ';')) end++;
      const stmt = ts.slice(i, end);
      const onAt = stmt.findIndex((t) => isWord(t, 'on'));
      const fromAt = stmt.findIndex((t) => isWord(t, 'from'));
      if (onAt > 0 && fromAt > onAt && stmt.slice(fromAt + 1).some((t) => isWord(t, 'public'))) {
        const kind = stmt[onAt + 1];
        if (isWord(kind, 'all') && (isWord(stmt[onAt + 2], 'functions') || isWord(stmt[onAt + 2], 'routines')) && isWord(stmt[onAt + 3], 'in') && isWord(stmt[onAt + 4], 'schema')) {
          for (let k = onAt + 5; k < fromAt; k++) if (isName(stmt[k])) revokedSchemas.add(nameVal(stmt[k]));
        } else if (isWord(kind, 'function') || isWord(kind, 'procedure') || isWord(kind, 'routine')) {
          // One statement may name several: ON FUNCTION a(int), b(text)
          let k = onAt + 2;
          while (k < fromAt) {
            const n = readName(stmt, k);
            if (!n) { k++; continue; }
            revoked.set(n.key, (revoked.get(n.key) ?? 0) + 1);
            const after = skipParens(stmt, n.next);
            k = after > 0 ? after : n.next;
            if (isSym(stmt[k], ',')) k++;
          }
        }
      }
      i = end;
    }
  }
  const allowed = optOuts(sql);
  const errors = [];
  for (const [key, count] of created) {
    if (allowed.has(key)) continue;
    if (revokedSchemas.has(key.split('.')[0])) continue;
    const got = revoked.get(key) ?? 0;
    if (got < count) {
      errors.push(
        `${key}: created ${count === 1 ? 'without' : `${count} times with only ${got}`} a REVOKE EXECUTE ... FROM PUBLIC. ` +
          `New functions are callable by anon/authenticated through PUBLIC until revoked; revoke PUBLIC, then grant the roles that should call it.`,
      );
    }
  }
  return errors;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--base') throw new Error('Usage: node scripts/check-function-grants.cjs --base <full-base-commit-sha>');
    const files = newMigrationFiles(args[1]);
    let failures = 0;
    for (const file of files) {
      const errors = lintGrants(execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' }));
      for (const error of errors) { console.error(`${file}: ${error}`); failures++; }
    }
    console.log(`Function-grants lint: ${files.length} new SQL file(s), ${failures} function(s) still executable by PUBLIC.`);
    process.exitCode = failures ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { lintGrants };
