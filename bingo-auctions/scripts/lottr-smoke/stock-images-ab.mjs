#!/usr/bin/env node
// Stock-image A/B harness.
//
// Goal: figure out which (model × prompt) combination actually returns
// working retailer-CDN stock-image URLs for our products. We score on:
//   - URLs returned by the model
//   - URLs that pass the project's ALLOWED_IMAGE_HOSTS allowlist
//   - URLs that actually resolve (HEAD request returns 2xx + image/* type)
//
// Inputs:
//   --product label:brand:model:upc[:asin][:fnsku] (can repeat)
//   --prompt path:Label  (can repeat)
//   --model id:Label     (can repeat)
//
// The harness sends ONE text-only message per cell (no image) — it
// simulates the second-stage stock-image search after identification.
// This isolates the stock-image-finding problem from the photo_identify
// problem we've already characterized.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// Mirror of packages/domain-lotting/src/normalize/images.ts allowlist.
const ALLOWED_HOSTS = new Set([
  'i.ebayimg.com', 'thumbs.ebaystatic.com', 'pics.ebaystatic.com',
  'i.pinimg.com',
  'm.media-amazon.com', 'images-na.ssl-images-amazon.com',
  'images-eu.ssl-images-amazon.com', 'images-fe.ssl-images-amazon.com',
  'ecx.images-amazon.com',
  'images.thdstatic.com',
  'mobileimages.lowes.com', 'images.lowes.com',
  'i5.walmartimages.com', 'i1.walmartimages.com', 'i2.walmartimages.com',
  'i3.walmartimages.com', 'i4.walmartimages.com',
  'target.scene7.com',
  'pisces.bbystatic.com',
  'mobilecontent.costco.com',
  'static.bhphotovideo.com',
  'c1.neweggimages.com',
  'media.mac.bid', 'cdn.bidfta.com', 'images.nellisauction.com',
  'firebasestorage.googleapis.com',
  'xgsujdzicnjenhqihovk.supabase.co',
  'images.openfoodfacts.org',
]);

function isSafeHost(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname.toLowerCase()); }
  catch { return false; }
}

function parseArgs(argv) {
  const a = { products: [], prompts: [], models: [], plugins: [], out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i], v = argv[i + 1];
    switch (k) {
      case '--product': {
        // label:brand|model|title|upc[|asin][|fnsku]
        const [label, ...rest] = v.split('::');
        const fields = rest.join('::').split('|');
        a.products.push({
          label, brand: fields[0] || '', model: fields[1] || '',
          title: fields[2] || '', upc: fields[3] || '',
          asin: fields[4] || '', fnsku: fields[5] || '',
        });
        i += 1; break;
      }
      case '--prompt': {
        const idx = v.lastIndexOf(':');
        if (idx > 1 && !v.slice(idx + 1).includes('/') && !v.slice(idx + 1).includes('\\')) {
          a.prompts.push({ path: resolve(v.slice(0, idx)), label: v.slice(idx + 1) });
        } else {
          a.prompts.push({ path: resolve(v), label: basename(v).replace(/\.[^.]+$/, '') });
        }
        i += 1; break;
      }
      case '--model': {
        const idx = v.lastIndexOf(':');
        if (idx > 0 && !v.slice(idx + 1).includes('/')) a.models.push({ id: v.slice(0, idx), label: v.slice(idx + 1) });
        else a.models.push({ id: v, label: v });
        i += 1; break;
      }
      case '--plugin': a.plugins.push(v); i += 1; break;
      case '--out':    a.out = resolve(v); i += 1; break;
      default: throw new Error('Unknown arg: ' + k);
    }
  }
  if (a.products.length < 1) throw new Error('--product required');
  if (a.prompts.length < 1)  throw new Error('--prompt required');
  if (a.models.length < 1)   throw new Error('--model required');
  return a;
}

async function loadEnv(p) {
  try {
    const t = await readFile(p, 'utf8');
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  } catch {}
}

function buildQueryDescription(p) {
  const parts = [];
  if (p.brand) parts.push(`Brand: ${p.brand}`);
  if (p.model) parts.push(`Model: ${p.model}`);
  if (p.title) parts.push(`Title: ${p.title}`);
  if (p.upc)   parts.push(`UPC: ${p.upc}`);
  if (p.asin)  parts.push(`ASIN: ${p.asin}`);
  if (p.fnsku) parts.push(`FNSKU: ${p.fnsku}`);
  return parts.join('\n');
}

async function callOpenRouter({ apiKey, model, prompt, plugins }) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4000,
    usage: { include: true },
  };
  if (plugins.length > 0) body.plugins = plugins.map(id => ({ id }));
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const latency = Date.now() - t0;
  if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(() => ''), latency };
  const j = await res.json();
  return {
    ok: true,
    latency,
    text: j.choices?.[0]?.message?.content ?? '',
    usage: j.usage ?? null,
    finish_reason: j.choices?.[0]?.finish_reason ?? null,
    model_used: j.model ?? model,
  };
}

function extractUrls(text) {
  if (!text) return [];
  // Try JSON parse — accept image_urls OR product_urls
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let urls = [];
  try {
    const j = JSON.parse(stripped);
    if (Array.isArray(j.image_urls)) urls = j.image_urls.filter(u => typeof u === 'string');
    else if (Array.isArray(j.product_urls)) urls = j.product_urls.filter(u => typeof u === 'string');
    else if (Array.isArray(j)) urls = j.filter(u => typeof u === 'string');
  } catch {
    // Fallback: regex-find https urls
    const matches = text.match(/https:\/\/[^\s"')]+/g) ?? [];
    urls = matches;
  }
  return urls;
}

// HEAD-check each URL: status, content-type, byte size if available
async function validateUrl(url) {
  try {
    const t0 = Date.now();
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const ct = res.headers.get('content-type') ?? '';
    const len = Number(res.headers.get('content-length') ?? 0);
    return {
      url,
      status: res.status,
      ok: res.ok,
      is_image: ct.startsWith('image/'),
      content_type: ct,
      bytes: len,
      latency_ms: Date.now() - t0,
    };
  } catch (e) {
    return { url, status: 0, ok: false, is_image: false, error: String(e?.message ?? e), latency_ms: 8000 };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  await loadEnv(resolve(REPO_ROOT, '.env.smoke.local'));
  await loadEnv(resolve(REPO_ROOT, '.env.local'));
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) { console.error('OPENROUTER_API_KEY missing'); process.exit(2); }

  const prompts = await Promise.all(args.prompts.map(async p => ({
    label: p.label, path: p.path, text: await readFile(p.path, 'utf8'),
  })));

  const totalCells = args.products.length * args.models.length * prompts.length;
  console.error(`products=${args.products.length} prompts=${prompts.length} models=${args.models.length} → ${totalCells} cells`);
  console.error(`plugins: ${args.plugins.join(',') || '(none)'}\n`);

  const rows = [];
  let cell = 0;
  for (const product of args.products) {
    for (const model of args.models) {
      for (const prompt of prompts) {
        cell += 1;
        process.stderr.write(`  [${cell}/${totalCells}] ${product.label} × ${model.label} × ${prompt.label} …`);
        const fullPrompt = `${prompt.text}\n\nProduct:\n${buildQueryDescription(product)}`;
        const r = await callOpenRouter({ apiKey, model: model.id, prompt: fullPrompt, plugins: args.plugins });
        if (!r.ok) {
          process.stderr.write(` FAIL ${r.status}\n`);
          rows.push({ product, model, prompt, result: r, urls: [], validated: [] });
          continue;
        }
        const urls = extractUrls(r.text);
        const allowedCount = urls.filter(isSafeHost).length;
        process.stderr.write(` ok ${r.latency}ms ${urls.length}urls (${allowedCount} on allowlist) $${r.usage?.cost?.toFixed(4) ?? '?'} `);
        // Validate every URL (allowlist + non-allowlist) so we know if filter
        // is the bottleneck vs the search not finding anything
        const validated = await Promise.all(urls.map(validateUrl));
        const okCount = validated.filter(v => v.ok && v.is_image).length;
        process.stderr.write(`→ ${okCount} resolve as images\n`);
        rows.push({ product, model, prompt, result: r, urls, validated });
      }
    }
  }

  // Markdown report
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = args.out ?? resolve(REPO_ROOT, 'scripts/lottr-smoke/results', `stock-images-${ts}.md`);
  await mkdir(dirname(outPath), { recursive: true });

  let md = `# Stock-image A/B — ${new Date().toISOString()}\n\n`;
  md += `**Plugins:** ${args.plugins.length ? args.plugins.join(', ') : '*(none)*'}\n\n`;
  md += `## Products tested\n\n`;
  for (const p of args.products) {
    md += `- **${p.label}** — ${[p.brand, p.model, p.title, p.upc && `UPC ${p.upc}`, p.asin && `ASIN ${p.asin}`, p.fnsku && `FNSKU ${p.fnsku}`].filter(Boolean).join(' | ')}\n`;
  }
  md += `\n## Summary\n\n`;
  md += `| Product | Model | Prompt | URLs returned | On allowlist | Resolve as image | Cost | Latency |\n`;
  md += `|---|---|---|---:|---:|---:|---:|---:|\n`;
  for (const r of rows) {
    const allowed = r.urls.filter(isSafeHost).length;
    const okImages = r.validated.filter(v => v.ok && v.is_image).length;
    const cost = r.result.usage?.cost != null ? `$${r.result.usage.cost.toFixed(4)}` : '*?*';
    md += `| ${r.product.label} | ${r.model.label} | ${r.prompt.label} | ${r.urls.length} | ${allowed} | ${okImages} | ${cost} | ${r.result.latency}ms |\n`;
  }
  md += `\n## Per-cell breakdown\n\n`;
  for (const r of rows) {
    md += `### ${r.product.label} × ${r.model.label} × ${r.prompt.label}\n\n`;
    if (!r.result.ok) { md += `**ERROR** ${r.result.status}: \`${r.result.text.slice(0,300)}\`\n\n`; continue; }
    md += `*${r.result.latency}ms, cost ${r.result.usage?.cost != null ? '$'+r.result.usage.cost.toFixed(4) : '?'}, finish ${r.result.finish_reason}*\n\n`;
    if (r.urls.length === 0) {
      md += `*No URLs returned.*\n\nResponse text:\n\n\`\`\`\n${r.result.text.slice(0,800)}\n\`\`\`\n\n`;
    } else {
      md += `| URL | Allowlist | HTTP | Type | Size | Latency |\n|---|---|---:|---|---:|---:|\n`;
      for (const v of r.validated) {
        const allowed = isSafeHost(v.url) ? '✅' : '❌';
        const ok = v.ok && v.is_image ? '✅ ' : v.ok ? '⚠️ ' : '❌ ';
        const ct = v.content_type ?? v.error ?? '-';
        const bytes = v.bytes ? `${v.bytes}B` : '';
        md += `| \`${v.url.length > 90 ? v.url.slice(0,87)+'…' : v.url}\` | ${allowed} | ${ok}${v.status} | ${ct} | ${bytes} | ${v.latency_ms}ms |\n`;
      }
      md += '\n';
    }
  }
  await writeFile(outPath, md);
  console.error(`\nwrote ${outPath}`);
  console.log(outPath);
}

main().catch(e => { console.error(e); process.exit(1); });
