// upsert-photo-to-catalog.test.ts
//
// Unit tests for the cross-operator photo sharing helper.
// All Supabase calls are replaced with in-memory stubs — no real DB.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UpsertPhotoOptions } from '../upsert-photo-to-catalog.js';
import { upsertPhotoToCatalog } from '../upsert-photo-to-catalog.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock Supabase admin client. The select / update / insert
 * chain is stubbed per test using the returned spy references.
 */
function makeAdmin(opts: {
  existingRow?: { upc: string; image_urls: string[]; sources: string[] } | null;
  fetchError?: { message: string } | null;
  updateError?: { message: string } | null;
  insertError?: { message: string } | null;
}): SupabaseClient {
  const updateFn = vi.fn().mockResolvedValue({ error: opts.updateError ?? null });
  const insertFn = vi.fn().mockResolvedValue({ error: opts.insertError ?? null });

  const eqUpdateFn = vi.fn().mockReturnValue({ error: opts.updateError ?? null });
  const updateChain = { eq: eqUpdateFn };

  const maybeSingleFn = vi.fn().mockResolvedValue({
    data: opts.existingRow ?? null,
    error: opts.fetchError ?? null,
  });
  const eqSelectFn = vi.fn().mockReturnValue({ maybeSingle: maybeSingleFn });
  const selectChain = { eq: eqSelectFn };

  // update() → chain with eq()
  updateFn.mockReturnValue(updateChain);

  const fromFn = vi.fn().mockImplementation(() => ({
    select: vi.fn().mockReturnValue(selectChain),
    update: updateFn,
    insert: insertFn,
  }));

  return { from: fromFn } as unknown as SupabaseClient;
}

const VALID_URL = 'https://images.example.com/product/abc123.jpg';
const VALID_URL_2 = 'https://images.example.com/product/xyz789.jpg';

function baseOpts(
  overrides: Partial<UpsertPhotoOptions> = {},
): UpsertPhotoOptions {
  return {
    admin: makeAdmin({ existingRow: null }),
    identifierKind: 'upc',
    identifierValue: '012345678905',
    photoUrl: VALID_URL,
    source: 'staff_photo',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('upsertPhotoToCatalog', () => {
  describe('1. New UPC with no existing catalog row → INSERT seed row', () => {
    it('returns ok:true', async () => {
      const admin = makeAdmin({ existingRow: null });
      const result = await upsertPhotoToCatalog({
        ...baseOpts(),
        admin,
      });
      expect(result.ok).toBe(true);
    });

    it('calls insert with image_urls=[url], source=[source], confidence=medium', async () => {
      const insertFn = vi.fn().mockResolvedValue({ error: null });
      const maybeSingleFn = vi.fn().mockResolvedValue({ data: null, error: null });
      const eqSelectFn = vi.fn().mockReturnValue({ maybeSingle: maybeSingleFn });
      const fromFn = vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({ eq: eqSelectFn }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: insertFn,
      }));
      const admin = { from: fromFn } as unknown as SupabaseClient;

      await upsertPhotoToCatalog({
        admin,
        identifierKind: 'upc',
        identifierValue: '012345678905',
        photoUrl: VALID_URL,
        source: 'enrichment_amazon',
      });

      expect(insertFn).toHaveBeenCalledOnce();
      const insertArg = insertFn.mock.calls[0]![0] as Record<string, unknown>;
      expect(insertArg['upc']).toBe('012345678905');
      expect(insertArg['image_urls']).toEqual([VALID_URL]);
      expect(insertArg['sources']).toEqual(['enrichment_amazon']);
      expect(insertArg['confidence']).toBe('medium');
    });
  });

  describe('2. Existing row with empty image_urls → UPDATE: append URL + source', () => {
    it('returns ok:true and calls update (not insert)', async () => {
      const updateFn = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });
      const maybeSingleFn = vi.fn().mockResolvedValue({
        data: { upc: '012345678905', image_urls: [], sources: [] },
        error: null,
      });
      const fromFn = vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ maybeSingle: maybeSingleFn }),
        }),
        update: updateFn,
        insert: vi.fn(),
      }));
      const admin = { from: fromFn } as unknown as SupabaseClient;

      const result = await upsertPhotoToCatalog({
        admin,
        identifierKind: 'upc',
        identifierValue: '012345678905',
        photoUrl: VALID_URL,
        source: 'staff_photo',
      });

      expect(result.ok).toBe(true);
      expect(updateFn).toHaveBeenCalledOnce();
      const updateArg = updateFn.mock.calls[0]![0] as Record<string, unknown>;
      expect(updateArg['image_urls']).toEqual([VALID_URL]);
      expect(updateArg['sources']).toEqual(['staff_photo']);
    });
  });

  describe('3. URL already in image_urls → no-op, returns already_in_catalog', () => {
    it('returns ok:false, reason=already_in_catalog', async () => {
      const maybeSingleFn = vi.fn().mockResolvedValue({
        data: { upc: '012345678905', image_urls: [VALID_URL], sources: ['staff_photo'] },
        error: null,
      });
      const updateFn = vi.fn();
      const insertFn = vi.fn();
      const fromFn = vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ maybeSingle: maybeSingleFn }),
        }),
        update: updateFn,
        insert: insertFn,
      }));
      const admin = { from: fromFn } as unknown as SupabaseClient;

      const result = await upsertPhotoToCatalog({
        admin,
        identifierKind: 'upc',
        identifierValue: '012345678905',
        photoUrl: VALID_URL,
        source: 'staff_photo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('already_in_catalog');
      // Must not attempt any write.
      expect(updateFn).not.toHaveBeenCalled();
      expect(insertFn).not.toHaveBeenCalled();
    });
  });

  describe('4. ASIN kind → catalog row keyed as asin:B0XXXXXXXX', () => {
    it('uses asin:B0XXXXXXXX as the catalog key, not the bare ASIN', async () => {
      const maybeSingleFn = vi.fn().mockResolvedValue({ data: null, error: null });
      const eqSelectFn = vi.fn().mockReturnValue({ maybeSingle: maybeSingleFn });
      const insertFn = vi.fn().mockResolvedValue({ error: null });
      const fromFn = vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({ eq: eqSelectFn }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        insert: insertFn,
      }));
      const admin = { from: fromFn } as unknown as SupabaseClient;

      await upsertPhotoToCatalog({
        admin,
        identifierKind: 'asin',
        identifierValue: 'B0CXYZ12345',
        photoUrl: VALID_URL,
        source: 'enrichment_amazon',
      });

      // The .eq() on SELECT must use 'asin:B0CXYZ12345', not 'B0CXYZ12345'.
      expect(eqSelectFn).toHaveBeenCalledWith('upc', 'asin:B0CXYZ12345');

      // The INSERT row must also use the prefixed key.
      const insertArg = insertFn.mock.calls[0]![0] as Record<string, unknown>;
      expect(insertArg['upc']).toBe('asin:B0CXYZ12345');
    });
  });

  describe('5. Invalid URL → returns invalid_url, no DB write', () => {
    const invalidUrls = [
      'NA',
      '',
      'ftp://example.com/photo.jpg',
      'n/a',
      'null',
      '/relative/path.jpg',
      'none',
    ];
    for (const bad of invalidUrls) {
      it(`"${bad || '(empty)'}" → invalid_url`, async () => {
        const updateFn = vi.fn();
        const insertFn = vi.fn();
        const fromFn = vi.fn().mockImplementation(() => ({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
          update: updateFn,
          insert: insertFn,
        }));
        const admin = { from: fromFn } as unknown as SupabaseClient;

        const result = await upsertPhotoToCatalog({
          admin,
          identifierKind: 'upc',
          identifierValue: '012345678905',
          photoUrl: bad,
          source: 'staff_photo',
        });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('invalid_url');
        // Bail before any DB call — from() must not have been called.
        expect(fromFn).not.toHaveBeenCalled();
      });
    }
  });

  describe('6. Multiple sources → array-deduped on update', () => {
    it('does not duplicate a source that already exists on the row', async () => {
      const updateFn = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });
      const maybeSingleFn = vi.fn().mockResolvedValue({
        data: {
          upc: '012345678905',
          image_urls: [VALID_URL_2],
          sources: ['staff_photo', 'enrichment_amazon'],
        },
        error: null,
      });
      const fromFn = vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ maybeSingle: maybeSingleFn }),
        }),
        update: updateFn,
        insert: vi.fn(),
      }));
      const admin = { from: fromFn } as unknown as SupabaseClient;

      await upsertPhotoToCatalog({
        admin,
        identifierKind: 'upc',
        identifierValue: '012345678905',
        // New URL — not already in image_urls — so we proceed to update.
        photoUrl: VALID_URL,
        // Same source already in existing.sources — must not duplicate.
        source: 'staff_photo',
      });

      expect(updateFn).toHaveBeenCalledOnce();
      const updateArg = updateFn.mock.calls[0]![0] as Record<string, unknown>;
      const sources = updateArg['sources'] as string[];
      // Expect exactly two unique sources, no duplication.
      expect(sources).toEqual(
        expect.arrayContaining(['staff_photo', 'enrichment_amazon']),
      );
      expect(sources.length).toBe(2);
    });
  });
});
