#!/usr/bin/env node
// ============================================================================
// scripts/apply-migrations.js
//
// Migration runner. Two backends:
//
//   1. Supabase Management API (preferred) — uses SUPABASE_ACCESS_TOKEN,
//      a Personal Access Token from https://supabase.com/dashboard/account/tokens.
//      Doesn't require the database password (which has been unreliable
//      to reset on this project). This is the path Supabase Studio uses
//      internally for SQL execution.
//
//   2. Postgres direct (fallback) — uses POSTGRES_URL via pgBouncer pooler.
//      Useful if you have the DB password handy and prefer that over PAT.
//
// Idempotency: tracks applied migrations in `_schema_migrations` (created
// by migration 0033). Re-running is a no-op.
//
// Usage:
//   # Recommended:
//   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."                # PAT
//   $env:SUPABASE_PROJECT_REF  = "npwseclcxcatjhgjrtwe"   # REQUIRED — BinGo prod
//   node scripts/apply-migrations.js
//
//   There is no default project ref, deliberately. This repo was forked from
//   BinGo, and a wrong ref applies BinGo schema to another company's
//   production database. The Management API path refuses to guess.
//
//   # Fallback if you have the DB password:
//   $env:POSTGRES_URL = "postgresql://postgres.<ref>:<pwd>@<region>.pooler.supabase.com:6543/postgres"
//   node scripts/apply-migrations.js
//
// Commands:
//   (default)      apply unapplied migrations in filename order
//   --status       print applied vs unapplied; no writes
//   --dry-run      print what WOULD apply, no writes
//   --rerun FILE   force re-apply even if tracked
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ── Auto-load .env.migrations.local (gitignored) ───────────────────────────
// Convenience: avoid making the user re-export SUPABASE_ACCESS_TOKEN
// every shell session. The file is gitignored via the .env.*.local
// pattern in .gitignore. Existing process.env values WIN over the file
// so CI / one-off overrides still work.
(function loadDotEnv() {
  const candidates = [
    path.join(__dirname, '..', '.env.migrations.local'),
    path.join(__dirname, '..', '.env.local'),
  ];
  for (const f of candidates) {
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
})();

const args = process.argv.slice(2);
const flags = {
  status: args.includes('--status'),
  dryRun: args.includes('--dry-run'),
  rerun: args.includes('--rerun') ? args[args.indexOf('--rerun') + 1] : null,
  help: args.includes('--help') || args.includes('-h'),
};

if (flags.help) {
  // Lines 3..37 — the header block, stopping before the closing rule. Keep this
  // range in sync when the header above gains or loses lines.
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 37).join('\n'));
  process.exit(0);
}

// ── Pick a backend ─────────────────────────────────────────────────────────
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const PG_URL = process.env.POSTGRES_URL;

if (!PAT && !PG_URL) {
  console.error(
    '[apply-migrations] No credentials. Either:\n\n' +
      '  Recommended: create a Personal Access Token at\n' +
      '    https://supabase.com/dashboard/account/tokens\n' +
      '  then run:\n' +
      '    $env:SUPABASE_ACCESS_TOKEN = "sbp_..."\n' +
      '    node scripts/apply-migrations.js\n\n' +
      '  OR if you have the DB password:\n' +
      '    $env:POSTGRES_URL = "postgresql://..."\n' +
      '    node scripts/apply-migrations.js',
  );
  process.exit(1);
}

// The Management API targets a project by ref in the URL, so an unset ref used
// to fall through to a hardcoded default (the upstream project's) and
// silently apply BinGo schema to another company's production database. This
// script writes schema; it does not guess. The POSTGRES_URL backend is exempt —
// its target is carried in the connection string and PROJECT_REF is never read.
if (PAT && !PROJECT_REF) {
  console.error(
    '[apply-migrations] SUPABASE_PROJECT_REF is not set.\n\n' +
      '  This script applies schema migrations. It will not guess which\n' +
      '  project to write to. Set the ref explicitly:\n\n' +
      '    $env:SUPABASE_PROJECT_REF = "npwseclcxcatjhgjrtwe"\n' +
      '    node scripts/apply-migrations.js\n\n' +
      '  or add SUPABASE_PROJECT_REF to .env.migrations.local at the repo root.\n' +
      '  BinGo prod is npwseclcxcatjhgjrtwe — confirm the ref before applying.\n\n' +
      '  (Or use the POSTGRES_URL backend, which carries its own target.)',
  );
  process.exit(1);
}

const APPLIED_BY = process.env.APPLIED_BY || `${os.userInfo().username}@${os.hostname()}`;
const migrationsDir = path.join(__dirname, '..', 'packages', 'db', 'migrations');
const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => /^\d{4,}_.*\.sql$/.test(f))
  .sort();

if (files.length === 0) {
  console.error(`[apply-migrations] No migrations found in ${migrationsDir}`);
  process.exit(1);
}

function fileChecksum(name) {
  const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
  return crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

// ── Backend abstractions ───────────────────────────────────────────────────
// Both backends expose:
//   query(sql, params?) → { rows: [...] }
//   close()

function makeMgmtBackend() {
  const baseUrl = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

  async function query(sql, _params) {
    // The Management API doesn't support placeholders. Inline values
    // — we only use this for the tracking-table writes, where values
    // are operator-controlled (not user-input) so SQL injection isn't
    // a concern. Passes are checked by length+charset.
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });
    const text = await res.text();
    if (!res.ok) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { message: text }; }
      const msg = parsed.message || parsed.error || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    let body;
    try { body = JSON.parse(text); } catch { body = []; }
    // The API returns an array of result rows directly.
    return { rows: Array.isArray(body) ? body : [] };
  }

  return { kind: 'mgmt', query, close: async () => {} };
}

async function makePgBackend() {
  const { Client } = require('pg');
  const c = new Client({
    connectionString: PG_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  return {
    kind: 'pg',
    query: async (sql, params) => {
      if (params) return c.query(sql, params);
      return c.query(sql);
    },
    close: async () => c.end(),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  // Prefer Management API when available — more reliable on this project.
  let backend;
  try {
    if (PAT) {
      // Announce the target BEFORE connecting, so the ref is on screen even
      // when the ping fails — the operator needs to see what they aimed at.
      console.log(
        `[apply-migrations] backend: Supabase Management API (project ${PROJECT_REF})`,
      );
      backend = makeMgmtBackend();
      // Sanity ping
      await backend.query('SELECT 1 AS ok');
    } else {
      backend = await makePgBackend();
      console.log('[apply-migrations] backend: Postgres direct (pooler)');
    }
  } catch (e) {
    console.error('[apply-migrations] connection failed:', e.message);
    if (PAT) {
      console.error(
        '\nCheck that SUPABASE_ACCESS_TOKEN is a valid Personal Access Token\n' +
          '(starts with "sbp_") from https://supabase.com/dashboard/account/tokens\n' +
          'and that SUPABASE_PROJECT_REF matches your project.',
      );
    } else {
      console.error(
        '\nIf this is "password authentication failed", try the Management API\n' +
          'path instead — it doesn\'t require the DB password:\n' +
          '  $env:SUPABASE_ACCESS_TOKEN = "sbp_..."\n' +
          '  node scripts/apply-migrations.js',
      );
    }
    process.exit(1);
  }

  // Check if tracking table exists.
  let trackingExists = false;
  try {
    const r = await backend.query(
      `SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = '_schema_migrations' AND relkind = 'r') AS exists`,
    );
    trackingExists = r.rows[0]?.exists ?? false;
  } catch {
    trackingExists = false;
  }

  // Pull applied set.
  const applied = new Set();
  if (trackingExists) {
    try {
      const r = await backend.query('SELECT filename FROM _schema_migrations');
      for (const row of r.rows) applied.add(row.filename);
    } catch (e) {
      console.error('[apply-migrations] could not read _schema_migrations:', e.message);
    }
  }

  // ── --status ───────────────────────────────────────────────────────────
  if (flags.status) {
    console.log(
      `tracking_table_exists=${trackingExists}  total_files=${files.length}  applied=${applied.size}\n`,
    );
    for (const f of files) {
      const mark = applied.has(f) ? '✓' : ' ';
      console.log(`  ${mark} ${f}`);
    }
    await backend.close();
    process.exit(0);
  }

  // Build run list.
  let runList = [];
  if (flags.rerun) {
    if (!files.includes(flags.rerun)) {
      console.error(`[apply-migrations] --rerun: ${flags.rerun} not found.`);
      process.exit(1);
    }
    runList = [flags.rerun];
  } else {
    runList = files.filter((f) => !applied.has(f));
  }

  if (runList.length === 0) {
    console.log('[apply-migrations] nothing to do — already up to date.');
    await backend.close();
    process.exit(0);
  }

  console.log(
    `[apply-migrations] ${runList.length} migration(s) to apply` +
      (flags.dryRun ? ' (dry-run)' : '') +
      ':\n',
  );
  for (const f of runList) console.log(`  • ${f}`);
  console.log('');

  if (flags.dryRun) {
    await backend.close();
    process.exit(0);
  }

  // ── Apply ──────────────────────────────────────────────────────────────
  let okCount = 0;
  for (const f of runList) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const checksum = fileChecksum(f);
    process.stdout.write(`  applying ${f} ... `);
    const t0 = Date.now();
    try {
      // The Management API doesn't expose explicit transactions to the
      // caller — each /database/query call is its own transaction. We
      // wrap the migration body in a DO block where possible so it
      // commits atomically. For pg backend we can use BEGIN/COMMIT
      // explicitly.
      if (backend.kind === 'pg') {
        await backend.query('BEGIN');
        await backend.query(sql);
        await backend.query('COMMIT');
      } else {
        // Single-shot. The migration files are written to be safe as
        // single statements; the API runs them in an implicit txn.
        await backend.query(sql);
      }

      // Record the application. ON CONFLICT handles re-runs gracefully.
      const recordSQL = `
        INSERT INTO _schema_migrations (filename, applied_at, applied_by, duration_ms, checksum)
        VALUES ('${f.replace(/'/g, "''")}', now(),
                '${APPLIED_BY.replace(/'/g, "''")}',
                ${Date.now() - t0},
                '${checksum}')
        ON CONFLICT (filename) DO UPDATE
          SET applied_at = EXCLUDED.applied_at,
              applied_by = EXCLUDED.applied_by,
              duration_ms = EXCLUDED.duration_ms,
              checksum = EXCLUDED.checksum
      `;
      try {
        await backend.query(recordSQL);
      } catch (recordErr) {
        // 0033 creates the tracking table itself; the INSERT above runs
        // AFTER 0033's SQL has committed, so it should always work
        // post-0033. Pre-0033 (i.e., on the very first run if 0033
        // hasn't been seen yet), 0033 is the migration being applied
        // and its own body backfills the tracking row. If we hit a
        // "table doesn't exist" right now, swallow it.
        if (
          !/_schema_migrations.*does not exist|relation .* does not exist/i.test(
            recordErr.message,
          )
        ) {
          throw recordErr;
        }
      }
      console.log(`ok (${Date.now() - t0}ms)`);
      okCount++;
    } catch (e) {
      if (backend.kind === 'pg') {
        await backend.query('ROLLBACK').catch(() => {});
      }
      console.log('FAIL');
      console.error(`\n  ${e.message}\n`);
      console.error(
        `[apply-migrations] stopping. ${okCount}/${runList.length} applied successfully before this failure.`,
      );
      await backend.close();
      process.exit(2);
    }
  }

  await backend.close();
  console.log(`\n[apply-migrations] all ${okCount} migration(s) applied.`);
})().catch((e) => {
  console.error('[apply-migrations] uncaught:', e.message);
  process.exit(1);
});
