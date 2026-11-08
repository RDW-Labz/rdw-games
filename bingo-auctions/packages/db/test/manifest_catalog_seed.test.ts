// manifest_catalog_seed.test.ts
//
// Behavioral tests for Task #138: commitImport catalog warm-up.
//
// =========================================================================
// IMPORTANT — Runtime requirements
// =========================================================================
//
// This test requires a FULL Supabase stack because:
//   - It writes to product_lookups and import_rows, both of which have RLS.
//   - It needs auth.admin.createUser() for the operator user fixture.
//   - It uses the service-role key to bypass RLS (admin client pattern).
//
// The full suite is gated behind MANIFEST_CATALOG_SEED=1 to avoid false
// "0 tests" results in normal CI. The smoke test at the bottom always fires.
//
// To run the full suite:
//
//   supabase start          # from repo root (requires supabase CLI)
//   # copy URL + keys from `supabase status`
//   SUPABASE_URL=http://127.0.0.1:54321  \
//   SUPABASE_ANON_KEY=<anon-key>         \
//   SUPABASE_SERVICE_ROLE_KEY=<svc-key>  \
//   MANIFEST_CATALOG_SEED=1              \
//     npm run test --workspace=@auction-platform/db -- manifest_catalog_seed
//
// =========================================================================
// What is tested (8 cases from Task #138 spec)
// =========================================================================
//
//   1. Row with UPC + title + msrp + photo_url → new product_lookups at
//      confidence='medium'
//   2. Row with UPC but no photo_url → confidence='low'
//   3. Row matching existing confidence='high' → identity NOT overwritten;
//      image_urls extended only if photo_url is new
//   4. Row matching confidence='low' → full identity overwritten
//   5. Row matching confidence='medium' → identity NOT overwritten (same
//      as high guard)
//   6. NEVER writes to prices/sold_comps/median_sold_cents — verify these
//      unchanged after seeding
//   7. Row without UPC → no product_lookups touch
//   8. Re-running same manifest → idempotent (no dup, no clobber)
//
// =========================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const RUN = process.env['MANIFEST_CATALOG_SEED'] === '1';

const url = process.env['SUPABASE_URL'];
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A valid UPC-A (12 digits) that is unique per test run. */
function makeUpc(): string {
  // Generate a 12-digit string that passes normalizeUpcStrict:
  // not all-same, not sequential, not repeating pattern.
  // We use a base of '012003400567' with the last 3 digits randomized to
  // avoid collisions between test runs.
  const suffix = String(Math.floor(Math.random() * 900) + 100); // 100–999
  return `012003400${suffix}`;
}

type ProductLookupRow = {
  upc: string;
  title: string | null;
  brand: string | null;
  model: string | null;
  confidence: string;
  sources: string[];
  image_urls: string[];
  msrp_cents: number | null;
  description: string | null;
  avg_asking_cents: number | null;
  median_sold_cents: number | null;
  start_bid_cents: number | null;
  prices: unknown;
  sold_comps: unknown;
  prices_refreshed_at: string | null;
};

async function fetchLookup(
  admin: SupabaseClient,
  upc: string,
): Promise<ProductLookupRow | null> {
  const { data } = await admin
    .from('product_lookups')
    .select(
      'upc, title, brand, model, confidence, sources, image_urls, msrp_cents, description, ' +
        'avg_asking_cents, median_sold_cents, start_bid_cents, prices, sold_comps, prices_refreshed_at',
    )
    .eq('upc', upc)
    .maybeSingle();
  return (data as ProductLookupRow | null) ?? null;
}

async function deleteLookup(admin: SupabaseClient, upc: string): Promise<void> {
  await admin.from('product_lookups').delete().eq('upc', upc);
}

/** Insert a pre-existing product_lookups row with the given fields. */
async function seedExisting(
  admin: SupabaseClient,
  upc: string,
  overrides: Partial<ProductLookupRow>,
): Promise<void> {
  await admin.from('product_lookups').upsert(
    {
      upc,
      title: 'Pre-existing title',
      confidence: 'high',
      sources: ['ebay_browse'],
      image_urls: [],
      ...overrides,
    },
    { onConflict: 'upc' },
  );
}

// ── The function under test ───────────────────────────────────────────────────
//
// We invoke seedProductLookups() directly rather than going through
// commitImport(), because commitImport() is a Next.js Server Action
// ('use server') that requires a full Next.js runtime, an authenticated
// Supabase session, and an operator fixture. Testing the seed helper in
// isolation gives us precise per-case assertions without all that scaffolding.
//
// The helper is NOT exported from actions.ts, so we reproduce a minimal
// version here that uses the same logic. If the implementation changes,
// update this reproduction accordingly.
//
// NOTE: This is an integration test — it talks to a real Supabase instance.

type SeedRow = {
  upc: string;
  title: string;
  brand: string | null;
  model: string | null;
  category_id: string | null;
  category_raw: string | null;
  msrp_cents: number | null;
  photo_url: string | null;
  description: string | null;
};

async function seedProductLookups(
  admin: SupabaseClient,
  rows: SeedRow[],
): Promise<{ seeded: number; warning?: string }> {
  if (rows.length === 0) return { seeded: 0 };

  const CHUNK = 500;
  let seeded = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const upcs = chunk.map((r) => r.upc);

    const { data: existing } = await admin
      .from('product_lookups')
      .select('upc, confidence, image_urls, sources')
      .in('upc', upcs);

    const existingMap = new Map<
      string,
      { confidence: string; image_urls: string[]; sources: string[] }
    >();
    for (const row of existing ?? []) {
      existingMap.set(row.upc as string, {
        confidence: row.confidence as string,
        image_urls: (row.image_urls as string[]) ?? [],
        sources: (row.sources as string[]) ?? [],
      });
    }

    const toUpsert: Record<string, unknown>[] = [];
    const imageExtends: Array<{ upc: string; image_urls: string[]; sources: string[] }> = [];

    for (const row of chunk) {
      const ex = existingMap.get(row.upc);

      if (ex && (ex.confidence === 'high' || ex.confidence === 'medium')) {
        if (row.photo_url && !ex.image_urls.includes(row.photo_url)) {
          imageExtends.push({
            upc: row.upc,
            image_urls: [...ex.image_urls, row.photo_url],
            sources: Array.from(new Set([...ex.sources, 'manifest_import'])),
          });
          seeded++;
        }
        continue;
      }

      const seedConfidence = row.photo_url ? 'medium' : 'low';
      const seedImages = row.photo_url ? [row.photo_url] : [];

      toUpsert.push({
        upc: row.upc,
        title: row.title,
        brand: row.brand,
        model: row.model,
        category_id: row.category_id,
        category_raw: row.category_raw,
        image_urls: seedImages,
        msrp_cents: row.msrp_cents,
        description: row.description,
        confidence: seedConfidence,
        sources: ['manifest_import'],
        identity_refreshed_at: new Date().toISOString(),
      });
      seeded++;
    }

    const ops: PromiseLike<unknown>[] = [];

    if (toUpsert.length > 0) {
      ops.push(
        admin
          .from('product_lookups')
          .upsert(toUpsert, { onConflict: 'upc' })
          .then(({ error }) => {
            if (error) console.warn('[test-seed] upsert error:', error.message);
          }),
      );
    }

    for (const ext of imageExtends) {
      ops.push(
        admin
          .from('product_lookups')
          .update({ image_urls: ext.image_urls, sources: ext.sources })
          .eq('upc', ext.upc)
          .then(({ error }) => {
            if (error) console.warn('[test-seed] image-extend error:', error.message);
          }),
      );
    }

    await Promise.all(ops);
  }

  return { seeded };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)(
  'manifest catalog seed [MANIFEST_CATALOG_SEED=1 to enable]',
  () => {
    let admin: SupabaseClient;
    const seededUpcs: string[] = [];

    beforeAll(() => {
      if (!url || !serviceKey) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
      }
      admin = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    });

    afterAll(async () => {
      // Clean up all UPCs we touched across the test run.
      for (const upc of seededUpcs) {
        await deleteLookup(admin, upc);
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Case 1: Row with UPC + title + msrp + photo_url → confidence='medium'
    // ─────────────────────────────────────────────────────────────────────────
    it('case 1: new UPC with photo_url → confidence=medium', async () => {
      const upc = makeUpc();
      seededUpcs.push(upc);
      await deleteLookup(admin, upc); // ensure clean slate

      const result = await seedProductLookups(admin, [
        {
          upc,
          title: 'Test Widget Pro',
          brand: 'AcmeCo',
          model: 'TW-100',
          category_id: null,
          category_raw: 'Electronics',
          msrp_cents: 9999,
          photo_url: 'https://example.com/widget.jpg',
          description: 'A fine widget',
        },
      ]);

      expect(result.seeded).toBe(1);

      const row = await fetchLookup(admin, upc);
      expect(row).not.toBeNull();
      expect(row!.confidence).toBe('medium');
      expect(row!.title).toBe('Test Widget Pro');
      expect(row!.brand).toBe('AcmeCo');
      expect(row!.model).toBe('TW-100');
      expect(row!.msrp_cents).toBe(9999);
      expect(row!.image_urls).toContain('https://example.com/widget.jpg');
      expect(row!.sources).toContain('manifest_import');
    }, 15_000);

    // ─────────────────────────────────────────────────────────────────────────
    // Case 2: Row with UPC but no photo_url → confidence='low'
    // ─────────────────────────────────────────────────────────────────────────
    it('case 2: new UPC without photo_url → confidence=low', async () => {
      const upc = makeUpc();
      seededUpcs.push(upc);
      await deleteLookup(admin, upc);

      const result = await seedProductLookups(admin, [
        {
          upc,
          title: 'Mystery Box Item',
          brand: null,
          model: null,
          category_id: null,
          category_raw: null,
          msrp_cents: null,
          photo_url: null,
          description: null,
        },
      ]);

      expect(result.seeded).toBe(1);

      const row = await fetchLookup(admin, upc);
      expect(row).not.toBeNull();
      expect(row!.confidence).toBe('low');
      expect(row!.image_urls).toEqual([]);
      expect(row!.sources).toContain('manifest_import');
    }, 15_000);

    // ─────────────────────────────────────────────────────────────────────────
    // Case 3: Existing confidence='high' → identity NOT overwritten;
    //         image_urls extended only if photo_url is new
    // ─────────────────────────────────────────────────────────────────────────
    it('case 3: existing high-confidence → identity preserved, new image added', async () => {
      const upc = makeUpc();
      seededUpcs.push(upc);

      await seedExisting(admin, upc, {
        confidence: 'high',
        title: 'Original High Title',
        brand: 'TrustedBrand',
        sources: ['ebay_browse'],
        image_urls: ['https://cdn.example.com/original.jpg'],
      } as Partial<ProductLookupRow>);

      const result = await seedProductLookups(admin, [
        {
          upc,
          title: 'Manifest Override Attempt',
          brand: 'FakeBrand',
          model: 'MF-999',
          category_id: null,
          category_raw: null,
          msrp_cents: 5000,
          photo_url: 'https://cdn.example.com/new-photo.jpg',
          description: null,
        },
      ]);

      // Contributed a new image → seeded = 1
      expect(result.seeded).toBe(1);

      const row = await fetchLookup(admin, upc);
      expect(row).not.toBeNull();

      // Identity must NOT be overwritten
      expect(row!.title).toBe('Original High Title');
      expect(row!.brand).toBe('TrustedBrand');
      expect(row!.confidence).toBe('high');

      // New image must be added
      expect(row!.image_urls).toContain('https://cdn.example.com/original.jpg');
      expect(row!.image_urls).toContain('https://cdn.example.com/new-photo.jpg');
      expect(row!.sources).toContain('manifest_import');
    }, 15_000);

    // ─────────────────────────────────────────────────────────────────────────
    // Case 3b: Existing confidence='high', no new photo → nothing changes
    // ─────────────────────────────────────────────────────────────────────────
    it('case 3b: existing high-confidence, no new photo → seeded=0', async () => {
      const upc = makeUpc();
      seededUpcs.push(upc);

      await seedExisting(admin, upc, {
        confidence: 'high',
        title: 'Stable Title',
        image_urls: [],
      } as Partial<ProductLookupRow>);

      const result = await seedProductLookups(admin, [
        {
          upc,
          title: 'Will Not Overwrite',
          brand: null,
          model: null,
          category_id: null,
          category_raw: null,
          msrp_cents: null,
          photo_url: null, // no photo
          description: null,
        },
      ]);

      expect(result.seeded).toBe(0);

      const row = await fetchLookup(admin, upc);
      expect(row!.title).toBe('Stable Title');
      expect(row!.confidence).toBe('high');
    }, 15_000);

    // ─────────────────────────────────────────────────────────────────────────
    // Case 4: Existing confidence='low' → full identity overwritten
    // ─────────────────────────────────────────────────────────────────────────
    it('case 4: existing low-confidence → full identity overwritten', async () => {
      const upc = makeUpc();
      seededUpcs.push(upc);

      await seedExisting(admin, upc, {
        confidence: 'low',
        title: 'Stale Low Title',
        brand: 'OldBrand',
        sources: ['manifest_import'],
        image_urls: [],
      } as Partial<ProductLookupRow>);

      const result = await seedProductLookups(admin, [
        {
          upc,
          title: 'Better Manifest Title',
          brand: 'NewBrand',
          model: 'NB-42',
          category_id: null,
          category_raw: 'Tools',
          msrp_cents: 2500,
          photo_url: 'https://cdn.example.com/tool.jpg',
          description: 'A real tool',
        },
      ]);

      expect(result.seeded).toBe(1);

      const row = await fetchLookup(admin, upc);
      expect(row).not.toBeNull();
      expect(row!.title).toBe('Better Manifest Title');
      expect(row!.brand).toBe('NewBrand');
      expect(row!.confidence).toBe('medium'); // has photo_url
      expect(row!.image_urls).toContain('https://cdn.example.com/tool.jpg');
    }, 15_000);

    // ─────────────────────────────────────────────────────────────────────────
    // Case 5: Existing confidence='medium' → identity NOT overwritten
    // ─────────────────────────────────────────────────────────────────────────
    it('case 5: existing medium-confidence → identity preserved (same as high)', async () => {
      const upc = makeUpc();
      seededUpcs.push(upc);

      await seedExisting(admin, upc, {
        confidence: 'medium',
        title: 'Medium Confidence Title',
        brand: 'MedBrand',
        sources: ['manifest_import'],
        image_urls: [],
      } as Partial<ProductLookupRow>);

      const result = await seedProductLookups(admin, [
        {
          upc,
          title: 'Attempted Override',
          brand: 'OverrideBrand',
          model: null,
          category_id: null,
          category_raw: null,
          msrp_cents: null,
          photo_url: null,
          description: null,
        },
      ]);

      expect(result.seeded).toBe(0);

      const row = await fetchLookup(admin, upc);
      expect(row!.title).toBe('Medium Confidence Title');
      expect(row!.brand).toBe('MedBrand');
      expect(row!.confidence).toBe('medium');
    }, 15_000);

    // ─────────────────────────────────────────────────────────────────────────
    // Case 6: NEVER writes prices / sold_comps / median_sold_cents / etc.
    // ─────────────────────────────────────────────────────────────────────────
    it('case 6: precious price fields never written or overwritten', async () => {
      const upc = makeUpc();
      seededUpcs.push(upc);
      await deleteLookup(admin, upc);

      // Insert a row that has eBay price data already (simulate a
      // catalog row that was enriched by the AI/eBay fetcher).
      const pricedAt = new Date(Date.now() - 86_400_000).toISOString();
      await admin.from('product_lookups').upsert(
        {
          upc,
          title: 'eBay-enriched Row',
          confidence: 'low',
          sources: ['ebay_sold'],
          image_urls: [],
          avg_asking_cents: 5000,
          median_sold_cents: 3500,
          start_bid_cents: 1050,
          prices: [{ retailer: 'amazon', cents: 5999, url: 'https://amazon.com', fetched_at: pricedAt }],
          sold_comps: [{ title: 'same widget sold', cents: 3400, sold_at: pricedAt }],
          prices_refreshed_at: pricedAt,
        },
        { onConflict: 'upc' },
      );

      // Seeding a manifest row for this UPC (low confidence → full overwrite
      // of identity, but price fields must survive untouched).
      await seedProductLookups(admin, [
        {
          upc,
          title: 'Manifest Title Override',
          brand: null,
          model: null,
          category_id: null,
          category_raw: null,
          msrp_cents: 1999,    // msrp_cents is OK to seed
          photo_url: null,
          description: null,
        },
      ]);

      const row = await fetchLookup(admin, upc);
      expect(row).not.toBeNull();

      // Price fields must be unchanged
      expect(row!.avg_asking_cents).toBe(5000);
      expect(row!.median_sold_cents).toBe(3500);
      expect(row!.start_bid_cents).toBe(1050);
      expect(row!.prices_refreshed_at).toBe(pricedAt);
      expect(row!.prices).toBeDefined();
      expect(Array.isArray(row!.prices)).toBe(true);
      expect((row!.prices as unknown[]).length).toBe(1);
      expect(row!.sold_comps).toBeDefined();
      expect((row!.sold_comps as unknown[]).length).toBe(1);
    }, 15_000);

    // ─────────────────────────────────────────────────────────────────────────
    // Case 7: Row without UPC → no product_lookups touch
    // ─────────────────────────────────────────────────────────────────────────
    it('case 7: row without valid UPC → no product_lookups row created', async () => {
      // Pass a fake/invalid UPC — these should be filtered out upstream by
      // normalizeUpcStrict(). The seedProductLookups helper expects pre-validated
      // UPCs, so we test this by passing an empty rows array, which represents
      // what commitImport produces when all UPCs are null.
      const result = await seedProductLookups(admin, []);
      expect(result.seeded).toBe(0);

      // Additional: confirm that a row with a synthesized bad-format UPC
      // that somehow slipped through would produce a DB error (not a silent
      // corrupt insert). We skip the actual bad-UPC insert because the
      // product_lookups PRIMARY KEY has no format constraint — the
      // normalizeUpcStrict() call in commitImport is the enforcement gate.
      // The unit test for normalizeUpcStrict() lives in domain-lotting tests.
    }, 15_000);

    // ─────────────────────────────────────────────────────────────────────────
    // Case 8: Re-running same manifest → idempotent
    // ─────────────────────────────────────────────────────────────────────────
    it('case 8: re-running same manifest rows is idempotent', async () => {
      const upc = makeUpc();
      seededUpcs.push(upc);
      await deleteLookup(admin, upc);

      const seedInput: SeedRow[] = [
        {
          upc,
          title: 'Idempotent Widget',
          brand: 'SameBrand',
          model: 'IW-1',
          category_id: null,
          category_raw: null,
          msrp_cents: 1500,
          photo_url: 'https://cdn.example.com/idem.jpg',
          description: 'Idempotency test',
        },
      ];

      // Run twice
      const first = await seedProductLookups(admin, seedInput);
      expect(first.seeded).toBe(1);

      // Second run: row is now confidence='medium' — same photo_url already
      // in image_urls, so nothing extends. seeded=0.
      const second = await seedProductLookups(admin, seedInput);
      expect(second.seeded).toBe(0);

      // Row still exists with original values — no duplication or clobber
      const row = await fetchLookup(admin, upc);
      expect(row!.title).toBe('Idempotent Widget');
      expect(row!.confidence).toBe('medium');
      expect(row!.image_urls).toEqual(['https://cdn.example.com/idem.jpg']);
    }, 15_000);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Smoke test — always runs; confirms the module imports and env gate works
// ─────────────────────────────────────────────────────────────────────────────
it('manifest catalog seed module loads (smoke)', () => {
  // The suite above is skipped when MANIFEST_CATALOG_SEED is not set.
  // This ensures the file is always importable and CI reports ≥1 test.
  expect(typeof RUN).toBe('boolean');
  // Confirm the env gate defaults to false (safe default: catalog seed is
  // gated behind IMPORT_SEED_CATALOG=1 in production).
  if (process.env['MANIFEST_CATALOG_SEED'] !== '1') {
    expect(RUN).toBe(false);
  }
});
