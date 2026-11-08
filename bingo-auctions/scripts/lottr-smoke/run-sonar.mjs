#!/usr/bin/env node
// Mega-sim runner for the Sonar / web_search_lookup pipeline.
//
// Sibling of run.mjs (which covers photo_identify). This one tests the
// other half of the AI pipeline — the lookup that turns a UPC into
// {retailer URLs, MSRP, prices}. The Sonar prompt is the most expensive
// per-call piece of the stack, and the one that broke MSRP capture
// today, so this gets its own harness.
//
// What it does:
//   1. Reads a list of UPCs to test (from upcs.json or CLI args).
//   2. For each UPC × each model in models.json, runs the production
//      Sonar prompt and captures:
//        - URLs returned (count, retailer mix, Amazon-share)
//        - msrp_cents (the Tier-3 signal we added today)
//        - current_price_cents
//        - latency, prompt+completion tokens, USD cost
//   3. Writes a markdown report comparing models head-to-head.
//
// Why this matters: when you tweak the Sonar prompt (or want to evaluate
// sonar-pro vs sonar vs gpt-4o-search-preview), this harness gives you
// a side-by-side answer in 60s instead of "scan some lots and see".
//
// Default UPCs are the 11 we invalidated earlier today (real
// liquidation products with known retailer footprints) plus a few
// known-good cases like Apple AirPods that should be a 100% hit.
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-... node scripts/lottr-smoke/run-sonar.mjs
//
// Flags:
//   --upcs <path>        JSON file with { "upcs": ["...", "..."] }
//   --models <path>      Models config (defaults to sonar-models.json)
//   --budget-cents <n>   Refuse if estimated cost exceeds this (default 100)
//   --max-upcs <n>       Test only the first N UPCs
//   --out <path>         Output report path (default results/<timestamp>-sonar.md)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const SMOKE_ROOT = resolve(dirname(new URL(import.meta.url).pathname).replace(/^\//, ''));
const OUT_DIR = join(SMOKE_ROOT, 'results');

// ── Default UPC set ──────────────────────────────────────────────────────
// The 11 we invalidated earlier today (cache rows with prices but no
// MSRP — exactly the regression class Tier 3 MSRP is supposed to fix),
// plus the AirPods known-good baseline.
const DEFAULT_UPCS = [
  { upc: '017502232037', title: 'Pronto Acetone Nail Polish Remover' },
  { upc: '017502232035', title: 'Eternal Cosmetics Acetone' },
  { upc: '045496590161', title: 'Nintendo Switch Pro Controller' },
  { upc: '024600010030', title: 'Morton Iodized Table Salt 26 oz' },
  { upc: '681131699372', title: 'Equate Ibuprofen 200mg 100ct' },
  { upc: '028400091565', title: "Lay's Classic Potato Chips" },
  { upc: '017082012937', title: "Jack Link's Beef + Cheese" },
  { upc: '048500206560', title: 'Tropicana Strawberry Lemonade' },
  { upc: '052000324815', title: 'Gatorade Cool Blue 20oz' },
  { upc: '609249907028', title: 'ZYN Citrus 6mg' },
  { upc: '049000042566', title: 'Coca-Cola Marvel Captain America Zero Sugar' },
  // Baseline — already known to work end-to-end (BestBuy returns explicit
  // MSRP via JSON-LD). If a model can't find this, the prompt is broken.
  { upc: '195949689804', title: 'Apple AirPods 4 with ANC' },
];

// ── Args ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    upcs: null,
    models: join(SMOKE_ROOT, 'sonar-models.json'),
    budgetCents: 100,
    maxUpcs: null,
    out: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--upcs':         args.upcs = resolve(v); i += 1; break;
      case '--models':       args.models = resolve(v); i += 1; break;
      case '--budget-cents': args.budgetCents = Number(v); i += 1; break;
      case '--max-upcs':     args.maxUpcs = Number(v); i += 1; break;
      case '--out':          args.out = resolve(v); i += 1; break;
      default:
        if (k.startsWith('--')) {
          console.error(`Unknown flag: ${k}`);
          process.exit(2);
        }
    }
  }
  return args;
}

// ── Sonar prompt (mirror of production buildSystemPrompt / buildUserPrompt) ──

const SYSTEM_PROMPT = `You are a product-page finder. Given a product query, search the web
and return canonical retailer PRODUCT PAGE URLs (not search results, not
category pages, not blog reviews). US-market retailers only. Output JSON
only — no prose, no markdown fences.`;

function userPrompt(upc, hintTitle) {
  return `Find retailer product page URLs AND the manufacturer's
suggested retail price (MSRP) for this product:
UPC: ${upc}${hintTitle ? `, Title hint: ${hintTitle}` : ''}

Acceptable retailers (only these — US-market only):
  Walmart, Home Depot, Lowe's, Target, Best Buy, Costco, Newegg, B&H Photo,
  eBay, Sam's Club, Wayfair, Tractor Supply, AutoZone, Staples, Office Depot,
  Macy's, Kohl's, REI, Dick's Sporting Goods, Ace Hardware, Menards, BJ's,
  Chewy, Petco, PetSmart, Ulta, Sephora, CVS, Walgreens, Rite Aid.

EXCLUDED (do not return URLs from — empirically blocked at fetch time):
  amazon.com, amzn.to, smile.amazon.com. If your top search results
  are dominated by Amazon, KEEP SEARCHING for non-Amazon retailer pages
  that carry the same product. Even if you can ONLY find Amazon URLs,
  still return MSRP if Amazon's "List:" / "Was:" price is visible to you —
  msrp is independent of the urls field.

Return JSON with this exact shape:
{
  "urls": [
    "https://www.walmart.com/ip/1234567",
    "https://www.homedepot.com/p/My-Product/200000000"
  ],
  "msrp_cents": 1999,
  "current_price_cents": 1499,
  "confidence": "high"
}

Field rules:
- urls: 0-5 retailer product page URLs. Each MUST be a specific product
  page (deep link), not a search result or category page. Each MUST come
  from your actual web search — DO NOT fabricate URLs. Each MUST NOT be
  on amazon.com / amzn.to / smile.amazon.com. Skip URLs shorter than 30
  characters.
- msrp_cents: integer USD cents. The manufacturer's suggested retail
  price ("MSRP", "List Price", "Was \$X"). PREFER this signal over the
  current sale price. Many products discount below MSRP at most
  retailers; the highest price you observe across your search results
  is usually the closest to MSRP. If no MSRP is visible anywhere,
  return null.
- current_price_cents: integer USD cents. The lowest current sale price
  you observed at any retailer. Optional — return null if none observed.
- confidence: "high" if 3+ non-Amazon URLs found AND msrp_cents known;
  "medium" if 1-2 URLs OR msrp_cents known without URLs; "none" if
  neither URLs nor msrp_cents found.

CRITICAL: msrp_cents and current_price_cents are about the prices
themselves — they are valid signals even when urls is empty (e.g.
Amazon-only search results, or paywalled retailer pages). Returning
msrp_cents with an empty urls[] is preferred over returning nothing.

Output ONLY the JSON object. No prose, no markdown fences.`;
}

// ── Pricing fetch ────────────────────────────────────────────────────────

async function fetchPricing(apiKey, modelIds) {
  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`pricing fetch failed: ${res.status}`);
  const { data } = await res.json();
  const out = {};
  for (const m of modelIds) {
    const meta = data.find((d) => d.id === m);
    out[m] = meta?.pricing
      ? {
          prompt: parseFloat(meta.pricing.prompt ?? '0'),
          completion: parseFloat(meta.pricing.completion ?? '0'),
        }
      : { prompt: 0, completion: 0 };
  }
  return out;
}

function costCents(usage, pricing) {
  if (!usage) return null;
  const usd =
    (usage.prompt_tokens ?? 0) * pricing.prompt +
    (usage.completion_tokens ?? 0) * pricing.completion;
  return usd * 100;
}

// ── Sonar call ───────────────────────────────────────────────────────────

async function callSonar({ apiKey, model, upc, title }) {
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
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt(upc, title) },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 6000,
        temperature: 0,
      }),
    });
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - start };
  }
  const latencyMs = Date.now() - start;
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, latencyMs };
  }
  const body = await res.json();
  const text = body.choices?.[0]?.message?.content ?? '';
  let parsed = null;
  try {
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
  } catch {
    // leave parsed = null
  }
  return { ok: true, latencyMs, rawText: text, parsed, usage: body.usage };
}

// ── Report writer ────────────────────────────────────────────────────────

function fmtCents(c) { return c == null ? '—' : `$${(c / 100).toFixed(4)}`; }
function fmtMs(ms) { return ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`; }
function fmtPrice(c) { return c == null ? '—' : `$${(c / 100).toFixed(2)}`; }

function isAmazonUrl(u) { return /amazon\.com|amzn\.to/i.test(u ?? ''); }
function retailerFromUrl(u) {
  try { return new URL(u).hostname.replace(/^www\./, '').split('.')[0]; } catch { return '?'; }
}

function writeReport({ upcs, models, results, pricing }) {
  const lines = [];
  const runAt = new Date();
  lines.push('# Sonar / web_search_lookup mega-sim');
  lines.push('');
  lines.push(`- Run at: ${runAt.toISOString()}`);
  lines.push(`- Models: ${models.join(', ')}`);
  lines.push(`- UPCs: ${upcs.length}`);
  lines.push('');

  // Per-model summary
  lines.push('## Per-model summary');
  lines.push('');
  lines.push('| Model | UPCs run | URLs avg | Got MSRP | Avg latency | Total cost |');
  lines.push('|---|---|---|---|---|---|');
  for (const m of models) {
    const rows = results.filter((r) => r.model === m);
    const ok = rows.filter((r) => r.ok && r.parsed);
    const urlsAvg = ok.length
      ? (ok.reduce((s, r) => s + (Array.isArray(r.parsed?.urls) ? r.parsed.urls.length : 0), 0) / ok.length).toFixed(1)
      : '—';
    const gotMsrp = ok.filter((r) => Number(r.parsed?.msrp_cents) > 0).length;
    const avgLat = ok.length
      ? Math.round(ok.reduce((s, r) => s + r.latencyMs, 0) / ok.length)
      : null;
    const totalCost = rows.reduce((s, r) => s + (r.costCents ?? 0), 0);
    lines.push(
      `| \`${m}\` | ${ok.length}/${rows.length} | ${urlsAvg} | ${gotMsrp}/${ok.length} | ${fmtMs(avgLat)} | ${fmtCents(totalCost)} |`,
    );
  }
  lines.push('');

  // Per-UPC breakdown
  lines.push('## Per-UPC breakdown');
  lines.push('');
  for (const u of upcs) {
    const rows = results.filter((r) => r.upc === u.upc);
    if (rows.length === 0) continue;
    lines.push(`### ${u.upc} — ${u.title ?? ''}`);
    lines.push('');
    lines.push('| Model | URLs | Non-Amazon | MSRP | Current | Latency | Cost |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const r of rows) {
      if (!r.ok) {
        lines.push(`| \`${r.model}\` | ERROR: ${r.error?.slice(0, 50)} | | | | ${fmtMs(r.latencyMs)} | — |`);
        continue;
      }
      if (!r.parsed) {
        lines.push(`| \`${r.model}\` | parse-error | | | | ${fmtMs(r.latencyMs)} | ${fmtCents(r.costCents)} |`);
        continue;
      }
      const urls = Array.isArray(r.parsed.urls) ? r.parsed.urls : [];
      const nonAmazon = urls.filter((x) => !isAmazonUrl(x));
      const retailers = nonAmazon.map(retailerFromUrl).slice(0, 3).join(', ');
      lines.push(
        `| \`${r.model}\` | ${urls.length} | ${nonAmazon.length} (${retailers || '—'}) | ${fmtPrice(r.parsed.msrp_cents)} | ${fmtPrice(r.parsed.current_price_cents)} | ${fmtMs(r.latencyMs)} | ${fmtCents(r.costCents)} |`,
      );
    }
    lines.push('');
  }

  // Cost ledger
  lines.push('## Cost ledger');
  lines.push('');
  lines.push('| Model | Total | Calls | Cost / call |');
  lines.push('|---|---|---|---|');
  let total = 0;
  for (const m of models) {
    const rows = results.filter((r) => r.model === m);
    const cost = rows.reduce((s, r) => s + (r.costCents ?? 0), 0);
    total += cost;
    lines.push(`| \`${m}\` | ${fmtCents(cost)} | ${rows.length} | ${fmtCents(rows.length ? cost / rows.length : null)} |`);
  }
  lines.push(`| **Total** | **${fmtCents(total)}** | ${results.length} | |`);
  lines.push('');

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Missing OPENROUTER_API_KEY env var.');
    process.exit(1);
  }

  // Load UPCs.
  let upcs = DEFAULT_UPCS;
  if (args.upcs) {
    const json = JSON.parse(await readFile(args.upcs, 'utf8'));
    upcs = Array.isArray(json.upcs)
      ? json.upcs.map((u) => (typeof u === 'string' ? { upc: u, title: null } : u))
      : json;
  }
  if (args.maxUpcs) upcs = upcs.slice(0, args.maxUpcs);

  // Load models.
  const modelsCfg = existsSync(args.models)
    ? JSON.parse(await readFile(args.models, 'utf8'))
    : {
        models: [
          'perplexity/sonar',
          'perplexity/sonar-pro',
          'openai/gpt-4o-search-preview',
        ],
      };
  const models = modelsCfg.models;

  console.log(`Fetching pricing for ${models.length} models…`);
  const pricing = await fetchPricing(apiKey, models);

  // Rough cost estimate. Sonar averages 200 prompt tokens + 200 completion.
  const estCents = models.reduce((s, m) => {
    const p = pricing[m];
    return s + (upcs.length * (200 * p.prompt + 200 * p.completion) * 100);
  }, 0);
  console.log(`Estimated cost: ${fmtCents(estCents)} (${upcs.length} UPCs × ${models.length} models)`);
  if (estCents > args.budgetCents) {
    console.error(`Estimate ${fmtCents(estCents)} exceeds budget ${fmtCents(args.budgetCents)}.`);
    console.error('Bump --budget-cents or trim --models / --max-upcs.');
    process.exit(1);
  }

  // Run.
  console.log(`\nRunning ${upcs.length} × ${models.length} = ${upcs.length * models.length} Sonar calls\n`);
  const results = [];
  for (const u of upcs) {
    process.stdout.write(`[${u.upc}] ${u.title ?? ''}\n`);
    for (const model of models) {
      process.stdout.write(`  ${model}… `);
      const r = await callSonar({ apiKey, model, upc: u.upc, title: u.title });
      const cc = r.ok ? costCents(r.usage, pricing[model]) : null;
      results.push({ upc: u.upc, model, ...r, costCents: cc });
      if (!r.ok) {
        console.log(`ERROR (${r.error?.slice(0, 40)}, ${fmtMs(r.latencyMs)})`);
      } else if (!r.parsed) {
        console.log(`parse-error (${fmtMs(r.latencyMs)}, ${fmtCents(cc)})`);
      } else {
        const urls = Array.isArray(r.parsed.urls) ? r.parsed.urls.length : 0;
        const nonAmazon = Array.isArray(r.parsed.urls)
          ? r.parsed.urls.filter((x) => !isAmazonUrl(x)).length
          : 0;
        const msrp = r.parsed.msrp_cents ? `$${(r.parsed.msrp_cents / 100).toFixed(2)}` : 'no-msrp';
        console.log(`${nonAmazon}/${urls} non-Amazon URLs, ${msrp}  (${fmtMs(r.latencyMs)}, ${fmtCents(cc)})`);
      }
    }
  }

  // Write report.
  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outBase = args.out
    ? args.out.replace(/\.md$/, '')
    : join(OUT_DIR, `${stamp}-sonar`);
  const md = writeReport({ upcs, models, results, pricing });
  await writeFile(`${outBase}.md`, md);
  await writeFile(`${outBase}.json`, JSON.stringify({ upcs, models, results }, null, 2));

  console.log(`\n📊 Report: ${outBase}.md`);
  const total = results.reduce((s, r) => s + (r.costCents ?? 0), 0);
  console.log(`💸 Spent:  ${fmtCents(total)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
