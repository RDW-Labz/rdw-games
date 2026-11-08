// scripts/mega-sim/lib/env.js
//
// Auto-load env vars from candidate .env files in the right precedence
// order. Existing process.env values WIN — keeps CI overrides clean.
// Same pattern as scripts/apply-migrations.js and scripts/smoke-test-e2e.js.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');

const CANDIDATES = [
  path.join(ROOT, '.env.smoke.local'),
  path.join(ROOT, '.env.migrations.local'),
  path.join(ROOT, '.env.local'),
  path.join(ROOT, 'apps', 'operator-web', '.env.local'),
  path.join(ROOT, 'apps', 'operator-web', '.env'),
];

function loadEnv() {
  for (const f of CANDIDATES) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

function pickEnv(keys) {
  const out = {};
  for (const k of keys) out[k] = process.env[k] || null;
  return out;
}

function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `[mega-sim] Missing required env vars: ${missing.join(', ')}.\n` +
        `Set them in .env.local at the repo root, .env.migrations.local, or export before running.`,
    );
  }
}

module.exports = { loadEnv, pickEnv, requireEnv };
