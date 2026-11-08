#!/usr/bin/env node
// Quick verification that the pg_cron schedules from migration 0073 are
// installed and firing. Reads SUPABASE_* creds from .env.migrations.local.
//
// Usage: node scripts/verify-pg-cron.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tiny .env loader so we don't need dotenv as a dep.
const envFile = path.join(__dirname, '..', '.env.migrations.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
if (!TOKEN || !REF) {
  console.error('missing SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF');
  process.exit(1);
}

async function run(sql) {
  const r = await fetch(
    `https://api.supabase.com/v1/projects/${REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const json = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(json));
  return json;
}

const sections = [
  {
    label: 'cron.job (4 expected)',
    sql: `SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname`,
  },
  {
    label: 'recent job runs (last 60s, newest first)',
    sql: `SELECT jobid, status, start_time, end_time, return_message
          FROM cron.job_run_details
          WHERE start_time > now() - interval '60 seconds'
          ORDER BY start_time DESC LIMIT 15`,
  },
  {
    label: 'overdue live lots (expect 0 if engine is working)',
    sql: `SELECT count(*) AS overdue FROM public.lots
          WHERE status='live' AND close_at <= now()`,
  },
  {
    label: 'queue table sanity',
    sql: `SELECT 'product_cache_warm_jobs' AS t, count(*) AS n FROM public.product_cache_warm_jobs
          UNION ALL
          SELECT 'build_invoice_jobs', count(*) FROM public.build_invoice_jobs`,
  },
];

for (const s of sections) {
  console.log(`\n--- ${s.label} ---`);
  console.log(JSON.stringify(await run(s.sql), null, 2));
}
