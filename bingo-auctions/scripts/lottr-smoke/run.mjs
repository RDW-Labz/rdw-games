#!/usr/bin/env node
// LotTR AI smoke test runner.
//
// Reads a manifest of test photos + expected answers, runs each image
// through N OpenRouter models with a configurable prompt, scores the
// outputs against the expected answers, and writes a markdown comparison
// report. See README.md for the full setup story.
//
// Three things this is for:
//   1. A/B testing prompt revisions on a fixed image set (does v2 beat v1?)
//   2. Comparing models head-to-head (cost / latency / quality)
//   3. Catching regressions when a vendor silently updates a model
//
// Design notes:
//   - Pricing is fetched live from OpenRouter's /api/v1/models endpoint at
//     the start of each run, so per-call costs are always current. No
//     hardcoded prices to go stale.
//   - The harness is a single-file CLI (this file). Sufficient for v1;
//     can split into lib/* later if it grows.
//   - Image bytes are read straight from disk and inlined as data URIs
//     in OpenAI-compatible chat-completions format — same shape every
//     model on OpenRouter accepts.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname, basename, extname } from 'node:path';

// ── Constants ────────────────────────────────────────────────────────────

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname).replace(/^\//, ''), '..', '..');
const SMOKE_ROOT = resolve(REPO_ROOT, 'scripts', 'lottr-smoke');

// Default paths used when --prompt / --manifest / --models aren't given.
const DEFAULTS = {
  prompt:   join(SMOKE_ROOT, 'prompts', 'photo-identify.v1.txt'),
  manifest: join(SMOKE_ROOT, 'fixtures', 'manifest.json'),
  models:   join(SMOKE_ROOT, 'models.json'),
  outDir:   join(SMOKE_ROOT, 'results'),
};

// ── Args parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { ...DEFAULTS, budgetCents: 50, only: null, maxImages: null, out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--prompt':       args.prompt = resolve(v); i += 1; break;
      case '--manifest':     args.manifest = resolve(v); i += 1; break;
      case '--models':       args.models = resolve(v); i += 1; break;
      case '--budget-cents': args.budgetCents = Number(v); i += 1; break;
      case '--out':          args.out = resolve(v); i += 1; break;
      case '--only':         args.only = new RegExp(v); i += 1; break;
      case '--max-images':   args.maxImages = Number(v); i += 1; break;
      case '-h':
      case '--help':
        console.log(readFileSync(join(SMOKE_ROOT, 'README.md'), 'utf8'));
        process.exit(0);
        break;
      default:
        console.error(`Unknown flag: ${k}`);
        process.exit(2);
    }
  }
  return args;
}

// ── OpenRouter pricing ───────────────────────────────────────────────────

/** Fetch model metadata + pricing once per run. Returns { [model_id]: { prompt, completion, image } } in USD per token / per image. */
async function fetchPricing(apiKey) {
  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Pricing fetch failed: ${res.status} ${await res.text()}`);
  }
  const { data } = await res.json();
  const out = {};
  for (const m of data) {
    out[m.id] = {
      prompt:     parseFloat(m.pricing?.prompt     ?? '0'),  // USD per token
      completion: parseFloat(m.pricing?.completion ?? '0'),
      image:      parseFloat(m.pricing?.image      ?? '0'),  // USD per image
      contextLength: m.context_length,
    };
  }
  return out;
}

function costCents(usage, modelPricing, imageCount) {
  if (!usage || !modelPricing) return null;
  const promptTok = usage.prompt_tokens ?? 0;
  const completionTok = usage.completion_tokens ?? 0;
  const usd =
    promptTok * modelPricing.prompt +
    completionTok * modelPricing.completion +
    imageCount * modelPricing.image;
  return usd * 100; // cents
}

// ── One-shot model call ──────────────────────────────────────────────────

async function callModel({ apiKey, model, prompt, images, timeoutMs = 60_000 }) {
  // Inline images as base64 data URIs. Every multimodal model on OpenRouter
  // accepts this shape — same as direct OpenAI vision input. The first
  // content part is the prompt; subsequent parts are images.
  const content = [
    { type: 'text', text: prompt },
    ...images.map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
    })),
  ];

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const start = Date.now();
  let res;
  try {
    res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
        max_tokens: 4000,
        temperature: 0,
      }),
      signal: ctl.signal,
    });
  } catch (err) {
    return { ok: false, error: err.message ?? String(err), latencyMs: Date.now() - start };
  } finally {
    clearTimeout(t);
  }
  const latencyMs = Date.now() - start;
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}: ${await res.text()}`, latencyMs };
  }
  const body = await res.json();
  const text = body.choices?.[0]?.message?.content ?? '';
  let parsed = null;
  let parseError = null;
  try {
    // Some models still wrap JSON in code fences despite response_format.
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    parseError = err.message ?? String(err);
  }
  return {
    ok: true,
    latencyMs,
    rawText: text,
    parsed,
    parseError,
    usage: body.usage,
  };
}

// ── Quality scoring ──────────────────────────────────────────────────────

function norm(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

function scoreCase(parsed, expected) {
  // Each expected field becomes a check: hit (1), miss (0), or N/A (skipped).
  // Returns { hits, total, perField: { field: 'hit' | 'miss' | 'partial' } }.
  if (!parsed || !expected) return { hits: 0, total: 0, perField: {} };
  const perField = {};
  let hits = 0;
  let total = 0;

  const checkEq = (key) => {
    if (!(key in expected)) return;
    total += 1;
    const exp = norm(expected[key]);
    const got = norm(parsed[key]);
    const match = exp.length === 0 ? got.length === 0 : got === exp;
    perField[key] = match ? 'hit' : 'miss';
    if (match) hits += 1;
  };

  for (const k of ['brand', 'model', 'upc', 'asin', 'fnsku', 'category', 'condition']) {
    checkEq(k);
  }

  const checkContains = (field, key) => {
    if (!(key in expected)) return;
    total += 1;
    const terms = Array.isArray(expected[key]) ? expected[key] : [];
    const hay = norm(parsed[field] ?? '');
    const missing = terms.filter((t) => !hay.includes(norm(t)));
    if (missing.length === 0) {
      perField[`${field}~contains`] = 'hit';
      hits += 1;
    } else if (missing.length < terms.length) {
      perField[`${field}~contains`] = 'partial';
      hits += 0.5;
    } else {
      perField[`${field}~contains`] = 'miss';
    }
  };
  checkContains('title', 'title_contains');
  checkContains('category', 'category_contains');

  return { hits, total, perField };
}

// ── Markdown report ──────────────────────────────────────────────────────

function fmtCents(c) {
  if (c == null) return '—';
  return `$${(c / 100).toFixed(4)}`;
}
function fmtMs(ms) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
function pct(n, d) {
  if (!d) return '—';
  return `${Math.round((n / d) * 100)}%`;
}
function badge(state) {
  return { hit: '✓', miss: '✗', partial: '⚠' }[state] ?? state;
}

function writeReport({ args, manifest, models, pricing, results }) {
  const lines = [];
  const runAt = new Date();
  const promptName = basename(args.prompt);
  const manifestName = basename(args.manifest);

  lines.push(`# LotTR AI Smoke Test`);
  lines.push('');
  lines.push(`- **Run at**: ${runAt.toISOString()}`);
  lines.push(`- **Prompt**: \`${promptName}\``);
  lines.push(`- **Manifest**: \`${manifestName}\` — ${manifest.cases.length} case(s)`);
  lines.push(`- **Models**: ${models.length} (${models.join(', ')})`);
  lines.push('');

  // ── Per-model summary ─────────────────────────────────────────────────
  lines.push(`## Per-model summary`);
  lines.push('');
  lines.push('| Model | Images run | Avg latency | Total cost | Quality | Notes |');
  lines.push('|---|---|---|---|---|---|');
  for (const model of models) {
    const rows = results.filter((r) => r.model === model);
    const success = rows.filter((r) => r.ok && r.parsed);
    const avgLatency = success.length
      ? success.reduce((s, r) => s + (r.latencyMs ?? 0), 0) / success.length
      : null;
    const totalCost = rows.reduce((s, r) => s + (r.costCents ?? 0), 0);
    const totalHits = rows.reduce((s, r) => s + (r.score?.hits ?? 0), 0);
    const totalChecks = rows.reduce((s, r) => s + (r.score?.total ?? 0), 0);
    const failureCount = rows.length - success.length;
    const notes = failureCount > 0 ? `${failureCount} call(s) failed/parse-error` : '';
    lines.push(
      `| \`${model}\` | ${success.length}/${rows.length} | ${fmtMs(avgLatency)} | ${fmtCents(totalCost)} | ${pct(totalHits, totalChecks)} (${totalHits}/${totalChecks}) | ${notes} |`,
    );
  }
  lines.push('');

  // ── Per-image breakdown ───────────────────────────────────────────────
  lines.push(`## Per-image breakdown`);
  lines.push('');
  for (const c of manifest.cases) {
    const caseRows = results.filter((r) => r.caseId === c.id);
    if (caseRows.length === 0) continue;
    lines.push(`### ${c.id} — \`${c.image}\``);
    if (c.notes) lines.push(`> _${c.notes}_`);
    lines.push('');
    lines.push('**Expected:**');
    lines.push('```json');
    lines.push(JSON.stringify(c.expected, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('| Model | Result | Brand | Model# | Category | Latency | Cost |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const r of caseRows) {
      if (!r.ok) {
        lines.push(`| \`${r.model}\` | ❌ ${r.error?.slice(0, 60) ?? 'failed'} | | | | ${fmtMs(r.latencyMs)} | — |`);
        continue;
      }
      if (!r.parsed) {
        lines.push(`| \`${r.model}\` | ⚠ parse error | | | | ${fmtMs(r.latencyMs)} | ${fmtCents(r.costCents)} |`);
        continue;
      }
      const overall = r.score.total
        ? `${badge(r.score.hits === r.score.total ? 'hit' : r.score.hits > 0 ? 'partial' : 'miss')} ${r.score.hits}/${r.score.total}`
        : '—';
      const brand = r.parsed.brand ?? '';
      const model = r.parsed.model ?? '';
      const cat = r.parsed.category ?? '';
      lines.push(
        `| \`${r.model}\` | ${overall} | ${brand} | ${model} | ${cat} | ${fmtMs(r.latencyMs)} | ${fmtCents(r.costCents)} |`,
      );
    }
    lines.push('');
  }

  // ── Cost ledger ───────────────────────────────────────────────────────
  lines.push(`## Cost ledger`);
  lines.push('');
  lines.push('| Model | Total cost | Calls | Cost / call |');
  lines.push('|---|---|---|---|');
  let runTotal = 0;
  for (const model of models) {
    const rows = results.filter((r) => r.model === model);
    const total = rows.reduce((s, r) => s + (r.costCents ?? 0), 0);
    runTotal += total;
    lines.push(
      `| \`${model}\` | ${fmtCents(total)} | ${rows.length} | ${fmtCents(rows.length ? total / rows.length : null)} |`,
    );
  }
  lines.push(`| **Total** | **${fmtCents(runTotal)}** | ${results.length} | |`);
  lines.push('');

  return lines.join('\n');
}

// ── Image loading ────────────────────────────────────────────────────────

async function loadImage(absPath) {
  const buf = await readFile(absPath);
  const ext = extname(absPath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : ext === '.heic' ? 'image/heic'
    : 'image/jpeg';
  return { base64: buf.toString('base64'), mediaType, bytes: buf.length };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Missing OPENROUTER_API_KEY env var. Set it in your shell or .env.smoke.local.');
    process.exit(1);
  }

  // Load configs.
  if (!existsSync(args.manifest)) {
    console.error(`Manifest not found: ${args.manifest}`);
    console.error(`Copy ${join(SMOKE_ROOT, 'fixtures', 'manifest.example.json')} as a starting point.`);
    process.exit(1);
  }
  const manifest = JSON.parse(await readFile(args.manifest, 'utf8'));
  const modelsCfg = JSON.parse(await readFile(args.models, 'utf8'));
  const models = modelsCfg.models;
  const prompt = await readFile(args.prompt, 'utf8');

  // Filter cases by --only and --max-images.
  let cases = manifest.cases;
  if (args.only) cases = cases.filter((c) => args.only.test(c.id));
  if (args.maxImages) cases = cases.slice(0, args.maxImages);
  if (cases.length === 0) {
    console.error('No cases matched. Adjust --only or check your manifest.');
    process.exit(1);
  }

  // Fetch pricing.
  console.log(`Fetching OpenRouter pricing for ${models.length} models…`);
  const allPricing = await fetchPricing(apiKey);
  const pricing = {};
  for (const m of models) {
    if (!allPricing[m]) {
      console.warn(`  ⚠ no pricing data for ${m} — cost will show as 0`);
      pricing[m] = { prompt: 0, completion: 0, image: 0 };
    } else {
      pricing[m] = allPricing[m];
    }
  }

  // Estimate cost (rough — assume 1000 prompt tokens + 500 completion tokens per call + 1 image).
  const estCents = models.reduce((sum, m) => {
    const p = pricing[m];
    return sum + (cases.length * (1000 * p.prompt + 500 * p.completion + 1 * p.image) * 100);
  }, 0);
  console.log(`\nEstimated cost: ${fmtCents(estCents)} (${cases.length} cases × ${models.length} models)`);
  if (estCents > args.budgetCents) {
    console.error(`Estimate exceeds --budget-cents ${args.budgetCents}. Bump it or trim --models.`);
    process.exit(1);
  }

  // Run!
  console.log(`\nRunning ${cases.length} cases × ${models.length} models = ${cases.length * models.length} calls\n`);
  const results = [];
  const fixtureRoot = dirname(args.manifest);
  for (const c of cases) {
    const imgPath = resolve(fixtureRoot, c.image);
    if (!existsSync(imgPath)) {
      console.error(`  ⚠ image missing: ${imgPath} — skipping case ${c.id}`);
      continue;
    }
    const img = await loadImage(imgPath);
    process.stdout.write(`[${c.id}] (${(img.bytes / 1024).toFixed(0)}KB)\n`);
    for (const model of models) {
      process.stdout.write(`  ${model}… `);
      const r = await callModel({ apiKey, model, prompt, images: [img] });
      const score = r.parsed ? scoreCase(r.parsed, c.expected) : { hits: 0, total: 0, perField: {} };
      const cc = r.ok ? costCents(r.usage, pricing[model], 1) : null;
      results.push({
        caseId: c.id,
        model,
        ...r,
        score,
        costCents: cc,
      });
      const tag = r.ok
        ? (r.parsed
          ? `${badge(score.hits === score.total ? 'hit' : score.hits > 0 ? 'partial' : 'miss')} ${score.hits}/${score.total}`
          : 'parse-error')
        : 'ERROR';
      console.log(`${tag}  (${fmtMs(r.latencyMs)}, ${fmtCents(cc)})`);
    }
  }

  // Write report.
  await mkdir(DEFAULTS.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const promptSlug = basename(args.prompt, '.txt');
  const outBase = args.out
    ? args.out.replace(/\.md$/, '')
    : join(DEFAULTS.outDir, `${stamp}-${promptSlug}`);
  const md = writeReport({ args, manifest, models, pricing, results });
  await writeFile(`${outBase}.md`, md);
  await writeFile(
    `${outBase}.json`,
    JSON.stringify({ args, manifest: { name: manifest.name, cases: cases.map((c) => c.id) }, models, results }, null, 2),
  );

  console.log(`\n📊 Report:  ${outBase}.md`);
  console.log(`📊 Raw:     ${outBase}.json`);
  const total = results.reduce((s, r) => s + (r.costCents ?? 0), 0);
  console.log(`💸 Spent:   ${fmtCents(total)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
