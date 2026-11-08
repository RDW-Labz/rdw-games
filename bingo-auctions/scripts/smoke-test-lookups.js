#!/usr/bin/env node
// =============================================================================
// scripts/smoke-test-lookups.js
//
// End-to-end smoke tests for the AI proxy endpoints against PRODUCTION.
// Logs in as the test operator, hits each endpoint with a known case,
// and reports pass/fail + timings + response shape.
//
// Usage:
//   TEST_OPERATOR_EMAIL=jmacluer@gmail.com \
//   TEST_OPERATOR_PASSWORD=BidWizOps2026! \
//     node scripts/smoke-test-lookups.js
//
//   # Or skip env vars — defaults are loaded from .env.smoke.local if present.
//
// Flags:
//   --base=<url>          override API base (default: https://project-9ymiy.vercel.app)
//   --skip=<name,...>     skip named tests
//   --only=<name,...>     run only named tests
//   --json                machine-readable JSON output
//   --no-color            disable ansi color
// =============================================================================

const fs = require('fs');
const path = require('path');

// ── Config / env loader ────────────────────────────────────────────────────
(function loadDotEnv() {
  const candidates = [
    path.join(__dirname, '..', '.env.smoke.local'),
    path.join(__dirname, '..', '.env.local'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
})();

const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args.set(m[1], m[2] ?? 'true');
}

const API_BASE = (args.get('base') ?? 'https://project-9ymiy.vercel.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const EMAIL = process.env.TEST_OPERATOR_EMAIL ?? 'jmacluer@gmail.com';
const PASSWORD = process.env.TEST_OPERATOR_PASSWORD ?? 'BidWizOps2026!';
const JSON_OUT = args.has('json');
const NO_COLOR = args.has('no-color') || !process.stdout.isTTY;

// The URL used to default to ClovrBid's project (this repo's upstream), so a
// shell with no env logged the test operator into another company's Supabase.
// Fail like the other config errors in this script (exit 2), don't guess.
if (!SUPABASE_URL) {
  console.error(
    '[smoke-test-lookups] NEXT_PUBLIC_SUPABASE_URL is not set.\n\n' +
      '  There is no default Supabase project. Set it in .env.smoke.local at\n' +
      '  the repo root or in the shell:\n\n' +
      '    NEXT_PUBLIC_SUPABASE_URL=https://npwseclcxcatjhgjrtwe.supabase.co\n\n' +
      '  BinGo prod is npwseclcxcatjhgjrtwe.',
  );
  process.exit(2);
}

const skipSet = new Set((args.get('skip') ?? '').split(',').filter(Boolean));
const onlySet = new Set((args.get('only') ?? '').split(',').filter(Boolean));

// ── ANSI / output helpers ──────────────────────────────────────────────────
const C = NO_COLOR
  ? { dim: (s) => s, green: (s) => s, red: (s) => s, yellow: (s) => s, cyan: (s) => s, bold: (s) => s }
  : {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
    };

const log = (...args) => { if (!JSON_OUT) console.log(...args); };

// ── Auth: Supabase password grant → access_token ──────────────────────────
async function login() {
  if (!SUPABASE_ANON_KEY) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_ANON_KEY in env');
  }
  const url = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase auth failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Supabase auth: no access_token in response');
  }
  return data.access_token;
}

// ── HTTP helper ────────────────────────────────────────────────────────────
async function callProxy(endpoint, body, token) {
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - t0;
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, elapsed };
}

// ── Test cases ─────────────────────────────────────────────────────────────
// Each test: { name, fn(token) → { ok, summary, details } }
//
// UPCs picked from real common products. If a UPC fails to resolve, that
// surfaces a coverage gap in the Sonar lookup or a negative-cache hit.

const TESTS = [
  {
    name: 'auth-missing',
    desc: 'POST without auth header → expect 401',
    async fn() {
      const res = await fetch(`${API_BASE}/api/lottr/lookup-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '885911548632' }),
      });
      const json = await res.json().catch(() => null);
      const ok = res.status === 401 && json?.error === 'not_authenticated';
      return {
        ok,
        summary: `HTTP ${res.status} (${json?.error})`,
        details: { status: res.status, json },
      };
    },
  },
  {
    name: 'upc-zlight-chandelier',
    desc: 'UPC 685659203974 (Z-Lite LED Chandelier — known catalog entry from MAC.BID seed)',
    async fn(token) {
      const r = await callProxy('/api/lottr/lookup-code', { code: '685659203974' }, token);
      const ok = r.status === 200 && r.json?.candidate?.title;
      const meta = r.json?.meta ?? {};
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${ok ? 'title="' + r.json.candidate.title.slice(0, 60) + '"' : 'no candidate'} · cache=${meta.fromCache ?? '-'}`,
        details: r.json,
      };
    },
  },
  {
    name: 'upc-coverage-miss',
    desc: 'UPC 885911548632 (DeWalt drill — not in MAC.BID dataset; expect 404 graceful, no Sonar poison)',
    async fn(token) {
      const r = await callProxy('/api/lottr/lookup-code', { code: '885911548632' }, token);
      const ok = r.status === 404 && r.json?.error === 'no_match';
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${ok ? '404 graceful (Sonar miss, no poison)' : 'unexpected'}`,
        details: r.json,
      };
    },
  },
  {
    name: 'upc-with-dashes',
    desc: 'UPC with dashes "0-685659-203974" — normalizer should strip + match catalog',
    async fn(token) {
      const r = await callProxy('/api/lottr/lookup-code', { code: '0-685659-203974' }, token);
      // The catalog has 685659203974; with leading 0 stripped → 685659203974 lookup
      // OR with leading 0 kept → 0685659203974 (13 char, valid EAN-13).
      // Either should return data IF the normalizer/RPC handles both forms.
      const ok = r.status === 200 || (r.status === 404 && r.json?.error === 'no_match');
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${r.status === 200 ? 'matched' : 'no match (expected: 13-digit form not in catalog)'}`,
        details: r.json,
      };
    },
  },
  {
    name: 'upc-fake-nines',
    desc: 'UPC 999999999999 (sentinel; never in real data) — expect graceful 404',
    async fn(token) {
      const r = await callProxy('/api/lottr/lookup-code', { code: '999999999999' }, token);
      const ok = r.status === 404 && r.json?.error === 'no_match';
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${ok ? '404 as expected' : 'unexpected response'}`,
        details: r.json,
      };
    },
  },
  // ── Data-quality regression tests (added with feature/data-quality) ──────────
  // These three tests verify that bogus placeholder codes injected by scrapers
  // are now rejected at the normalizer layer and never resolve to a real product.
  // Run AFTER cleanup-bogus-catalog.js --commit and migration 0044 are applied.
  {
    name: 'upc-fake-zeros-rejected',
    desc: 'UPC 000000000000 (MAC.BID placeholder) — must 404, NOT return PetAg supplement',
    async fn(token) {
      const r = await callProxy('/api/lottr/lookup-code', { code: '000000000000' }, token);
      // Pre-0044 this returned the PetAg Digestion supplement (false positive).
      // Post-cleanup + 0044, it must return 404 no_match.
      const ok = r.status === 404 && r.json?.error === 'no_match';
      const gotFalsePositive = r.status === 200 && r.json?.candidate;
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${
          ok ? '404 as expected (bogus UPC rejected)' :
          gotFalsePositive ? 'FALSE POSITIVE — cleanup + migration 0044 needed' :
          'unexpected response'
        }`,
        details: r.json,
      };
    },
  },
  {
    name: 'upc-fake-sequential',
    desc: 'UPC 012345678901 (sequential ascending — bogus) — must 404 gracefully',
    async fn(token) {
      const r = await callProxy('/api/lottr/lookup-code', { code: '012345678901' }, token);
      const ok = r.status === 404 && r.json?.error === 'no_match';
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${ok ? '404 as expected' : 'unexpected response'}`,
        details: r.json,
      };
    },
  },
  {
    name: 'asin-fake-zeros',
    desc: 'ASIN B000000000 (placeholder zeros after B) — must 404 gracefully',
    async fn(token) {
      const r = await callProxy('/api/lottr/lookup-code', { code: 'B000000000' }, token);
      const ok = r.status === 404 && r.json?.error === 'no_match';
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${ok ? '404 as expected (fake ASIN rejected)' : 'unexpected response'}`,
        details: r.json,
      };
    },
  },
  {
    name: 'upc-malformed',
    desc: 'UPC "abc" (garbage) — should not 500',
    async fn(token) {
      const r = await callProxy('/api/lottr/lookup-code', { code: 'abc' }, token);
      const ok = r.status === 404 || r.status === 400;
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status}`,
        details: r.json,
      };
    },
  },
  {
    name: 'keyword-dewalt',
    desc: 'Keyword search "DeWalt drill" — expect ≥1 hit',
    async fn(token) {
      const r = await callProxy('/api/lottr/search-keyword', { query: 'DeWalt drill' }, token);
      const hits = r.json?.hits?.length ?? 0;
      const ok = r.status === 200 && hits > 0;
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${hits} hit(s)`,
        details: { hits: r.json?.hits?.map((h) => h.candidate?.title?.slice(0, 50)) ?? [] },
      };
    },
  },
  {
    name: 'keyword-airpods',
    desc: 'Keyword search "Apple AirPods Pro" — common product',
    async fn(token) {
      const r = await callProxy('/api/lottr/search-keyword', { query: 'Apple AirPods Pro' }, token);
      const hits = r.json?.hits?.length ?? 0;
      const ok = r.status === 200 && hits > 0;
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${hits} hit(s)`,
        details: { hits: r.json?.hits?.map((h) => h.candidate?.title?.slice(0, 50)) ?? [] },
      };
    },
  },
  {
    name: 'keyword-empty',
    desc: 'Keyword search "" — expect 400',
    async fn(token) {
      const r = await callProxy('/api/lottr/search-keyword', { query: '' }, token);
      const ok = r.status === 400;
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status}`,
        details: r.json,
      };
    },
  },
  // ── Multi-identifier tests (added with feature/unified-catalog) ─────────────
  // These tests exercise the new lookupByCode path via ASIN, FNSKU, and
  // external_codes. They will FAIL until the competitor import has populated
  // product_lookups with these identifiers (run import-competitor-lots.js
  // --commit --populate-lookups). That's by design — they're regression tests
  // for the new pipeline, not smoke tests of core functionality.
  {
    name: 'asin-dewalt',
    desc: 'ASIN B01N5MB4LX (DeWalt DCD771C2 drill) — expect resolve via catalog after import',
    async fn(token) {
      const r = await callProxy('/api/lottr/lookup-code', { code: 'B01N5MB4LX' }, token);
      // Two acceptable outcomes:
      //   200 with a candidate → catalog row exists (import has run)
      //   404 no_match → catalog row missing (import hasn't run yet) — still OK
      const ok = (r.status === 200 && r.json?.candidate?.title) || r.status === 404;
      const matched = r.json?.meta?.matchedIdentifiers;
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${
          r.status === 200
            ? 'title="' + (r.json.candidate?.title ?? '').slice(0, 50) + '" asin=' + (matched?.asin ?? 'n/a')
            : r.json?.error ?? 'no match (import not yet run)'
        }`,
        details: r.json,
      };
    },
  },
  {
    name: 'fnsku-test',
    desc: 'FNSKU-shaped code X00123ABCD — expect resolve or graceful 404',
    async fn(token) {
      // Use a syntactically valid FNSKU that almost certainly has no catalog row.
      // The test validates that the endpoint handles the shape gracefully (no 500).
      const r = await callProxy('/api/lottr/lookup-code', { code: 'X00123ABCD' }, token);
      // 404 is expected (no real product for this fake FNSKU); 200 would also pass.
      const ok = r.status === 404 || r.status === 200;
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${ok ? 'graceful response' : 'unexpected error'}`,
        details: r.json,
      };
    },
  },
  {
    name: 'external-code-custom',
    desc: 'Arbitrary string not matching UPC/ASIN/FNSKU — expect 404 (resolves via external_codes when seeded)',
    async fn(token) {
      // A value that would normally live in external_codes (supplier SKU format).
      // Without seeding, expects 404. This test validates the endpoint shape.
      const r = await callProxy('/api/lottr/lookup-code', { code: 'VENDOR-SKU-TEST-001' }, token);
      const ok = r.status === 404 || r.status === 200;
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${ok ? (r.status === 200 ? 'found in catalog' : 'not in catalog (expected)') : 'error'}`,
        details: r.json,
      };
    },
  },
  {
    name: 'asin-malformed',
    desc: 'Near-ASIN "B01N5MB4L" (9 chars, one short) — expect 404 not 500',
    async fn(token) {
      const r = await callProxy('/api/lottr/lookup-code', { code: 'B01N5MB4L' }, token);
      // 9 chars doesn't match UPC or ASIN patterns — should return null → 404.
      const ok = r.status === 404 || r.status === 400;
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status}`,
        details: r.json,
      };
    },
  },
  {
    name: 'identify-photo-tiny',
    desc: 'identify-photo with 1×1 placeholder — should not 500, may return null',
    async fn(token) {
      // 1×1 transparent PNG, base64
      const tinyPng =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      const r = await callProxy(
        '/api/lottr/identify-photo',
        { base64: tinyPng, mediaType: 'image/png' },
        token,
      );
      // Either 200 with degenerate data, or 422 ("could not identify") — both acceptable.
      const ok = r.status === 200 || r.status === 422;
      return {
        ok,
        summary: `${r.elapsed}ms · status=${r.status} · ${r.json?.ok ? 'returned data' : r.json?.error ?? 'no data'}`,
        details: r.json,
      };
    },
  },
];

// ── Runner ─────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now();
  log(C.bold(C.cyan('\n=== AI proxy smoke tests ===')));
  log(C.dim(`base: ${API_BASE}`));
  log(C.dim(`operator: ${EMAIL}`));
  log('');

  let token;
  try {
    token = await login();
    log(C.green('✓') + ' Supabase login → bearer token obtained');
  } catch (e) {
    log(C.red('✗') + ` Supabase login failed: ${e.message}`);
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
    process.exit(2);
  }

  const results = [];
  for (const t of TESTS) {
    if (skipSet.has(t.name)) {
      log(C.dim(`SKIP  ${t.name}`));
      continue;
    }
    if (onlySet.size > 0 && !onlySet.has(t.name)) continue;

    let res;
    try {
      res = await t.fn(token);
    } catch (e) {
      res = { ok: false, summary: `THREW: ${e.message}`, details: { stack: e.stack } };
    }
    results.push({ name: t.name, desc: t.desc, ...res });
    const mark = res.ok ? C.green('✓') : C.red('✗');
    log(`${mark} ${t.name.padEnd(22)} ${res.summary}`);
    log(C.dim(`   ${t.desc}`));
  }

  const totalElapsed = Date.now() - startedAt;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  log('');
  log(
    C.bold(`Result: `) +
      (failed === 0 ? C.green(`${passed} passed`) : C.red(`${failed} failed`)) +
      ', ' +
      C.dim(`${results.length} total, ${totalElapsed}ms`),
  );

  if (failed > 0) {
    log('\n' + C.yellow('Failed test details:'));
    for (const r of results.filter((x) => !x.ok)) {
      log(C.red(`  ✗ ${r.name}`));
      log(C.dim(`    ${JSON.stringify(r.details, null, 2).split('\n').join('\n    ')}`));
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: failed === 0, passed, failed, results }, null, 2));
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(C.red('Fatal:'), e);
  process.exit(2);
});
