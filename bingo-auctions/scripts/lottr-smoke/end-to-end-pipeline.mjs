#!/usr/bin/env node
// Phase 6: end-to-end pipeline simulation.
//
// For each test product, run the CANDIDATE production architecture:
//   1. URL-Finder prompt via Sonar → product page URLs
//   2. Filter to US retailers
//   3. Fetch each page server-side with browser UA
//   4. Parse JSON-LD Product + og:image
//   5. Validate every image URL (HEAD request, content-type=image/*)
//
// Scores each product on:
//   - Did we get at least 1 real working stock image URL?
//   - How many total candidate URLs?
//   - Cost of the lookup
//
// This is the "scan → draft listing" loop minus the actual vision step
// (we use ground-truth identification from product_lookups for the test).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const OUT_DIR   = resolve(REPO_ROOT, 'scripts/lottr-smoke/results');

// Rotating UA pool — varies per request to spread the fingerprint.
const BROWSER_UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
];
function pickUA() { return BROWSER_UAS[Math.floor(Math.random() * BROWSER_UAS.length)]; }

// Per-host rate limit (ms). After fetching a URL on host X, wait at least
// this long before fetching another on the same host. Spreads load across
// retailers, avoids the "we hit Walmart 8 times in 2 seconds" stub-page
// trigger we observed.
const PER_HOST_DELAY_MS = 3000;
const lastFetchAt = new Map();

async function paceHost(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return; }
  const prev = lastFetchAt.get(host) ?? 0;
  const since = Date.now() - prev;
  if (since < PER_HOST_DELAY_MS) {
    await new Promise(r => setTimeout(r, PER_HOST_DELAY_MS - since));
  }
  lastFetchAt.set(host, Date.now());
}

// Mirror of ALLOWED_IMAGE_HOSTS plus a few I'd consider adding based
// on Phase 4 results. Marked with ★ are candidate additions.
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

// Hosts we should reject as non-US.
const NON_US_HOSTS = new Set([
  'noon.com', 'www.noon.com', 'ubuy.com.br', 'www.ubuy.com.br',
  'ubuy.com', 'www.ubuy.com', 'alibaba.com', 'www.alibaba.com',
  'amazon.co.uk', 'amazon.de', 'amazon.ca', 'amazon.com.au', 'amazon.in',
  'amazon.jp', 'amazon.fr', 'amazon.it', 'amazon.es',
  'f.nooncdn.com', 'k.nooncdn.com',
]);

// Retailers whose product pages we KNOW return reliable og:image — we
// trust their og:image even if the CDN host is non-allowlist (e.g. a
// manufacturer's Shopify CDN linked from a Walmart product page).
const TRUSTED_RETAILER_HOSTS = new Set([
  'www.walmart.com', 'walmart.com', 'business.walmart.com',
  'www.target.com', 'target.com',
  'www.homedepot.com', 'homedepot.com',
  'www.lowes.com', 'lowes.com',
  'www.bestbuy.com', 'bestbuy.com',
  'www.costco.com', 'costco.com',
  'www.bhphotovideo.com', 'bhphotovideo.com',
  'www.newegg.com', 'newegg.com',
  'www.bathandbodyworks.com', 'bathandbodyworks.com',
  'www.ulta.com', 'ulta.com',
  'www.sephora.com', 'sephora.com',
  'www.cvs.com', 'cvs.com',
  'www.walgreens.com', 'walgreens.com',
  'www.kohls.com', 'kohls.com',
  'www.acehardware.com', 'acehardware.com',
  'www.tractorsupply.com', 'tractorsupply.com',
  'www.chewy.com', 'chewy.com',
  'www.petco.com', 'petco.com',
  'www.staples.com', 'staples.com',
  'www.officedepot.com', 'officedepot.com',
  'www.macys.com', 'macys.com',
  'www.kroger.com', 'kroger.com',
  'www.heb.com', 'heb.com',
  'www.dollargeneral.com', 'dollargeneral.com',
  'www.familydollar.com', 'familydollar.com',
  'shop.creality3dofficial.com', 'creality3dofficial.com', 'www.creality3dofficial.com',
  'shop.drsquatch.com', 'drsquatch.com', 'www.drsquatch.com',
  // Discovered in earlier test runs as reliable og:image-emitting retailers
  'www.instacart.com', 'instacart.com',
  'shopcgx.com', 'www.shopcgx.com',
  'www.apple.com', 'apple.com', 'store.apple.com',
  'lowesmarketdelivers.com', 'www.lowesmarketdelivers.com',
  'truegether.com', 'www.truegether.com',
  'championbbqsupply.com', 'www.championbbqsupply.com',
  'www.fiestaspices.com', 'fiestaspices.com',
]);

function isTrustedRetailerHost(url) {
  try { return TRUSTED_RETAILER_HOSTS.has(new URL(url).hostname.toLowerCase()); }
  catch { return false; }
}

function isUS(url) {
  try { return !NON_US_HOSTS.has(new URL(url).hostname.toLowerCase()); }
  catch { return false; }
}

function isAllowedImage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch { return false; }
}

// Test products with ground-truth identification (from intake pull).
// Smaller curated set for rate-limit-friendly test runs.
const PRODUCTS = [
  { label: 'Smood-Cleanser', brand: 'Smood',           title: 'Smood Calm Me Down Antioxidant Cleanser 3.38 fl oz',  upc: '600064472700',  asin: '',           fnsku: '' },
  { label: 'Origami-Set',    brand: '',                title: "Children's Scene-based 3D Origami Set",                upc: '6975645710369', asin: '',           fnsku: '' },
  { label: 'Konsait-Tattoos',brand: 'Konsait',         title: 'Konsait Glitter Temporary Tattoos for Girls 24 Sheets', upc: '',              asin: 'B097CYP897', fnsku: 'X0046QHSX7' },
  { label: 'Pronto-Acetone', brand: 'Pronto',          title: 'Pronto 100% Pure Acetone Professional Remover 16 fl oz', upc: '',              asin: 'B07TYZN78W', fnsku: '' },
  { label: '3DKIT-NoBrand',  brand: '',                title: '3DKIT-TOOL 3D Printer Tool Kit',                       upc: '',              asin: '',           fnsku: '' },
];

const URL_FINDER_PROMPT = `Find this product on US retailer websites. Return up to 6 specific
product PAGE URLs (NOT image URLs, NOT search-result pages).

DIVERSIFY RETAILERS — pick a mix from these high-og:image hosts:
  - target.com, homedepot.com, lowes.com, bestbuy.com, costco.com
  - bhphotovideo.com, newegg.com, acehardware.com, tractorsupply.com
  - chewy.com, petco.com, kohls.com, macys.com, sephora.com, ulta.com
  - bathandbodyworks.com, cvs.com, walgreens.com, kroger.com
  - manufacturer official site if available (e.g. drsquatch.com, dewalt.com)
  - smaller specialty retailers / Shopify stores selling the same product
  - instacart.com, shopcgx.com, or any retailer that consistently exposes
    og:image meta tags on its product pages

DO NOT include:
- amazon.com / amzn.to — we can't fetch their pages (WAF block).
- ebay.com — eBay returns 403 to server-side fetches.
- walmart.com — Walmart aggressively rate-limits and serves bot-challenge
  pages (we have other retailers that work better).
- noon.com, ubuy.com, alibaba.com, amazon.co.uk/.de/.ca etc — non-US.

Return JSON only:
{
  "product_urls": [
    "https://www.target.com/p/...",
    "https://www.homedepot.com/p/..."
  ]
}

Rules:
- Specific product page URLs only. /ip/, /p/, /pd/, /site/, /dp/ patterns.
  No /search?q=, no category index pages, no homepages.
- Up to 6 URLs from at LEAST 3 different retailers.
- ONLY URLs you literally saw in search results — no fabrication.
- Empty array if you can't find any:  { "product_urls": [] }
- No other fields.`;

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

async function callUrlFinder(apiKey, model, product) {
  const desc = [
    product.brand && `Brand: ${product.brand}`,
    product.title && `Title: ${product.title}`,
    product.upc && `UPC: ${product.upc}`,
    product.asin && `ASIN: ${product.asin}`,
    product.fnsku && `FNSKU: ${product.fnsku}`,
  ].filter(Boolean).join('\n');
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: `${URL_FINDER_PROMPT}\n\nProduct:\n${desc}` }],
      max_tokens: 2000,
      usage: { include: true },
    }),
  });
  const latency = Date.now() - t0;
  if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(()=>''), latency };
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content ?? '';
  let urls = [];
  try {
    const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed.product_urls)) urls = parsed.product_urls.filter(u => typeof u === 'string');
    else if (Array.isArray(parsed.image_urls)) urls = parsed.image_urls.filter(u => typeof u === 'string');
  } catch {
    urls = (text.match(/https:\/\/[^\s"')]+/g) ?? []);
  }
  return { ok: true, latency, urls, cost: j.usage?.cost ?? 0, finish: j.choices?.[0]?.finish_reason };
}

function firstMatch(html, patterns) {
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return decodeURIComponent(m[1].replace(/&amp;/g, '&'));
  }
  return null;
}

const OG_IMAGE_PATTERNS = [
  /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i,
  /<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i,
  /<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i,
];

function extractJsonLdImages(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const node = JSON.parse(m[1].trim());
      const walk = (n) => {
        if (!n) return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (typeof n !== 'object') return;
        if (n['@type'] === 'Product' || (Array.isArray(n['@type']) && n['@type'].includes('Product'))) {
          const img = n.image;
          if (typeof img === 'string') out.push(img);
          else if (Array.isArray(img)) for (const v of img) {
            if (typeof v === 'string') out.push(v);
            else if (v && typeof v === 'object' && typeof v.url === 'string') out.push(v.url);
          }
          else if (img && typeof img === 'object' && typeof img.url === 'string') out.push(img.url);
        }
        for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
      };
      walk(node);
    } catch {}
  }
  return out;
}

async function fetchPage(url) {
  await paceHost(url);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': pickUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const html = await res.text();
    return { ok: true, status: res.status, html, bytes: html.length };
  } catch (e) { return { ok: false, status: 0, error: String(e?.message ?? e) }; }
}

async function validateImg(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const ct = r.headers.get('content-type') ?? '';
    const len = Number(r.headers.get('content-length') ?? 0);
    return { url, status: r.status, ok: r.ok, is_image: ct.startsWith('image/'), bytes: len, content_type: ct };
  } catch (e) { return { url, status: 0, ok: false, is_image: false, error: String(e?.message ?? e) }; }
}

async function processProduct(apiKey, product, models) {
  console.error(`\n=== ${product.label} ===`);

  // Step 1: URL-Finder via each model in parallel; merge URLs
  const urlFinderResults = await Promise.all(models.map(async m => {
    process.stderr.write(`  url-find via ${m.label}…`);
    const r = await callUrlFinder(apiKey, m.id, product);
    process.stderr.write(r.ok ? ` ${r.urls.length}urls $${r.cost.toFixed(4)} ${r.latency}ms\n` : ` FAIL ${r.status}\n`);
    return { model: m, result: r };
  }));
  const totalCost = urlFinderResults.reduce((s, r) => s + (r.result.cost ?? 0), 0);

  // Merge + dedupe, filter US-only, skip blocked retailers.
  // - amazon.com: WAF blocks Worker fetches
  // - ebay.com: 403s server-side fetches
  // - walmart.com: aggressive rate-limit + bot-challenge stub (our test
  //               environment is on probation; production may differ but
  //               we exclude here to validate alternate-retailer coverage)
  const allUrls = [...new Set(urlFinderResults.flatMap(r => r.result.urls ?? []))];
  const filtered = allUrls
    .filter(u => isUS(u))
    .filter(u => {
      try {
        const h = new URL(u).hostname;
        return !/amazon\.com$/.test(h)
          && !/(^|\.)ebay\.com$/.test(h)
          && !/(^|\.)walmart\.com$/.test(h);
      } catch { return false; }
    });
  const perHostCount = new Map();
  const pagesToFetch = [];
  for (const u of filtered) {
    try {
      const h = new URL(u).hostname.toLowerCase();
      const n = perHostCount.get(h) ?? 0;
      if (n >= 2) continue; // cap 2 per host
      perHostCount.set(h, n + 1);
      pagesToFetch.push(u);
    } catch {}
    if (pagesToFetch.length >= 6) break; // overall cap
  }

  console.error(`  ${allUrls.length} total URLs from finders → ${pagesToFetch.length} fetchable (US, non-Amazon)`);

  // Step 2: fetch each page, extract og:image + JSON-LD.
  // Track whether the page is on a trusted retailer host so we know if
  // its og:image is implicitly retailer-vouched (and we can accept it
  // even if the CDN host isn't on the strict allowlist).
  const pageResults = [];
  for (const url of pagesToFetch) {
    process.stderr.write(`  fetch ${url.slice(0, 80)}…`);
    const page = await fetchPage(url);
    if (!page.ok) {
      process.stderr.write(` FAIL ${page.status}\n`);
      pageResults.push({ url, page, images: [], trusted: false });
      continue;
    }
    const og = firstMatch(page.html, OG_IMAGE_PATTERNS);
    const jl = extractJsonLdImages(page.html);
    const images = [...new Set([...(og ? [og] : []), ...jl])];
    const trusted = isTrustedRetailerHost(url);
    process.stderr.write(` ok ${page.status} ${page.bytes}B → og:${og?'y':'n'} jl:${jl.length}${trusted?' [trusted]':''}\n`);
    pageResults.push({ url, page: { ok: true, status: page.status, bytes: page.bytes }, images, trusted });
  }

  // Step 3: validate every image. Also track which images came from
  // trusted retailer pages (those are accepted regardless of CDN host).
  // Build url → trustedFromRetailer map.
  const imageSources = new Map();
  for (const p of pageResults) {
    for (const img of p.images) {
      if (!imageSources.has(img)) imageSources.set(img, { trusted: !!p.trusted, retailers: new Set() });
      const entry = imageSources.get(img);
      if (p.trusted) entry.trusted = true;
      try { entry.retailers.add(new URL(p.url).hostname); } catch {}
    }
  }
  const allImages = Array.from(imageSources.keys());
  console.error(`  validating ${allImages.length} unique image URLs…`);
  const validated = await Promise.all(allImages.map(async u => {
    const v = await validateImg(u);
    const src = imageSources.get(u);
    return { ...v, retailerVouched: !!src?.trusted, retailers: Array.from(src?.retailers ?? []) };
  }));

  // Score
  const workingImages = validated.filter(v => v.ok && v.is_image);
  const allowlistImages = workingImages.filter(v => isAllowedImage(v.url));
  const vouchedImages = workingImages.filter(v => v.retailerVouched);
  const acceptedImages = workingImages.filter(v => isAllowedImage(v.url) || v.retailerVouched);
  console.error(`  ✅ ${workingImages.length} working images — ${allowlistImages.length} on allowlist, ${vouchedImages.length} retailer-vouched, ${acceptedImages.length} would be accepted`);

  return {
    product,
    urlFinderResults,
    totalCost,
    pagesToFetch,
    pageResults,
    validated,
    workingImages,
    allowlistImages,
    vouchedImages,
    acceptedImages,
  };
}

async function main() {
  await loadEnv(resolve(REPO_ROOT, '.env.smoke.local'));
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) { console.error('OPENROUTER_API_KEY missing'); process.exit(2); }

  // 3 URL-finders for diversity. GPT-4o-Search dominated MSRP capture in
  // the prior mega-sim. Sonar is cheap baseline. Sonar-Pro adds reasoning.
  const models = [
    { id: 'perplexity/sonar',                label: 'Sonar' },
    { id: 'openai/gpt-4o-search-preview',    label: 'GPT-4o-Search' },
    { id: 'perplexity/sonar-pro',            label: 'Sonar-Pro' },
  ];

  const allResults = [];
  for (const p of PRODUCTS) {
    allResults.push(await processProduct(apiKey, p, models));
  }

  // Markdown report
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolve(OUT_DIR, `end-to-end-${ts}.md`);
  await mkdir(dirname(outPath), { recursive: true });

  let md = `# End-to-end stock-image pipeline — ${new Date().toISOString()}\n\n`;
  md += `Architecture: URL-Finder (parallel Sonar + GPT-4o-Search + Sonar-Pro) → fetch page → extract og:image + JSON-LD → HEAD-validate.\n`;
  md += `Acceptance rule: image URL must EITHER be on the strict ALLOWED_IMAGE_HOSTS list OR come from a fetched TRUSTED_RETAILER page (Walmart, Target, Home Depot, etc.).\n\n`;
  md += `## Summary by product\n\n`;
  md += `| Product | Finder $ | Pages OK | Working imgs | On allowlist | Retailer-vouched | **Would accept** |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|\n`;
  let totalSpend = 0;
  let productsWithImages = 0;
  for (const r of allResults) {
    totalSpend += r.totalCost;
    if (r.acceptedImages.length > 0) productsWithImages += 1;
    md += `| ${r.product.label} | $${r.totalCost.toFixed(4)} | ${r.pageResults.filter(p=>p.page.ok).length}/${r.pagesToFetch.length} | ${r.workingImages.length} | ${r.allowlistImages.length} | ${r.vouchedImages.length} | **${r.acceptedImages.length}** |\n`;
  }
  md += `\n**Total spend: $${totalSpend.toFixed(4)}** across ${allResults.length} products.\n`;
  md += `**Hit rate: ${productsWithImages}/${allResults.length} (${((productsWithImages/allResults.length)*100).toFixed(0)}%) of products yielded at least one acceptable stock image.**\n`;
  md += `\n## Per-product breakdown\n\n`;
  for (const r of allResults) {
    md += `### ${r.product.label}\n\n`;
    md += `Identification: brand=\`${r.product.brand}\` title=\`${r.product.title}\` ${r.product.upc?`upc=${r.product.upc} `:''}${r.product.asin?`asin=${r.product.asin} `:''}${r.product.fnsku?`fnsku=${r.product.fnsku}`:''}\n\n`;
    md += `**URL-Finder results:**\n\n`;
    for (const u of r.urlFinderResults) {
      md += `- ${u.model.label}: ${u.result.ok ? `${u.result.urls.length} URLs, $${u.result.cost.toFixed(4)}, ${u.result.latency}ms` : `FAIL ${u.result.status}`}\n`;
    }
    md += `\n**Pages fetched (${r.pageResults.filter(p=>p.page.ok).length}/${r.pagesToFetch.length} OK):**\n\n`;
    for (const pr of r.pageResults) {
      const status = pr.page.ok ? `✅ ${pr.page.status}` : `❌ ${pr.page.status ?? '?'}`;
      const url = pr.url.length > 90 ? pr.url.slice(0,87)+'…' : pr.url;
      md += `- \`${url}\` — ${status}, ${pr.images.length} images extracted\n`;
    }
    md += `\n**Working stock images (${r.workingImages.length}):**\n\n`;
    if (r.workingImages.length === 0) md += `*None found.*\n\n`;
    else {
      md += `| URL | On allowlist | Retailer-vouched | Bytes |\n|---|---|---|---:|\n`;
      for (const v of r.workingImages) {
        const allow = isAllowedImage(v.url) ? '✅' : '❌';
        const vouched = v.retailerVouched ? `✅ (${v.retailers[0] || ''})` : '❌';
        const u = v.url.length > 90 ? v.url.slice(0,87)+'…' : v.url;
        md += `| \`${u}\` | ${allow} | ${vouched} | ${v.bytes}B |\n`;
      }
      md += '\n';
    }
  }
  await writeFile(outPath, md);
  console.error(`\nwrote ${outPath}`);
  console.log(outPath);
}

main().catch(e => { console.error(e); process.exit(1); });
