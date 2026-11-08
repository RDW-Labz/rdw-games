#!/usr/bin/env node
// reverify-drain-heroes.mjs — one-off cleanup for the pre-#192 wrong-hero window.
//
// The per-minute image drain used to fail OPEN on the same-product vision gate,
// so unverifiable/wrong stock images were prepended as lot heroes (bidder-facing
// first photo). #192 (title tier) + #195 (identifier tier) stopped NEW ones.
// This re-verifies the lots the drain title-tier heroed since the 2026-07-10
// backfill and, in --apply mode, removes a hero the vision gate is CONFIDENT is
// wrong (the staff photos then lead) and re-enqueues the lot so the now-strict
// drain can fetch a correct stock photo.
//
// DRY-RUN by default: verifies + reports counts + samples, writes NOTHING.
//   node scripts/reverify-drain-heroes.mjs            # dry run
//   node scripts/reverify-drain-heroes.mjs --apply    # remediate confirmed-wrong
//
// Env required (CI provides these as secrets; locally read from .secrets/.env):
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY
//
// Safe: only touches lots whose CURRENT hero is still the drain-written image,
// and only removes it on a CONFIDENT "false" verdict (fail-open — a flaky
// verifier never strips a correct hero). No schema changes.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const APPLY = process.argv.includes('--apply');
const MODEL = process.env.LLM_MODEL_IMAGE_VERIFY_DEFAULT || 'google/gemini-3.1-flash-lite';
const SINCE = '2026-07-10'; // start of the 0259/0260 backfill era

if (!SUPABASE_URL || !SERVICE_KEY || !OPENROUTER_KEY) {
  console.error('::error::missing env (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY)');
  process.exit(1);
}

const rest = (path, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

// Mirror image-verify.ts: build the product text + prompt, ask for {matches:[bool]}.
function buildPrompt(lot) {
  const parts = [];
  if (lot.title) parts.push(`Title: ${lot.title}`);
  if (lot.brand) parts.push(`Brand: ${lot.brand}`);
  if (lot.description) parts.push(`Description: ${lot.description}`);
  const desc = parts.join('\n');
  return (
    `You are checking a candidate stock photo for an auction listing.\n\n` +
    `Product:\n${desc}\n\n` +
    `Decide whether the image plausibly shows THIS exact product (a retailer ` +
    `stock photo of the same item).\n\n` +
    `COLOR: if the product text names a specific color, an image showing a ` +
    `clearly DIFFERENT color is NOT a match. If no color is named, ignore color.\n\n` +
    `Answer false when the image is a clearly different product, a category/` +
    `promo banner, a store/brand logo, a size chart/infographic, a blank/` +
    `"image unavailable" placeholder, or otherwise not a photo of this item.\n\n` +
    `Respond with ONLY this JSON: {"matches":[true|false]}`
  );
}

async function verifyHero(lot, heroUrl) {
  const body = {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: heroUrl, detail: 'low' } },
          { type: 'text', text: buildPrompt(lot) },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  };
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${OPENROUTER_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) return null; // fail open on API error
  const j = await r.json();
  const txt = j?.choices?.[0]?.message?.content;
  if (!txt) return null;
  try {
    const m = JSON.parse(txt).matches;
    if (Array.isArray(m) && typeof m[0] === 'boolean') return m[0];
  } catch {
    /* fall open */
  }
  return null; // unparseable → fail open (treat as OK)
}

async function main() {
  // 1) suspect jobs: title-tier drain writes since the backfill era
  const jobsRes = await rest(
    `image_enrichment_jobs?select=target_id,resolved_image_url&target_table=eq.lots` +
      `&identifier_kind=eq.title&status=eq.succeeded&processed_at=gt.${SINCE}` +
      `&resolved_image_url=not.is.null&limit=2000`,
  );
  const jobs = await jobsRes.json();
  if (!Array.isArray(jobs)) {
    console.error('::error::jobs query failed', JSON.stringify(jobs));
    process.exit(1);
  }
  const byLot = new Map();
  for (const j of jobs) byLot.set(j.target_id, j.resolved_image_url); // latest wins (query order)
  const lotIds = [...byLot.keys()];
  console.log(`suspect title-tier jobs: ${jobs.length} across ${lotIds.length} lots`);

  // 2) fetch those lots, keep only where the drain image is STILL the hero
  const suspects = [];
  for (let i = 0; i < lotIds.length; i += 200) {
    const slice = lotIds.slice(i, i + 200);
    const lr = await rest(
      `lots?select=id,lot_code,title,brand,description,photo_urls&id=in.(${slice.join(',')})`,
    );
    const rows = await lr.json();
    for (const lot of rows || []) {
      const hero = Array.isArray(lot.photo_urls) ? lot.photo_urls[0] : null;
      if (hero && hero === byLot.get(lot.id)) suspects.push({ ...lot, hero });
    }
  }
  console.log(`lots whose current hero is still the drain image: ${suspects.length}`);

  // 3) verify each hero (small concurrency)
  let wrong = 0, ok = 0, unknown = 0, remediated = 0;
  const samples = [];
  const CONC = 5;
  for (let i = 0; i < suspects.length; i += CONC) {
    const batch = suspects.slice(i, i + CONC);
    const verdicts = await Promise.all(batch.map((s) => verifyHero(s, s.hero).catch(() => null)));
    for (let k = 0; k < batch.length; k++) {
      const s = batch[k];
      const v = verdicts[k];
      if (v === false) {
        wrong++;
        if (samples.length < 25) samples.push({ lot_code: s.lot_code, title: s.title, hero: s.hero });
        if (APPLY) {
          const newUrls = (s.photo_urls || []).filter((u) => u !== s.hero);
          await rest(`lots?id=eq.${s.id}`, {
            method: 'PATCH',
            headers: { prefer: 'return=minimal' },
            body: JSON.stringify({ photo_urls: newUrls }),
          });
          // Re-enqueue: reset the succeeded job to pending so the now-strict
          // drain re-fetches a verified stock photo.
          await rest(
            `image_enrichment_jobs?target_table=eq.lots&target_id=eq.${s.id}&status=eq.succeeded`,
            {
              method: 'PATCH',
              headers: { prefer: 'return=minimal' },
              body: JSON.stringify({ status: 'pending', error: 'hero_reverify_reenqueue' }),
            },
          );
          remediated++;
        }
      } else if (v === true) ok++;
      else unknown++;
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? 'APPLY' : 'DRY_RUN',
        suspects: suspects.length,
        confirmed_wrong: wrong,
        confirmed_ok: ok,
        unverifiable_kept: unknown,
        remediated: APPLY ? remediated : 0,
        samples,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error('::error::', e?.message || e);
  process.exit(1);
});
