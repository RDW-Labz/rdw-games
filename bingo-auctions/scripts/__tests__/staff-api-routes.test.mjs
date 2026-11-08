// Every /api/ path the staff app calls must have an operator-web route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const APP = join(ROOT, 'apps/field-mobile');
const API = join(ROOT, 'apps/operator-web/src/app/api');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function routes(dir = API, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routes(p, out);
    else if (name === 'route.ts' || name === 'route.js') {
      out.push(relative(API, p).split('/').slice(0, -1).join('/'));
    }
  }
  return out;
}

/** Exact segment match; a [param] or [...rest] route folder is a wildcard. */
export function matchesRoute(apiPath, routeDirs) {
  const wanted = apiPath.split('/').filter(Boolean);
  if (wanted.length && routeDirs.some((r) => r.startsWith(wanted.join('/') + '/'))) return true;
  return routeDirs.some((route) => {
    const have = route === '' ? [] : route.split('/');
    if (have.length === 0) return wanted.length === 0;
    let i = 0;
    for (; i < have.length; i++) {
      if (have[i].startsWith('[...')) return true;
      if (i >= wanted.length) return false;
      const wildcard = have[i].startsWith('[') && have[i].endsWith(']');
      if (!wildcard && have[i] !== wanted[i]) return false;
    }
    return i === wanted.length;
  });
}

function calledPaths(file) {
  const text = readFileSync(file, 'utf8');
  const out = [];
  for (const m of text.matchAll(/["'`](\/api(?:\/[^"'`?\s]*)?)/g)) {
    let raw = m[1].split('?')[0].replace(/\/$/, '');
    if (!raw || raw === '/api') continue;
    raw = raw.replace(/\$\{[^}]+\}/g, '*');
    out.push(raw.slice('/api'.length));
  }
  return out;
}

test('staff app API paths match full route folders', () => {
  const routeDirs = routes();
  const missing = new Set();
  for (const file of walk(APP)) {
    for (const path of calledPaths(file)) {
      if (!matchesRoute(path, routeDirs)) missing.add(`${relative(ROOT, file)} -> /api${path}`);
    }
  }
  assert.deepEqual([...missing], []);
});

test('empty route dir matches only /api, and a missing nested route fails', () => {
  assert.equal(matchesRoute('', ['']), true);
  assert.equal(matchesRoute('lots', ['']), false);
  assert.equal(matchesRoute('lots/123/refund', ['lots/[id]/refund']), true);
  assert.equal(matchesRoute('lots/123/refund', ['lots/[id]/paid']), false);
  assert.equal(matchesRoute('lots/123/refund', ['lots']), false);
});

test('staff package declares every workspace package it imports', () => {
  const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const missing = new Set();
  for (const file of walk(APP)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/from ['"]@auction-platform\/([a-z0-9-]+)['"]/g)) {
      if (!declared.has(`@auction-platform/${m[1]}`))
        missing.add(`@auction-platform/${m[1]} (${relative(ROOT, file)})`);
    }
  }
  assert.deepEqual([...missing], []);
});
