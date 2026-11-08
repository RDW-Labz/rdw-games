// scripts/mega-sim/lib/assert.js
//
// Assertion + step runner. Each `step(name, fn)` is a guarded async
// block that records pass/fail with rich context. Failures don't abort
// the run — they accumulate and get reported at the end so we see the
// full picture, not just the first crash.
//
//   await step('lot exists in_inventory', async () => {
//     const r = await query();
//     expect(r.status).toBe('in_inventory');
//   });

'use strict';

const C = {
  red: (s) => '\x1b[31m' + s + '\x1b[0m',
  green: (s) => '\x1b[32m' + s + '\x1b[0m',
  yellow: (s) => '\x1b[33m' + s + '\x1b[0m',
  cyan: (s) => '\x1b[36m' + s + '\x1b[0m',
  dim: (s) => '\x1b[2m' + s + '\x1b[0m',
  bold: (s) => '\x1b[1m' + s + '\x1b[0m',
};

const _results = [];
let _currentPhase = '(unset)';

function setPhase(name) {
  _currentPhase = name;
  console.log('\n' + C.bold(C.cyan('── ' + name + ' ' + '─'.repeat(Math.max(0, 60 - name.length)))));
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) {
        const e = new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        e.assertion = { actual, expected, kind: 'toBe' };
        throw e;
      }
    },
    toEqual(expected) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        const e = new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        e.assertion = { actual, expected, kind: 'toEqual' };
        throw e;
      }
    },
    toBeTruthy(msg) {
      if (!actual) {
        const e = new Error(`expected truthy${msg ? ' (' + msg + ')' : ''}, got ${JSON.stringify(actual)}`);
        e.assertion = { actual, kind: 'toBeTruthy' };
        throw e;
      }
    },
    toBeNull() {
      if (actual !== null && actual !== undefined) {
        const e = new Error(`expected null, got ${JSON.stringify(actual).slice(0, 200)}`);
        e.assertion = { actual, kind: 'toBeNull' };
        throw e;
      }
    },
    toMatch(re) {
      if (typeof actual !== 'string' || !re.test(actual)) {
        const e = new Error(`expected match ${re}, got ${JSON.stringify(actual)}`);
        e.assertion = { actual, expected: re.toString(), kind: 'toMatch' };
        throw e;
      }
    },
    toBeGreaterThan(n) {
      if (!(actual > n)) {
        const e = new Error(`expected > ${n}, got ${actual}`);
        e.assertion = { actual, expected: n, kind: 'toBeGreaterThan' };
        throw e;
      }
    },
    toBeAtMost(n) {
      if (!(actual <= n)) {
        const e = new Error(`expected ≤ ${n}, got ${actual}`);
        e.assertion = { actual, expected: n, kind: 'toBeAtMost' };
        throw e;
      }
    },
    toContain(item) {
      if (!Array.isArray(actual) || actual.indexOf(item) === -1) {
        const e = new Error(`expected to contain ${JSON.stringify(item)}, got ${JSON.stringify(actual).slice(0, 200)}`);
        e.assertion = { actual, expected: item, kind: 'toContain' };
        throw e;
      }
    },
    oneOf(set) {
      if (set.indexOf(actual) === -1) {
        const e = new Error(`expected one of ${JSON.stringify(set)}, got ${JSON.stringify(actual)}`);
        e.assertion = { actual, expected: set, kind: 'oneOf' };
        throw e;
      }
    },
  };
}

async function step(name, fn) {
  const t0 = process.hrtime.bigint();
  let ok = true;
  let error = null;
  let context = null;
  try {
    const ret = await fn();
    if (ret && typeof ret === 'object' && ret.context) context = ret.context;
  } catch (e) {
    ok = false;
    error = e.message || String(e);
    if (e.assertion) context = { assertion: e.assertion };
    else if (e.cause) context = { cause: String(e.cause).slice(0, 500) };
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1_000_000;
  _results.push({
    phase: _currentPhase,
    name,
    ok,
    ms,
    error,
    context,
    ts: Date.now(),
  });
  const mark = ok ? C.green('✓') : C.red('✗');
  const tail = ok
    ? C.dim(' ' + ms.toFixed(0) + 'ms')
    : C.red(' ' + (error || '').slice(0, 120));
  console.log('  ' + mark + ' ' + name + tail);
  return ok;
}

function getResults() {
  return _results.slice();
}

function clearResults() {
  _results.length = 0;
  _currentPhase = '(unset)';
}

function summary() {
  const total = _results.length;
  const passed = _results.filter((r) => r.ok).length;
  const failed = total - passed;
  return { total, passed, failed };
}

module.exports = { C, step, expect, setPhase, getResults, clearResults, summary };
