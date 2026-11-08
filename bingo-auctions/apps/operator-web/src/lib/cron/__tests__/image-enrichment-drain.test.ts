// image-enrichment-drain.test.ts
//
// Unit tests for the image-enrichment drain worker, focused on step 1.5:
// the catalog cross-reference that short-circuits external API calls when
// product_lookups already has a cached image for the same UPC or ASIN.
//
// Mocked boundaries:
//   • @/lib/supabase-admin  — prevent real DB calls
//   • @auction-platform/image-enrichment — prevent real network calls

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── Mock supabase-admin ────────────────────────────────────────────────────────
//
// The drain calls admin.from(table).select/update/in/eq/order/limit etc.
// We build a chainable mock that captures the final terminal call (.returns /
// .maybeSingle / .then / implicit resolution) and resolves to whatever data we
// configure per table.

type ChainableMock = Record<string, (...args: unknown[]) => ChainableMock> & {
  _resolve: () => Promise<{ data: unknown; error: unknown }>;
};

function makeChain(result: () => Promise<{ data: unknown; error: unknown }>): ChainableMock {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === '_resolve') return result;
      if (prop === 'then') {
        // Allow Promise-like chaining via .then(undefined, handler)
        return (onFulfilled: unknown, onRejected: unknown) => {
          const p = result();
          if (typeof onFulfilled === 'function' || typeof onRejected === 'function') {
            return p.then(
              typeof onFulfilled === 'function' ? (onFulfilled as (v: unknown) => unknown) : undefined,
              typeof onRejected === 'function' ? (onRejected as (e: unknown) => unknown) : undefined,
            );
          }
          return p;
        };
      }
      if (prop === 'maybeSingle') return () => result();
      if (prop === 'returns') return () => result();
      // All other chaining methods return the same proxy
      return () => proxy;
    },
  };
  const proxy = new Proxy({}, handler) as ChainableMock;
  return proxy;
}

// Table-level state registry for each test scenario.
// keyed by table name → array of rows to return (first call pops from head).
const tableCallQueue = new Map<string, Array<{ data: unknown; error: unknown }>>();

function queueTableResult(table: string, result: { data: unknown; error: unknown }) {
  if (!tableCallQueue.has(table)) tableCallQueue.set(table, []);
  tableCallQueue.get(table)!.push(result);
}

function nextTableResult(table: string): { data: unknown; error: unknown } {
  const queue = tableCallQueue.get(table);
  if (queue && queue.length > 0) return queue.shift()!;
  // Default: empty success
  return { data: null, error: null };
}

vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) =>
      makeChain(() => Promise.resolve(nextTableResult(table))),
  }),
}));

// ── Mock image-enrichment package ─────────────────────────────────────────────

const mockProbeAmazonAsinImage = vi.fn();
const mockFetchOpenFoodFactsImage = vi.fn();
const mockFetchOpenLibraryImage = vi.fn();
const mockDetectIdentifier = vi.fn();

vi.mock('@auction-platform/image-enrichment', () => ({
  detectIdentifier: (...args: unknown[]) => mockDetectIdentifier(...args),
  probeAmazonAsinImage: (...args: unknown[]) => mockProbeAmazonAsinImage(...args),
  fetchOpenFoodFactsImage: (...args: unknown[]) => mockFetchOpenFoodFactsImage(...args),
  fetchOpenLibraryImage: (...args: unknown[]) => mockFetchOpenLibraryImage(...args),
}));

// ── Import SUT after mocks are registered ─────────────────────────────────────

import {
  runImageEnrichmentDrain,
  BATCH_SIZE,
  photoSelectColumns,
  currentPhoto,
  photoUpdatePayload,
  lotHasStaffPhoto,
} from '../image-enrichment-drain';

// ── Helpers ────────────────────────────────────────────────────────────────────

const FAKE_JOB_ID = 'job-uuid-0001';
const FAKE_TARGET_ID = 'row-uuid-0001';

function fakePendingJob(overrides: Partial<{
  id: string;
  target_table: string;
  target_id: string;
  attempts: number;
}> = {}) {
  return {
    id: overrides.id ?? FAKE_JOB_ID,
    operator_id: 'op-uuid-0001',
    target_table: overrides.target_table ?? 'import_rows',
    target_id: overrides.target_id ?? FAKE_TARGET_ID,
    status: 'pending',
    attempts: overrides.attempts ?? 0,
  };
}

function fakeTargetRow(overrides: Partial<{
  id: string;
  photo_url: string | null;
  asin: string | null;
  upc: string | null;
  fnsku: string | null;
  lpn: string | null;
  external_code: string | null;
}> = {}) {
  return {
    id: overrides.id ?? FAKE_TARGET_ID,
    photo_url: overrides.photo_url ?? null,
    asin: overrides.asin ?? null,
    upc: overrides.upc ?? null,
    fnsku: overrides.fnsku ?? null,
    lpn: overrides.lpn ?? null,
    external_code: overrides.external_code ?? null,
  };
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeEach(() => {
  tableCallQueue.clear();
  vi.clearAllMocks();
  // By default external API mocks return null (not-found)
  mockProbeAmazonAsinImage.mockResolvedValue(null);
  mockFetchOpenFoodFactsImage.mockResolvedValue(null);
  mockFetchOpenLibraryImage.mockResolvedValue(null);
});

// ── Test helper: set up the standard 3-table call sequence for one job ─────────
//
// Drain call sequence (happy path through to step 1.5):
//   [1] image_enrichment_jobs  → SELECT candidates (returns our job)
//   [2] image_enrichment_jobs  → UPDATE to in_progress (ignored result)
//   [3] import_rows            → SELECT target row (returns our row)
//   [4] product_lookups        → SELECT catalog cross-ref (configurable)
//   [5] import_rows | lots     → UPDATE photo_url  (if step 1.5 succeeds)
//   [6] image_enrichment_jobs  → UPDATE to succeeded/skipped/failed

function seedStandardJobSequence({
  job = fakePendingJob(),
  targetRow = fakeTargetRow(),
  catalogResult,
  targetWriteError = null,
}: {
  job?: ReturnType<typeof fakePendingJob>;
  targetRow?: ReturnType<typeof fakeTargetRow>;
  catalogResult: { data: unknown; error: unknown };
  targetWriteError?: { message: string } | null;
}) {
  // [1] SELECT candidates
  queueTableResult('image_enrichment_jobs', { data: [job], error: null });
  // [2] UPDATE to in_progress (drain .then(undefined, warn) — ignored result)
  queueTableResult('image_enrichment_jobs', { data: null, error: null });
  // [3] SELECT target row
  queueTableResult(job.target_table, { data: [targetRow], error: null });
  // [4] catalog SELECT
  queueTableResult('product_lookups', catalogResult);
  // [5] UPDATE photo_url on target (only reached if catalog hit + normalized)
  queueTableResult(job.target_table, { data: null, error: targetWriteError });
  // [6] UPDATE job status
  queueTableResult('image_enrichment_jobs', { data: null, error: null });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('step 1.5 — catalog cross-reference before external API', () => {
  // ── Test 1: UPC catalog hit ──────────────────────────────────────────────────
  it('1. UPC catalog hit: copies first image_url and marks succeeded WITHOUT external APIs', async () => {
    const job = fakePendingJob();
    const targetRow = fakeTargetRow({ upc: '012345678901' });

    mockDetectIdentifier.mockReturnValue({ kind: 'upc', value: '012345678901' });

    seedStandardJobSequence({
      job,
      targetRow,
      catalogResult: {
        data: {
          upc: '012345678901',
          image_urls: ['https://images.example.com/upc-product.jpg'],
          confidence: 0.9,
        },
        error: null,
      },
    });

    const result = await runImageEnrichmentDrain();

    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    // External API modules must NOT have been called
    expect(mockProbeAmazonAsinImage).not.toHaveBeenCalled();
    expect(mockFetchOpenFoodFactsImage).not.toHaveBeenCalled();
    expect(mockFetchOpenLibraryImage).not.toHaveBeenCalled();
  });

  // ── Test 2: ASIN-prefix catalog hit ─────────────────────────────────────────
  it('2. ASIN catalog hit: matches via asin: prefix convention and marks succeeded WITHOUT external APIs', async () => {
    const job = fakePendingJob();
    const targetRow = fakeTargetRow({ asin: 'B0CYQCQQ63' });

    mockDetectIdentifier.mockReturnValue({ kind: 'asin', value: 'B0CYQCQQ63' });

    seedStandardJobSequence({
      job,
      targetRow,
      catalogResult: {
        data: {
          upc: 'asin:B0CYQCQQ63',
          image_urls: ['https://m.media-amazon.com/images/I/71abc.jpg'],
          confidence: 0.95,
        },
        error: null,
      },
    });

    const result = await runImageEnrichmentDrain();

    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    expect(mockProbeAmazonAsinImage).not.toHaveBeenCalled();
    expect(mockFetchOpenFoodFactsImage).not.toHaveBeenCalled();
    expect(mockFetchOpenLibraryImage).not.toHaveBeenCalled();
  });

  // ── Test 3: catalog miss (empty image_urls) falls through to external API ───
  it('3. catalog row exists but image_urls=[] (post-scrub): falls through to external API', async () => {
    const job = fakePendingJob();
    const targetRow = fakeTargetRow({ upc: '012345678901' });

    mockDetectIdentifier.mockReturnValue({ kind: 'upc', value: '012345678901' });
    // External API returns a result to confirm step 3 ran
    mockFetchOpenFoodFactsImage.mockResolvedValue({ url: 'https://images.openfoodfacts.org/found.jpg' });

    // Catalog row exists but image_urls is empty (post-MAC.BID scrub state)
    seedStandardJobSequence({
      job,
      targetRow,
      catalogResult: {
        data: {
          upc: '012345678901',
          image_urls: [],
          confidence: 0.5,
        },
        error: null,
      },
    });

    // After catalog miss the drain proceeds to step 3 — need extra DB call slots
    // for the target row UPDATE and job status UPDATE after the external API success
    queueTableResult('import_rows', { data: null, error: null }); // step 4 write
    queueTableResult('image_enrichment_jobs', { data: null, error: null }); // step 4 job update

    const result = await runImageEnrichmentDrain();

    // Step 3 ran and found a URL
    expect(mockFetchOpenFoodFactsImage).toHaveBeenCalledWith('012345678901');
    expect(result.succeeded).toBe(1);
  });

  // ── Test 4: catalog has 'NA'-shape image — normalisePhotoUrl rejects it ──────
  it('4. catalog image_urls=[\"NA\"]: normalisePhotoUrl rejects it, falls through to external API', async () => {
    const job = fakePendingJob();
    const targetRow = fakeTargetRow({ upc: '012345678901' });

    mockDetectIdentifier.mockReturnValue({ kind: 'upc', value: '012345678901' });
    mockFetchOpenFoodFactsImage.mockResolvedValue(null); // external also misses

    seedStandardJobSequence({
      job,
      targetRow,
      catalogResult: {
        data: {
          upc: '012345678901',
          image_urls: ['NA'],
          confidence: 0.1,
        },
        error: null,
      },
    });

    // After catalog miss (NA rejected) → step 3 runs → upstream_not_found
    queueTableResult('image_enrichment_jobs', { data: null, error: null }); // step 5 job update

    const result = await runImageEnrichmentDrain();

    // Fell through to external API (confirmed it was called)
    expect(mockFetchOpenFoodFactsImage).toHaveBeenCalledWith('012345678901');
    // External returned null → upstream_not_found skipped
    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  // ── Test 5: no catalog row exists — falls through to step 3 ─────────────────
  it('5. no catalog row (null from maybeSingle): falls through to external API as today', async () => {
    const job = fakePendingJob();
    const targetRow = fakeTargetRow({ upc: '012345678901' });

    mockDetectIdentifier.mockReturnValue({ kind: 'upc', value: '012345678901' });
    mockFetchOpenFoodFactsImage.mockResolvedValue({ url: 'https://images.openfoodfacts.org/found2.jpg' });

    seedStandardJobSequence({
      job,
      targetRow,
      catalogResult: { data: null, error: null }, // maybeSingle returns null = no row
    });

    // Step 3 external success path needs 2 more DB calls
    queueTableResult('import_rows', { data: null, error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null });

    const result = await runImageEnrichmentDrain();

    expect(mockFetchOpenFoodFactsImage).toHaveBeenCalledWith('012345678901');
    expect(result.succeeded).toBe(1);
  });
});

describe('step 1.5 — pre-existing behavior not regressed', () => {
  it('6. already_has_photo: skipped at step 1 before reaching catalog lookup', async () => {
    const job = fakePendingJob();
    const targetRow = fakeTargetRow({
      photo_url: 'https://existing.example.com/photo.jpg',
      upc: '012345678901',
    });

    // Only 3 calls needed: SELECT candidates, UPDATE in_progress, SELECT target
    queueTableResult('image_enrichment_jobs', { data: [job], error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null });
    queueTableResult('import_rows', { data: [targetRow], error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null }); // markSkipped

    const result = await runImageEnrichmentDrain();

    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(0);
    // Catalog was NOT queried (detectIdentifier not even reached)
    expect(mockDetectIdentifier).not.toHaveBeenCalled();
    expect(mockProbeAmazonAsinImage).not.toHaveBeenCalled();
  });

  it('7. no_identifier: skipped at step 2 before reaching catalog lookup', async () => {
    const job = fakePendingJob();
    const targetRow = fakeTargetRow(); // no asin/upc/fnsku/lpn/external_code

    mockDetectIdentifier.mockReturnValue({ kind: null, value: '' });

    queueTableResult('image_enrichment_jobs', { data: [job], error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null });
    queueTableResult('import_rows', { data: [targetRow], error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null }); // markSkipped

    const result = await runImageEnrichmentDrain();

    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it('8. empty batch: returns zeros without any DB calls', async () => {
    queueTableResult('image_enrichment_jobs', { data: [], error: null });

    const result = await runImageEnrichmentDrain();

    expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0, skipped: 0 });
  });
});

// ── Per-table photo column mapping (regression guard for the lots fix) ─────────
//
// lots.photo_urls[] vs import_rows.photo_url. The drain previously hardcoded the
// scalar `photo_url` for both tables, which would 400 on a SELECT against lots
// (no such column) and silently lose every lot enrichment. These pure-helper
// tests pin the exact column the drain reads/writes per table.
describe('per-table photo column mapping', () => {
  it('photoSelectColumns: photo_urls for lots, scalar photo_url for import_rows', () => {
    expect(photoSelectColumns('lots')).toBe(
      'id, photo_urls, title, brand, description, site_sku, product_sku, asin, upc, fnsku, lpn, external_code',
    );
    expect(photoSelectColumns('import_rows')).toBe(
      'id, photo_url, asin, upc, fnsku, lpn, external_code',
    );
  });

  it('currentPhoto: reads photo_urls[0] for lots, photo_url for import_rows', () => {
    const ids = { id: 'x', asin: null, upc: null, fnsku: null, lpn: null, external_code: null };
    expect(currentPhoto('lots', { ...ids, photo_urls: ['a', 'b'] })).toBe('a');
    expect(currentPhoto('lots', { ...ids, photo_urls: [] })).toBeNull();
    expect(currentPhoto('lots', { ...ids, photo_urls: null })).toBeNull();
    expect(currentPhoto('import_rows', { ...ids, photo_url: 'https://m.media-amazon.com/p.jpg' })).toBe(
      'https://m.media-amazon.com/p.jpg',
    );
    expect(currentPhoto('import_rows', { ...ids, photo_url: null })).toBeNull();
  });

  it('photoUpdatePayload: writes photo_urls[] for lots, photo_url for import_rows', () => {
    const url = 'https://m.media-amazon.com/images/I/71abc.jpg';
    const ids = { id: 'x', asin: null, upc: null, fnsku: null, lpn: null, external_code: null };
    expect(photoUpdatePayload('lots', [url])).toEqual({ photo_urls: [url] });
    expect(photoUpdatePayload('import_rows', [url])).toEqual({ photo_url: url });
    // lots with existing staff captures: stock URLs PREPEND, captures kept.
    const staff =
      'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/op/LOT-1/1.jpg';
    expect(photoUpdatePayload('lots', [url], { ...ids, photo_urls: [staff] })).toEqual({
      photo_urls: [url, staff],
    });
    // duplicates are not repeated
    expect(photoUpdatePayload('lots', [url], { ...ids, photo_urls: [url, staff] })).toEqual({
      photo_urls: [url, staff],
    });
  });
});

// ── lots target_table — end-to-end through the drain ──────────────────────────
describe('lots target_table — drain end-to-end', () => {
  it('lots job, empty photo_urls + UPC catalog hit: succeeds without external APIs', async () => {
    const job = fakePendingJob({ target_table: 'lots', target_id: 'lot-uuid-1' });
    // A lots row carries the photo_urls[] array (empty), NOT the scalar photo_url.
    const lotRow = {
      id: 'lot-uuid-1',
      photo_urls: [] as string[],
      asin: null,
      upc: '012345678901',
      fnsku: null,
      lpn: null,
      external_code: null,
    };
    mockDetectIdentifier.mockReturnValue({ kind: 'upc', value: '012345678901' });

    queueTableResult('image_enrichment_jobs', { data: [job], error: null }); // SELECT candidates
    queueTableResult('image_enrichment_jobs', { data: null, error: null }); // UPDATE in_progress
    queueTableResult('lots', { data: [lotRow], error: null }); // SELECT target row
    queueTableResult('product_lookups', {
      data: {
        upc: '012345678901',
        image_urls: ['https://images.openfoodfacts.org/x.jpg'],
        confidence: 0.9,
      },
      error: null,
    }); // catalog hit (step 1.5)
    queueTableResult('lots', { data: { id: 'lot-uuid-1', photo_urls: [] }, error: null }); // fresh read before write
    queueTableResult('lots', { data: null, error: null }); // UPDATE photo_urls on lot
    queueTableResult('image_enrichment_jobs', { data: null, error: null }); // UPDATE job succeeded

    const result = await runImageEnrichmentDrain();

    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    // Catalog short-circuit: no external API calls.
    expect(mockFetchOpenFoodFactsImage).not.toHaveBeenCalled();
    expect(mockProbeAmazonAsinImage).not.toHaveBeenCalled();
  });

  it('lots job already has photo_urls[0]: skipped at step 1 (no identifier detection)', async () => {
    const job = fakePendingJob({ target_table: 'lots', target_id: 'lot-uuid-2' });
    const lotRow = {
      id: 'lot-uuid-2',
      photo_urls: ['https://m.media-amazon.com/existing.jpg'],
      asin: null,
      upc: '012345678901',
      fnsku: null,
      lpn: null,
      external_code: null,
    };

    queueTableResult('image_enrichment_jobs', { data: [job], error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null });
    queueTableResult('lots', { data: [lotRow], error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null }); // markSkipped

    const result = await runImageEnrichmentDrain();

    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(mockDetectIdentifier).not.toHaveBeenCalled();
  });
});

// ── Staff photos are never touched (owner 2026-10-30) ─────────────────────────
// Staff camera captures AND stock images staff picked while lotting live in
// lot-photos (outside /rehost/). AI enrichment used to prepend in front of them.
const STAFF_URL = 'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/op/LOT-9/1.jpg';
const REHOST_URL = 'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/rehost/abc.jpg';

describe('staff photos are never touched', () => {
  it('lotHasStaffPhoto: lot-photos counts, /rehost/ and external stock do not', () => {
    expect(lotHasStaffPhoto({ photo_urls: [STAFF_URL] })).toBe(true);
    expect(lotHasStaffPhoto({ photo_urls: ['https://m.media-amazon.com/x.jpg', STAFF_URL] })).toBe(true);
    expect(lotHasStaffPhoto({ photo_urls: [REHOST_URL] })).toBe(false);
    expect(lotHasStaffPhoto({ photo_urls: ['https://m.media-amazon.com/x.jpg'] })).toBe(false);
    expect(lotHasStaffPhoto({ photo_urls: [] })).toBe(false);
    expect(lotHasStaffPhoto({ photo_urls: null })).toBe(false);
  });

  it('lot with a staff photo: skipped untouched (no identifier, no lookup, no write)', async () => {
    const job = { ...fakePendingJob({ target_table: 'lots', target_id: 'lot-staff' }), error: null };
    const lotRow = { id: 'lot-staff', photo_urls: [STAFF_URL], asin: null, upc: '012345678901', fnsku: null, lpn: null, external_code: null, title: 'Swan Veritek Pro sidewall set' };
    queueTableResult('image_enrichment_jobs', { data: [job], error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null });
    queueTableResult('lots', { data: [lotRow], error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null }); // markSkipped

    const result = await runImageEnrichmentDrain();
    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 0, skipped: 1 });
    expect(mockDetectIdentifier).not.toHaveBeenCalled();
    expect(tableCallQueue.get('lots')?.length ?? 0).toBe(0); // no extra lots read or write queued/consumed
  });

  it('fuzzy-hero repair job on a lot with a staff photo: also skipped', async () => {
    const job = { ...fakePendingJob({ target_table: 'lots', target_id: 'lot-fuzzy' }), error: 'fuzzy_hero_repair' };
    const lotRow = { id: 'lot-fuzzy', photo_urls: [REHOST_URL, STAFF_URL], asin: null, upc: null, fnsku: null, lpn: null, external_code: null };
    queueTableResult('image_enrichment_jobs', { data: [job], error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null });
    queueTableResult('lots', { data: [lotRow], error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null });

    const result = await runImageEnrichmentDrain();
    expect(result.skipped).toBe(1);
    expect(mockDetectIdentifier).not.toHaveBeenCalled();
  });

  it('lot with no photos: enriched as today (catalog hit written)', async () => {
    const job = fakePendingJob({ target_table: 'lots', target_id: 'lot-empty' });
    const lotRow = { id: 'lot-empty', photo_urls: [] as string[], asin: null, upc: '012345678901', fnsku: null, lpn: null, external_code: null };
    mockDetectIdentifier.mockReturnValue({ kind: 'upc', value: '012345678901' });
    queueTableResult('image_enrichment_jobs', { data: [job], error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null });
    queueTableResult('lots', { data: [lotRow], error: null });
    queueTableResult('product_lookups', { data: { upc: '012345678901', image_urls: ['https://images.openfoodfacts.org/y.jpg'], confidence: 0.9 }, error: null });
    queueTableResult('lots', { data: { id: 'lot-empty', photo_urls: [] }, error: null }); // fresh read
    queueTableResult('lots', { data: null, error: null }); // write
    queueTableResult('image_enrichment_jobs', { data: null, error: null });

    const result = await runImageEnrichmentDrain();
    expect(result.succeeded).toBe(1);
  });

  it('staff photo added between the batch read and the write: no write, skipped', async () => {
    const job = fakePendingJob({ target_table: 'lots', target_id: 'lot-race' });
    const lotRow = { id: 'lot-race', photo_urls: [] as string[], asin: null, upc: '012345678901', fnsku: null, lpn: null, external_code: null };
    mockDetectIdentifier.mockReturnValue({ kind: 'upc', value: '012345678901' });
    queueTableResult('image_enrichment_jobs', { data: [job], error: null });
    queueTableResult('image_enrichment_jobs', { data: null, error: null });
    queueTableResult('lots', { data: [lotRow], error: null });
    queueTableResult('product_lookups', { data: { upc: '012345678901', image_urls: ['https://images.openfoodfacts.org/z.jpg'], confidence: 0.9 }, error: null });
    queueTableResult('lots', { data: { id: 'lot-race', photo_urls: [STAFF_URL] }, error: null }); // fresh read: staff photo appeared
    queueTableResult('image_enrichment_jobs', { data: null, error: null }); // markSkipped

    const result = await runImageEnrichmentDrain();
    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 0, skipped: 1 });
  });

  it('lot with only a stock photo: skipped as already_has_photo, as today', () => {
    // Covered end-to-end by "lots job already has photo_urls[0]" above; the
    // staff guard must not change it.
    expect(lotHasStaffPhoto({ photo_urls: ['https://m.media-amazon.com/existing.jpg'] })).toBe(false);
  });
});
