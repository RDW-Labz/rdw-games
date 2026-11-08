#!/usr/bin/env node
// Audit recent LotTR activity for Michael's cluer-test operator to find
// where photo saves are failing. Looks at ai_calls, lots, storage objects,
// and storage bucket config.
//
// Usage: node scripts/audit-lottr-activity.mjs
//
// Notes on schema (verified 2026-05-13):
//  - ai_calls is a cost/observability log: (task, model, input_tokens,
//    output_tokens, cost_cents, latency_ms, cached, escalation_tier, lot_id,
//    operator_id, user_id, created_at). There is no status / error_message
//    column — it's the "successful AI call" log.
//  - lots.photo_urls is text[] (no photo_url, no images_jsonb, no
//    ai_metadata). Photo presence == array_length(photo_urls) > 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const OPERATOR_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '2ef933f7-9f4a-4037-b3c9-fe89223979e9';

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
  if (!r.ok) {
    return { __error: true, status: r.status, body: json };
  }
  return json;
}

const sections = [
  {
    label: '1) Recent ai_calls (last 24h, top 50, newest first)',
    sql: `SELECT task, model, input_tokens, output_tokens, cost_cents,
                 latency_ms, cached, escalation_tier, lot_id, operator_id,
                 user_id, created_at
            FROM ai_calls
           WHERE created_at > now() - interval '24 hours'
           ORDER BY created_at DESC
           LIMIT 50`,
  },
  {
    label: '1b) ai_calls task distribution (last 24h)',
    sql: `SELECT task, model, COUNT(*) AS n,
                 SUM(cost_cents) AS total_cents,
                 AVG(latency_ms)::int AS avg_latency_ms
            FROM ai_calls
           WHERE created_at > now() - interval '24 hours'
           GROUP BY task, model
           ORDER BY n DESC`,
  },
  {
    label: `1c) ai_calls for Michael's operator (last 24h)`,
    sql: `SELECT task, model, latency_ms, cost_cents, lot_id, created_at
            FROM ai_calls
           WHERE operator_id = '${OPERATOR_ID}'
             AND created_at > now() - interval '24 hours'
           ORDER BY created_at DESC
           LIMIT 50`,
  },
  {
    label: `2) Recent lots (last 24h, operator=${OPERATOR_ID})`,
    sql: `SELECT id, lot_code, title, status,
                 array_length(photo_urls, 1) AS photo_count,
                 photo_urls,
                 source,
                 created_at
            FROM lots
           WHERE operator_id = '${OPERATOR_ID}'
             AND created_at > now() - interval '24 hours'
           ORDER BY created_at DESC
           LIMIT 30`,
  },
  {
    label: '2b) lots photo population summary (last 24h, this operator)',
    sql: `SELECT
            COUNT(*) AS total_lots,
            COUNT(*) FILTER (WHERE photo_urls IS NOT NULL
                              AND array_length(photo_urls, 1) > 0) AS with_photos,
            COUNT(*) FILTER (WHERE photo_urls IS NULL
                              OR array_length(photo_urls, 1) IS NULL) AS without_photos,
            COUNT(*) FILTER (WHERE source = 'lottr') AS source_lottr,
            COUNT(DISTINCT source) AS distinct_sources
          FROM lots
         WHERE operator_id = '${OPERATOR_ID}'
           AND created_at > now() - interval '24 hours'`,
  },
  {
    label: `2c) Last 7d lots for Michael, status x has-photos cross-tab`,
    sql: `SELECT status, source,
                 COUNT(*) AS n,
                 COUNT(*) FILTER (WHERE photo_urls IS NOT NULL
                                   AND array_length(photo_urls, 1) > 0)
                   AS with_photos
            FROM lots
           WHERE operator_id = '${OPERATOR_ID}'
             AND created_at > now() - interval '7 days'
           GROUP BY status, source
           ORDER BY n DESC`,
  },
  {
    label: '3) storage.objects (last 24h, top 30)',
    sql: `SELECT name, bucket_id, created_at, owner,
                 (metadata->>'size')::bigint AS size_bytes,
                 metadata->>'mimetype' AS mimetype,
                 (metadata->>'httpStatusCode')::int AS http_status
            FROM storage.objects
           WHERE created_at > now() - interval '24 hours'
           ORDER BY created_at DESC
           LIMIT 30`,
  },
  {
    label: '3b) storage.objects bucket breakdown (last 24h) + size stats',
    sql: `SELECT bucket_id,
                 COUNT(*) AS n_objects,
                 COUNT(*) FILTER (WHERE (metadata->>'size')::bigint = 0)
                   AS zero_byte_objects,
                 MIN((metadata->>'size')::bigint) AS min_size,
                 MAX((metadata->>'size')::bigint) AS max_size,
                 AVG((metadata->>'size')::bigint)::bigint AS avg_size
            FROM storage.objects
           WHERE created_at > now() - interval '24 hours'
           GROUP BY bucket_id
           ORDER BY n_objects DESC`,
  },
  {
    label: '3c) storage.objects uploaded by Michael (last 7d, with sizes)',
    sql: `SELECT name, bucket_id, created_at,
                 (metadata->>'size')::bigint AS size_bytes,
                 metadata->>'mimetype' AS mimetype
            FROM storage.objects
           WHERE owner = '${USER_ID}'
             AND created_at > now() - interval '7 days'
           ORDER BY created_at DESC
           LIMIT 30`,
  },
  {
    label: '3d) ALL storage.objects size stats (lifetime, all buckets)',
    sql: `SELECT bucket_id,
                 COUNT(*) AS n_objects,
                 COUNT(*) FILTER (WHERE (metadata->>'size')::bigint = 0)
                   AS zero_byte_objects,
                 COUNT(*) FILTER (WHERE (metadata->>'size')::bigint > 0)
                   AS non_zero_objects
            FROM storage.objects
           GROUP BY bucket_id
           ORDER BY bucket_id`,
  },
  {
    label: '4) storage.buckets',
    sql: `SELECT id, name, public, file_size_limit, allowed_mime_types
            FROM storage.buckets
           ORDER BY name`,
  },
  {
    label: '5) public tables with error-style columns (informational)',
    sql: `SELECT table_schema, table_name, column_name
            FROM information_schema.columns
           WHERE column_name IN ('error_message', 'last_error', 'error')
             AND table_schema = 'public'
           ORDER BY table_schema, table_name`,
  },
  {
    label: '5b) imports.error rows (last 7d, this operator if applicable)',
    sql: `SELECT id, status, error, created_at
            FROM imports
           WHERE created_at > now() - interval '7 days'
             AND (operator_id = '${OPERATOR_ID}' OR operator_id IS NULL)
             AND error IS NOT NULL
           ORDER BY created_at DESC
           LIMIT 20`,
  },
  {
    label: '6) lots created in last 24h that match the operator/storage-path '
         + 'lot_codes (CLU-001034..CLU-001044)',
    sql: `SELECT lot_code,
                 id,
                 array_length(photo_urls, 1) AS photo_count,
                 photo_urls,
                 status,
                 source,
                 created_at
            FROM lots
           WHERE operator_id = '${OPERATOR_ID}'
             AND lot_code BETWEEN 'CLU-001032' AND 'CLU-001050'
           ORDER BY lot_code DESC`,
  },
];

const results = {};
for (const s of sections) {
  console.log(`\n--- ${s.label} ---`);
  const out = await run(s.sql);
  results[s.label] = out;
  console.log(JSON.stringify(out, null, 2));
}

const outFile = path.join(__dirname, '..', 'tmp', 'lottr-audit-output.json');
try {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\nFull results written to ${outFile}`);
} catch (e) {
  console.warn(`Could not write ${outFile}:`, e.message);
}
