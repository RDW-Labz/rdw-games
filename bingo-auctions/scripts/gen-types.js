#!/usr/bin/env node
// ============================================================================
// scripts/gen-types.js
//
// Regenerates packages/shared/src/database.types.ts from the live
// Supabase project. Wraps `supabase gen types typescript` so:
//
//   1. SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF are loaded from the
//      existing .env.migrations.local (gitignored) automatically — no
//      need to re-export every shell session.
//   2. The output target is fixed (packages/shared/src/database.types.ts)
//      so the file lives next to its `@auction-platform/shared/database.types`
//      export.
//   3. Run via `npm run db:types`.
//
// Audit notes:
//   - The types file is committed so apps can typecheck without DB access.
//   - Re-run after every migration that changes a table/column/RPC
//     signature. CI should drift-check this in the future.
//   - The Supabase CLI version matters: pinned via package.json devDep
//     (currently 2.x).
//
// Usage:
//   npm run db:types
//
// Override env in the shell to point at a different project:
//   SUPABASE_PROJECT_REF=... SUPABASE_ACCESS_TOKEN=... npm run db:types
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ── Auto-load .env.migrations.local (same loader pattern as apply-migrations.js)
(function loadDotEnv() {
  const candidates = [
    path.join(__dirname, '..', '.env.migrations.local'),
    path.join(__dirname, '..', '.env.local'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    }
  }
})();

const projectRef = process.env.SUPABASE_PROJECT_REF;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;

if (!projectRef || !accessToken) {
  console.error('[gen-types] Missing SUPABASE_PROJECT_REF or SUPABASE_ACCESS_TOKEN.');
  console.error('[gen-types] Set them in .env.migrations.local or your shell env.');
  process.exit(1);
}

const outPath = path.join(
  __dirname,
  '..',
  'packages',
  'shared',
  'src',
  'database.types.ts',
);

console.log('[gen-types] project=' + projectRef + ' → ' + path.relative(process.cwd(), outPath));

// shell:true so Windows can resolve npx.cmd through PATH the same way
// the user's terminal does. The CLI prints types to stdout; we capture
// stdout and write it to the output file. maxBuffer bumped because the
// generated file is ~80KB and growing.
const res = spawnSync(
  'npx supabase gen types typescript --project-id ' + projectRef + ' --schema public',
  {
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken },
    encoding: 'utf8',
    shell: true,
    maxBuffer: 16 * 1024 * 1024,
  },
);

if (res.status !== 0) {
  console.error('[gen-types] supabase CLI failed (exit ' + res.status + '):');
  console.error(res.stderr || res.stdout);
  process.exit(res.status || 1);
}

fs.writeFileSync(outPath, res.stdout, 'utf8');
const lineCount = res.stdout.split('\n').length;
console.log('[gen-types] wrote ' + lineCount + ' lines');
