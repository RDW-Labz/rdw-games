// photo-rehost-drain.ts
//
// Moves every externally-hosted lot photo onto BinGo's own Supabase storage
// ('lot-photos' bucket) and swaps the lot's photo_urls to the internal copy.
//
// Why (owner, 2026-07-05): ~99.6% of storefront images were hotlinked from
// infrastructure BinGo doesn't control — the legacy platform's S3 bucket
// (585 lots of REAL intake photos), Amazon CDN (457), Wayfair CDN (360).
// Any of those URLs can rot or start hotlink-blocking and the catalog goes
// blank. SafeImg gives a graceful placeholder; this drain removes the
// dependency entirely.
//
// Coverage: the drain watches the LOTS TABLE, not any import path — so every
// current and FUTURE creation flow is covered automatically: manifest
// imports, BRN sticker lotting, AI lotting, manual edits, relists. A lot
// whose photos are already all-internal is marked done without any fetches.
//
// Per-lot flow (state columns from mig 0227):
//   claim    photo_rehost_attempts += 1 for the batch up front (same
//            claim-style as email-drain: a crashing lot can't wedge the
//            drain forever — it gets 3 tries, then is left alone).
//   fetch    each external URL, 15s timeout, image/* only (no SVG — script
//            risk when served from our own origin), 12 MB cap. Wayfair
//            wfcdn URLs are a DYNAMIC resizer: we request resize-h1200-w1200
//            at download time so the stored copy is the high-res master
//            render, regardless of the size the manifest happened to carry.
//   upload   'lot-photos' bucket at {operatorId}/rehost/{lotId}/{i}.{ext}
//            (first path segment = operator_id per the bucket's RLS layout;
//            the admin client bypasses RLS but the convention keeps tooling
//            consistent). upsert:true → re-processing is idempotent.
//   swap     photo_urls entry → the storage public URL. photo_urls_original
//            is set once (first mutation) for provenance/fallback.
//   done     photo_rehosted_at = now() when every URL on the lot is
//            internal. Partial success keeps the swapped URLs and retries
//            the stragglers next tick (up to MAX_ATTEMPTS).
//
// The lots_filter_photo_urls trigger re-validates hosts on our UPDATE —
// npwseclcxcatjhgjrtwe.supabase.co was allowlisted in mig 0218. The
// lots_normalize_photo_urls trigger (mig 0226) is a no-op on storage URLs.
//
// Budget: Workers subrequests are the scarce resource, not CPU. Each image
// costs 2 subrequests (fetch + upload); MAX_IMAGES_PER_TICK=30 plus a few
// DB calls keeps a tick well inside the paid-plan limit and under the
// 1-minute cadence. Backlog of ~1,400 external images ≈ a few hours.
//
// Triggered from /api/cron/photo-rehost every minute.

import { getSupabaseAdmin } from '@/lib/supabase-admin';

const BATCH_SIZE = 6;
const MAX_ATTEMPTS = 3;
const MAX_IMAGES_PER_LOT = 12;
const MAX_IMAGES_PER_TICK = 30;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 12 * 1024 * 1024;
const BUCKET = 'lot-photos';

// Storefront lots first: a dead image on a live/scheduled lot costs bids
// right now; a pending_intake lot's photos can wait a few minutes.
const PRIORITY_STATUSES = ['live', 'scheduled'] as const;

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

type LotRow = {
  id: string;
  operator_id: string;
  photo_urls: string[] | null;
  photo_urls_original: string[] | null;
  photo_rehost_attempts: number;
  status: string;
};

export type PhotoRehostDrainResult = {
  scanned: number;
  completed: number;
  partial: number;
  images_rehosted: number;
  images_failed: number;
};

/** True when the URL already lives on our own Supabase storage. */
export function isInternalPhotoUrl(url: string, supabaseUrl: string): boolean {
  return url.startsWith(`${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/`);
}

/**
 * The URL to actually download. Wayfair's wfcdn path embeds the render size
 * (resize-hN-wN); the master is high-res and the size is just a request
 * parameter, so ask for 1200px regardless of what the manifest carried.
 * (The DB trigger from mig 0226 only bumps STORED urls to 800 — requesting
 * 1200 here costs nothing and archives a better copy.)
 */
export function downloadUrlFor(url: string): string {
  if (url.includes('wfcdn.com')) {
    return url.replace(/resize-h\d{1,4}-w\d{1,4}/, 'resize-h1200-w1200');
  }
  return url;
}

async function fetchImage(
  url: string,
): Promise<{ bytes: ArrayBuffer; contentType: string } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(downloadUrlFor(url), {
      signal: controller.signal,
      headers: {
        // Some retail CDNs 403 obvious bot agents; a browser UA + no cookies
        // is the same request a bidder's browser makes today via hotlink.
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
      },
    });
    if (!res.ok) return { error: `http_${res.status}` };

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!EXT_BY_CONTENT_TYPE[contentType]) return { error: `content_type_${contentType || 'missing'}` };

    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > MAX_BYTES) return { error: 'too_large' };

    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) return { error: 'too_large' };
    if (bytes.byteLength === 0) return { error: 'empty_body' };
    return { bytes, contentType };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runPhotoRehostDrain(): Promise<PhotoRehostDrainResult> {
  const admin = getSupabaseAdmin();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;

  const selectCols = 'id, operator_id, photo_urls, photo_urls_original, photo_rehost_attempts, status';

  // Storefront lots first, then everything else to fill the batch.
  const { data: priority, error: prioErr } = await admin
    .from('lots')
    .select(selectCols)
    .is('photo_rehosted_at', null)
    .lt('photo_rehost_attempts', MAX_ATTEMPTS)
    .not('photo_urls', 'is', null)
    .in('status', [...PRIORITY_STATUSES])
    .order('close_at', { ascending: true, nullsFirst: false })
    .limit(BATCH_SIZE)
    .returns<LotRow[]>();

  if (prioErr) {
    console.error('[photo-rehost] candidate fetch failed:', prioErr.message);
    return { scanned: 0, completed: 0, partial: 0, images_rehosted: 0, images_failed: 0 };
  }

  let lots: LotRow[] = priority ?? [];
  if (lots.length < BATCH_SIZE) {
    const { data: rest } = await admin
      .from('lots')
      .select(selectCols)
      .is('photo_rehosted_at', null)
      .lt('photo_rehost_attempts', MAX_ATTEMPTS)
      .not('photo_urls', 'is', null)
      .not('status', 'in', `(${PRIORITY_STATUSES.join(',')})`)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE - lots.length)
      .returns<LotRow[]>();
    lots = lots.concat(rest ?? []);
  }

  if (lots.length === 0) {
    return { scanned: 0, completed: 0, partial: 0, images_rehosted: 0, images_failed: 0 };
  }

  // Claim: bump attempts up front so a lot that crashes the tick still burns
  // a try and can't wedge the drain. (No SKIP LOCKED via supabase-js; at
  // 1 tick/min a double-claim just re-does idempotent work — upsert:true,
  // deterministic paths.)
  for (const lot of lots) {
    await admin
      .from('lots')
      .update({ photo_rehost_attempts: lot.photo_rehost_attempts + 1 })
      .eq('id', lot.id);
  }

  let completed = 0;
  let partial = 0;
  let imagesRehosted = 0;
  let imagesFailed = 0;
  let imageBudget = MAX_IMAGES_PER_TICK;

  for (let li = 0; li < lots.length; li++) {
    const lot = lots[li]!;
    const urls = lot.photo_urls ?? [];
    if (urls.length === 0) {
      // Nothing to host — mark done so it leaves the queue.
      await admin.from('lots').update({ photo_rehosted_at: new Date().toISOString() }).eq('id', lot.id);
      completed++;
      continue;
    }

    const externalIdx = urls
      .map((u, i) => ({ u, i }))
      .filter(({ u }) => !isInternalPhotoUrl(u, supabaseUrl));

    if (externalIdx.length === 0) {
      // Already fully on our storage (camera-captured lots, prior partials).
      await admin.from('lots').update({ photo_rehosted_at: new Date().toISOString() }).eq('id', lot.id);
      completed++;
      continue;
    }

    if (imageBudget <= 0) {
      // Budget exhausted before this lot did any work — refund the claimed
      // attempt for it and the rest of the batch so an unlucky big-batch
      // tick can't burn a lot's 3 tries without ever touching it.
      for (const unprocessed of lots.slice(li)) {
        await admin
          .from('lots')
          .update({ photo_rehost_attempts: unprocessed.photo_rehost_attempts })
          .eq('id', unprocessed.id);
      }
      break;
    }

    const newUrls = [...urls];
    let lotFailed = 0;
    let lotSwapped = 0;

    for (const { u, i } of externalIdx.slice(0, MAX_IMAGES_PER_LOT)) {
      if (imageBudget <= 0) { lotFailed++; continue; } // budget-out → lot retries next tick
      imageBudget--;

      const fetched = await fetchImage(u);
      if ('error' in fetched) {
        console.warn(`[photo-rehost] lot ${lot.id} url[${i}] fetch failed: ${fetched.error}`);
        lotFailed++;
        imagesFailed++;
        continue;
      }

      const ext = EXT_BY_CONTENT_TYPE[fetched.contentType]!;
      const path = `${lot.operator_id}/rehost/${lot.id}/${i}.${ext}`;
      const { error: upErr } = await admin.storage
        .from(BUCKET)
        .upload(path, fetched.bytes, { contentType: fetched.contentType, upsert: true });

      if (upErr) {
        console.warn(`[photo-rehost] lot ${lot.id} url[${i}] upload failed: ${upErr.message}`);
        lotFailed++;
        imagesFailed++;
        continue;
      }

      const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(path);
      newUrls[i] = pub.publicUrl;
      lotSwapped++;
      imagesRehosted++;
    }

    if (externalIdx.length > MAX_IMAGES_PER_LOT) lotFailed += externalIdx.length - MAX_IMAGES_PER_LOT;

    const allDone = lotFailed === 0;
    const update: Record<string, unknown> = {};
    if (lotSwapped > 0) {
      update.photo_urls = newUrls;
      // Provenance: keep the FIRST pre-rehost snapshot only.
      if (!lot.photo_urls_original) update.photo_urls_original = urls;
    }
    if (allDone) update.photo_rehosted_at = new Date().toISOString();

    if (Object.keys(update).length > 0) {
      const { error: writeErr } = await admin.from('lots').update(update).eq('id', lot.id);
      if (writeErr) {
        console.error(`[photo-rehost] lot ${lot.id} write-back failed: ${writeErr.message}`);
        partial++;
        continue;
      }
    }

    if (allDone) completed++;
    else partial++;
  }

  return { scanned: lots.length, completed, partial, images_rehosted: imagesRehosted, images_failed: imagesFailed };
}
