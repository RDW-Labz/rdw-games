#!/usr/bin/env node
// Read or update Supabase Auth provider config via the Management API.
// Used to wire Google OAuth credentials + URI allowlist without dashboard
// clicks. Requires SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF in
// .env.migrations.local.
//
// Usage:
//   node scripts/supabase-auth-config.mjs get        # dump current config
//   node scripts/supabase-auth-config.mjs patch      # apply hardcoded
//                                                   # Google + allowlist
//                                                   # patch (edit body below)
//
// NEVER commit secrets to this file. Read them from env vars or stdin.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tiny .env loader.
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
  console.error('Missing SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF.');
  process.exit(1);
}

const cmd = process.argv[2];

async function getConfig() {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/config/auth`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) {
    console.error(`GET failed: ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  return r.json();
}

async function patchConfig(body) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/config/auth`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.error(`PATCH failed: ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  return r.json();
}

if (cmd === 'get') {
  const c = await getConfig();
  // Mask secrets when dumping
  for (const k of Object.keys(c)) {
    if (/secret|password|service_role|jwt/i.test(k) && typeof c[k] === 'string') {
      c[k] = c[k] ? `${c[k].slice(0, 6)}...(${c[k].length} chars)` : null;
    }
  }
  console.log(JSON.stringify(c, null, 2));
} else if (cmd === 'patch-google') {
  // Reads CLIENT_ID, CLIENT_SECRET, IOS_CLIENT_ID from env (passed at
  // invocation time so secrets never sit in a file). Updates Google
  // provider + URI allowlist atomically.
  const clientId = process.env.GOOGLE_OAUTH_WEB_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET;
  const iosClientId = process.env.GOOGLE_OAUTH_IOS_CLIENT_ID;
  if (!clientId || !clientSecret) {
    console.error('Missing GOOGLE_OAUTH_WEB_CLIENT_ID or GOOGLE_OAUTH_WEB_CLIENT_SECRET');
    process.exit(1);
  }

  // Preserve existing URI allowlist; add ours if missing.
  const current = await getConfig();
  const existingUris = (current.uri_allow_list || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const wanted = [
    'https://clovrbid.com/auth/callback',
    'https://clovrbid.com/reset-password',
    'https://clovrbid.com/**',
  ];
  // 2026-05-21: removed the ops.cluerholdings.com entries the script
  // used to re-add. Those were retained for v17 staff + v17 bidder
  // TestFlight builds still pointing at the old hostname; current
  // builds (bidder #22, staff #36) are well past that threshold, so
  // the old entries are dead weight. NOTE: this only prevents the
  // script from RE-ADDING them on the next run — if they're already
  // in Supabase Auth's uri_allow_list they stay there until manually
  // pruned via the Supabase dashboard.
  for (const u of wanted) if (!existingUris.includes(u)) existingUris.push(u);

  const body = {
    external_google_enabled: true,
    external_google_client_id: clientId,
    external_google_secret: clientSecret,
    external_google_skip_nonce_check: false,
    site_url: current.site_url || 'https://clovrbid.com',
    uri_allow_list: existingUris.join(','),
  };
  if (iosClientId) body.external_google_additional_client_ids = iosClientId;

  const result = await patchConfig(body);
  console.log('--- Patch successful ---');
  console.log('google_enabled:', result.external_google_enabled);
  console.log('google_client_id:', result.external_google_client_id);
  console.log(
    'google_secret_set:',
    !!result.external_google_secret,
    `(${(result.external_google_secret || '').length} chars stored)`,
  );
  console.log('google_additional_client_ids:', result.external_google_additional_client_ids);
  console.log('site_url:', result.site_url);
  console.log('uri_allow_list:', result.uri_allow_list);
} else {
  console.error('Usage: node scripts/supabase-auth-config.mjs <get|patch-google>');
  process.exit(1);
}
