#!/usr/bin/env node
// Phase 5: validate the "URL-Finder → fetch HTML → extract og:image / JSON-LD"
// pipeline. Takes a set of product page URLs (output of URL-Finder prompt
// or hardcoded) and reports what stock images we can extract.
//
// Mirrors the parsing logic of packages/domain-lotting/src/lookup/url-fetcher.ts
// but lives in scripts/lottr-smoke/ so we can iterate without rebuilding
// the domain package.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const OUT_DIR   = resolve(REPO_ROOT, 'scripts/lottr-smoke/results');

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Test products with URL-Finder-discovered pages from Phase 4 (verified 200 OK)
// plus a few hand-curated steelman pages.
const PRODUCTS = [
  {
    label: 'BlackPepper',
    brand: "Bolner's Fiesta", title: 'Bolner Fiesta #30 Coarse Black Pepper',
    pages: [
      'https://www.walmart.com/ip/Fiesta-Brand-Ground-Black-Pepper-Spice-16-oz/15716687',
      'https://www.heb.com/product-detail/bolner-s-fiesta-coarse-ground-black-pepper/169971',
      'https://www.ebay.com/p/27010353679',
    ],
  },
  {
    label: 'Candle',
    brand: 'White Barn', title: 'White Barn Watermelon Lemonade 3-Wick Candle',
    pages: [
      'https://www.walmart.com/ip/White-Barn-Candle-Co-Watermelon-Lemonade-3-Wick-Candle/210930000',
      'https://www.bathandbodyworks.com/p/watermelon-lemonade-3-wick-candle-027229100.html',
    ],
  },
  {
    label: 'Konsait-Tattoos',
    brand: 'Konsait', title: 'Konsait Glitter Temporary Tattoos 24 Sheets',
    pages: [
      'https://www.amazon.com/dp/B097CYP897',
      'https://www.noon.com/saudi-en/konsait-glitter-temporary-tattoo-for-girls-24-sheets-butterfly-mermaid-fairy-flowers-tattoo-stickers-for-kids-waterproof-fake-tattoos-for-birthday-party-favors-goodie-bags-stuffers-party-fillers/Z0B9CBF36EE9CF6BD0590Z/p/',
    ],
  },
  {
    label: '3DPrinter-DB',
    brand: 'DB', title: 'DB 3D Printer Tool Kit',
    pages: [
      'https://www.amazon.com/s?k=X004IXICJH',
      // Just see what FNSKU search yields
    ],
  },
];

function firstMatch(html, patterns) {
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return decodeURIComponent(m[1].replace(/&amp;/g, '&'));
  }
  return null;
}

const OG_PATTERNS = {
  image: [
    /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i,
    /<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i,
    /<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i,
  ],
  title: [
    /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
    /<title>([^<]+)<\/title>/i,
  ],
};

function extractJsonLdImages(html) {
  const images = [];
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    try {
      const node = JSON.parse(m[1].trim());
      const walk = (n) => {
        if (!n) return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (typeof n !== 'object') return;
        if (n['@type'] === 'Product' || (Array.isArray(n['@type']) && n['@type'].includes('Product'))) {
          const img = n.image;
          if (typeof img === 'string') images.push(img);
          else if (Array.isArray(img)) for (const v of img) {
            if (typeof v === 'string') images.push(v);
            else if (v && typeof v === 'object' && typeof v.url === 'string') images.push(v.url);
          }
          else if (img && typeof img === 'object' && typeof img.url === 'string') images.push(img.url);
        }
        for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
      };
      walk(node);
    } catch {}
  }
  return images;
}

async function fetchPage(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    const latency = Date.now() - t0;
    if (!res.ok) return { url, status: res.status, latency, ok: false };
    const html = await res.text();
    return { url, status: res.status, latency, ok: true, htmlBytes: html.length, html };
  } catch (e) {
    return { url, status: 0, latency: Date.now() - t0, ok: false, error: String(e?.message ?? e) };
  }
}

async function validateImage(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const ct = res.headers.get('content-type') ?? '';
    const len = Number(res.headers.get('content-length') ?? 0);
    return { url, status: res.status, ok: res.ok, is_image: ct.startsWith('image/'), content_type: ct, bytes: len };
  } catch (e) {
    return { url, status: 0, ok: false, is_image: false, error: String(e?.message ?? e) };
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const all = [];

  for (const prod of PRODUCTS) {
    console.error(`\n=== ${prod.label} ===`);
    for (const pageUrl of prod.pages) {
      process.stderr.write(`  fetch ${pageUrl.slice(0, 80)} …`);
      const page = await fetchPage(pageUrl);
      if (!page.ok) {
        process.stderr.write(` FAIL ${page.status} ${page.error ?? ''}\n`);
        all.push({ product: prod, page, ogImage: null, jsonLdImages: [], validated: [] });
        continue;
      }
      process.stderr.write(` ok ${page.status} ${page.htmlBytes}B\n`);

      const ogImage = firstMatch(page.html, OG_PATTERNS.image);
      const ogTitle = firstMatch(page.html, OG_PATTERNS.title);
      const jsonLdImages = extractJsonLdImages(page.html);

      const allImageUrls = Array.from(new Set([
        ...(ogImage ? [ogImage] : []),
        ...jsonLdImages,
      ]));
      console.error(`     og:image=${ogImage ? 'yes' : 'no'} jsonLd=${jsonLdImages.length} totalUnique=${allImageUrls.length}`);

      const validated = await Promise.all(allImageUrls.slice(0, 6).map(validateImage));
      const ok = validated.filter(v => v.ok && v.is_image).length;
      console.error(`     ${ok}/${allImageUrls.length} validated as working images`);

      all.push({
        product: prod,
        page: { ...page, html: undefined },
        ogTitle,
        ogImage,
        jsonLdImages,
        validated,
      });
    }
  }

  // Write report
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolve(OUT_DIR, `fetch-pages-${ts}.md`);
  let md = `# Fetch-page image extraction — ${new Date().toISOString()}\n\n`;
  md += `Tests the architecture: "ask LLM for product PAGE URLs (not image URLs), fetch pages ourselves, parse JSON-LD + og:image".\n\n`;
  md += `| Product | Page URL | HTTP | og:image | JSON-LD imgs | Validated as image |\n`;
  md += `|---|---|---:|---|---:|---:|\n`;
  for (const r of all) {
    const url = r.page.url.length > 70 ? r.page.url.slice(0, 67) + '…' : r.page.url;
    const status = r.page.ok ? `✅ ${r.page.status}` : `❌ ${r.page.status}`;
    const og = r.ogImage ? '✅' : '–';
    const jl = r.jsonLdImages?.length ?? 0;
    const ok = r.validated.filter(v => v.ok && v.is_image).length;
    md += `| ${r.product.label} | \`${url}\` | ${status} | ${og} | ${jl} | ${ok} |\n`;
  }

  md += `\n## Per-page detail\n\n`;
  for (const r of all) {
    md += `### ${r.product.label} — \`${r.page.url}\`\n\n`;
    if (!r.page.ok) { md += `**FETCH FAILED** ${r.page.status} ${r.page.error ?? ''}\n\n`; continue; }
    md += `- HTML bytes: ${r.page.htmlBytes}\n`;
    md += `- og:title: \`${r.ogTitle?.slice(0, 120) ?? '–'}\`\n`;
    md += `- og:image: \`${r.ogImage ?? '–'}\`\n`;
    md += `- JSON-LD images (${r.jsonLdImages.length}):\n`;
    for (const u of r.jsonLdImages.slice(0, 6)) md += `  - \`${u}\`\n`;
    md += `\nValidation:\n\n`;
    md += `| URL | HTTP | Type | Size |\n|---|---:|---|---:|\n`;
    for (const v of r.validated) {
      const ok = v.ok && v.is_image ? '✅ ' : v.ok ? '⚠️ ' : '❌ ';
      md += `| \`${v.url.length > 90 ? v.url.slice(0,87)+'…' : v.url}\` | ${ok}${v.status} | ${v.content_type ?? v.error ?? '-'} | ${v.bytes ?? 0}B |\n`;
    }
    md += '\n';
  }
  await writeFile(outPath, md);
  console.error(`\nwrote ${outPath}`);
  console.log(outPath);
}

main().catch(e => { console.error(e); process.exit(1); });
