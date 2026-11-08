#!/usr/bin/env node
// Prompt-A/B harness for vision identification.
//
// Single image × multiple prompts × multiple models. Same model, same
// image — prompt is the only variable. Pure prompt comparison.
//
// Usage:
//   node scripts/lottr-smoke/prompt-ab.mjs \
//     --image scripts/lottr-smoke/fixtures/playground-image.jpeg \
//     --prompt scripts/lottr-smoke/prompts/photo-identify.simple.txt:Simple \
//     --prompt scripts/lottr-smoke/prompts/photo-identify.v1.txt:Production \
//     --model qwen/qwen3-vl-235b-a22b-instruct:Qwen-3-VL \
//     --model google/gemini-2.5-flash:Gemini-2.5-Flash \
//     --plugin web_search
//
// Output: markdown report at scripts/lottr-smoke/results/prompt-ab-<ts>.md
// with all raw outputs side-by-side, plus cost/latency.
//
// Reads OPENROUTER_API_KEY from .env.smoke.local (project root) or env.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..');

// ── Args ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { images: [], prompts: [], models: [], plugins: [], out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i], v = argv[i + 1];
    switch (k) {
      case '--image': {
        // path[:label] — label optional, defaults to basename
        const idx = v.lastIndexOf(':');
        if (idx > 1 && idx < v.length - 1 && !v.slice(idx + 1).includes('/') && !v.slice(idx + 1).includes('\\')) {
          args.images.push({ path: resolve(v.slice(0, idx)), label: v.slice(idx + 1) });
        } else {
          args.images.push({ path: resolve(v), label: basename(v).replace(/\.[^.]+$/, '') });
        }
        i += 1; break;
      }
      case '--prompt': {
        // path[:label]
        const idx = v.lastIndexOf(':');
        if (idx > 1 && idx < v.length - 1 && !v.slice(idx + 1).includes('/') && !v.slice(idx + 1).includes('\\')) {
          args.prompts.push({ path: resolve(v.slice(0, idx)), label: v.slice(idx + 1) });
        } else {
          args.prompts.push({ path: resolve(v), label: basename(v).replace(/\.[^.]+$/, '') });
        }
        i += 1; break;
      }
      case '--model': {
        const idx = v.lastIndexOf(':');
        if (idx > 0 && !v.slice(idx + 1).includes('/')) {
          args.models.push({ id: v.slice(0, idx), label: v.slice(idx + 1) });
        } else {
          args.models.push({ id: v, label: v });
        }
        i += 1; break;
      }
      case '--plugin': args.plugins.push(v); i += 1; break;
      case '--out':    args.out = resolve(v); i += 1; break;
      default: throw new Error(`Unknown arg: ${k}`);
    }
  }
  if (args.images.length < 1)  throw new Error('--image required (at least one)');
  if (args.prompts.length < 1) throw new Error('--prompt required (at least one)');
  if (args.models.length < 1)  throw new Error('--model required (at least one)');
  return args;
}

// ── Env (load .env.smoke.local if present) ───────────────────────────────

async function loadEnvFile(path) {
  try {
    const txt = await readFile(path, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        process.env[m[1]] = v;
      }
    }
  } catch { /* file may not exist; ignore */ }
}

// ── OpenRouter call ──────────────────────────────────────────────────────

async function callOpenRouter({ apiKey, model, prompt, imageDataUri, plugins }) {
  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text',      text: prompt },
        { type: 'image_url', image_url: { url: imageDataUri, detail: 'auto' } },
      ],
    }],
    max_tokens: 6000,
    usage: { include: true },
  };
  if (plugins && plugins.length > 0) {
    body.plugins = plugins.map(id => ({ id }));
  }
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/auction-platform/lottr-smoke',
      'X-Title': 'LotTR prompt-AB',
    },
    body: JSON.stringify(body),
  });
  const latency = Date.now() - t0;
  if (!res.ok) {
    return { ok: false, status: res.status, text: await res.text().catch(() => ''), latency };
  }
  const j = await res.json();
  const choice = j.choices?.[0];
  const text = choice?.message?.content ?? '';
  return {
    ok: true,
    latency,
    text,
    usage: j.usage ?? null,
    finish_reason: choice?.finish_reason ?? null,
    model_used: j.model ?? model,
    reasoning_tokens: j.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

// ── Extraction — pull key fields from JSON-or-prose responses ────────────

function extractJsonFromText(text) {
  if (!text) return null;
  // Strip code fences
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  // Try direct parse
  try { return JSON.parse(stripped); } catch {}
  // Find first { ... last }
  const i = stripped.indexOf('{');
  const j = stripped.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(stripped.slice(i, j + 1)); } catch {}
  }
  return null;
}

function safeStr(v) { return typeof v === 'string' ? v : ''; }
function safeNum(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

// Regex extractors for prose outputs
function regexExtract(text) {
  const out = { brand: '', upc: '', asin: '', fnsku: '', model: '', msrpHint: '' };
  if (!text) return out;
  // FNSKU
  const f = text.match(/\bX\d[A-Z0-9]{8}\b/);
  if (f) out.fnsku = f[0];
  // ASIN
  const a = text.match(/\bB\d[A-Z0-9]{8}\b/);
  if (a) out.asin = a[0];
  // UPC (12-14 contiguous digits, but not preceded by alnum)
  const u = text.match(/(?<![A-Z0-9])\d{12,14}(?![0-9])/);
  if (u) out.upc = u[0];
  // Brand if explicitly labeled
  const b = text.match(/\*\*Brand:?\*\*\s*([A-Z][A-Za-z0-9 &-]+?)(?:\n|\*|\||$)/);
  if (b) out.brand = b[1].trim();
  // MSRP / price hint
  const m = text.match(/\$\s?\d+(?:\.\d{1,2})?(?:\s*[-–to]+\s*\$?\d+(?:\.\d{1,2})?)?/);
  if (m) out.msrpHint = m[0];
  return out;
}

function summarize(text) {
  const json = extractJsonFromText(text);
  if (json && typeof json === 'object') {
    const get = k => safeStr(json[k]);
    const msrpCents = safeNum(json['msrp_guess_cents']) ?? safeNum(json['msrp_cents']);
    const conf = safeNum(json['confidence_score']) ?? safeStr(json['confidence']);
    return {
      format: 'json',
      title:     get('title'),
      brand:     get('brand'),
      upc:       get('upc'),
      asin:      get('asin'),
      fnsku:     get('fnsku'),
      model:     get('model'),
      category:  get('category'),
      condition: get('condition'),
      description: get('description'),
      visibleText: Array.isArray(json['visibleText']) ? json['visibleText'].length : 0,
      msrp:      msrpCents != null ? `${msrpCents}¢` : '',
      confidence: conf,
      notes:     get('notes'),
    };
  }
  // Prose — regex-extract
  const r = regexExtract(text);
  return {
    format: 'prose',
    title: '',
    brand: r.brand,
    upc: r.upc,
    asin: r.asin,
    fnsku: r.fnsku,
    model: r.model,
    category: '',
    condition: '',
    description: '',
    visibleText: 0,
    msrp: r.msrpHint,
    confidence: '',
    notes: '',
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  await loadEnvFile(resolve(REPO_ROOT, '.env.smoke.local'));
  await loadEnvFile(resolve(REPO_ROOT, '.env.local'));
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY missing (looked in .env.smoke.local / .env.local / env)');
    process.exit(2);
  }

  // Load prompts
  const prompts = await Promise.all(args.prompts.map(async p => ({
    label: p.label,
    path: p.path,
    text: await readFile(p.path, 'utf8'),
  })));

  // Load each image → data URI
  const images = await Promise.all(args.images.map(async img => {
    const buf = await readFile(img.path);
    const ext = img.path.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
    return { ...img, bytes: buf.length, dataUri: `data:image/${ext};base64,${buf.toString('base64')}` };
  }));
  console.error(`images: ${images.map(i => `${i.label}(${i.bytes}B)`).join(', ')}`);
  console.error(`prompts: ${prompts.map(p => `${p.label}(${p.text.length}ch)`).join(', ')}`);
  console.error(`models:  ${args.models.map(m => m.label).join(', ')}`);
  console.error(`plugins: ${args.plugins.length ? args.plugins.join(',') : '(none)'}`);
  console.error('');

  // Run all combos
  const rows = [];
  let cellCount = 0;
  const totalCells = images.length * args.models.length * prompts.length;
  for (const image of images) {
    for (const model of args.models) {
      for (const prompt of prompts) {
        cellCount += 1;
        process.stderr.write(`  [${cellCount}/${totalCells}] ${image.label} × ${model.label} × ${prompt.label} …`);
        const r = await callOpenRouter({
          apiKey,
          model: model.id,
          prompt: prompt.text,
          imageDataUri: image.dataUri,
          plugins: args.plugins,
        });
        if (r.ok) {
          process.stderr.write(` ok ${r.latency}ms ${r.usage?.total_tokens ?? '?'}tok`);
          if (r.usage?.cost != null) process.stderr.write(` $${r.usage.cost.toFixed(4)}`);
          process.stderr.write('\n');
        } else {
          process.stderr.write(` FAIL ${r.status}\n${r.text}\n`);
        }
        rows.push({ image, model, prompt, result: r });
      }
    }
  }

  // Build markdown report
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = args.out ?? resolve(REPO_ROOT, 'scripts/lottr-smoke/results', `prompt-ab-${ts}.md`);
  await mkdir(dirname(outPath), { recursive: true });

  let md = `# Prompt A/B — ${new Date().toISOString()}\n\n`;
  md += `**Images (${images.length}):**\n`;
  for (const img of images) md += `- \`${img.label}\` — \`${img.path}\` (${img.bytes} bytes)\n`;
  md += `\n**Plugins:** ${args.plugins.length ? args.plugins.join(', ') : '*(none)*'}\n\n`;
  md += `## Prompts\n\n`;
  for (const p of prompts) {
    md += `### ${p.label} (\`${p.path}\`, ${p.text.length} chars, ${p.text.split('\n').length} lines)\n\n`;
    md += '```\n' + p.text + '\n```\n\n';
  }
  // Run extractors
  for (const r of rows) {
    r.summary = r.result.ok ? summarize(r.result.text) : null;
  }

  md += `## Summary — cost & shape\n\n`;
  md += `| Image | Model | Prompt | Latency | In/Out tok | Reasoning | Cost USD | Out chars | Format |\n`;
  md += `|---|---|---|---:|---|---:|---:|---:|---|\n`;
  for (const r of rows) {
    const u = r.result.usage ?? {};
    const cost = u.cost != null ? `$${u.cost.toFixed(4)}` : '*?*';
    const tokens = `${u.prompt_tokens ?? '?'} / ${u.completion_tokens ?? '?'}`;
    const reas = r.result.reasoning_tokens || '–';
    const charsOut = r.result.ok ? r.result.text.length : 0;
    const fmt = r.summary?.format ?? 'err';
    md += `| ${r.image.label} | ${r.model.label} | ${r.prompt.label} | ${r.result.latency}ms | ${tokens} | ${reas} | ${cost} | ${charsOut} | ${fmt} |\n`;
  }

  // Per-image extraction summaries (one table per image)
  for (const img of images) {
    md += `\n## Image: ${img.label} — extracted fields\n\n`;
    md += `| Model | Prompt | brand | fnsku | asin | upc | model | msrp | conf | title (truncated) |\n`;
    md += `|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const r of rows.filter(r => r.image.label === img.label)) {
      const s = r.summary;
      if (!s) {
        md += `| ${r.model.label} | ${r.prompt.label} | — | — | — | — | — | — | — | *(error)* |\n`;
        continue;
      }
      const title = s.title ? (s.title.length > 60 ? s.title.slice(0, 57) + '…' : s.title) : '';
      md += `| ${r.model.label} | ${r.prompt.label} | ${s.brand} | ${s.fnsku} | ${s.asin} | ${s.upc} | ${s.model} | ${s.msrp} | ${s.confidence} | ${title} |\n`;
    }
  }
  md += `\n## Raw outputs\n\n`;
  for (const r of rows) {
    md += `### ${r.image.label} × ${r.model.label} × ${r.prompt.label}\n\n`;
    if (!r.result.ok) {
      md += `**ERROR** ${r.result.status}: \`${r.result.text.slice(0, 300)}\`\n\n`;
    } else {
      md += `*finish_reason: \`${r.result.finish_reason}\`, model: \`${r.result.model_used}\`*\n\n`;
      md += '```\n' + r.result.text + '\n```\n\n';
    }
  }

  await writeFile(outPath, md);
  console.error(`\nwrote ${outPath}`);
  console.log(outPath);
}

main().catch(e => { console.error(e); process.exit(1); });
