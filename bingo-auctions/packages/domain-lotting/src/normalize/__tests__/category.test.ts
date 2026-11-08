// __tests__/category.test.ts
//
// Vitest tests for resolveCategoryAlias() and resolveSingleCategory() from category.ts.
//
// Both functions take a SupabaseClient and make RPC calls — we stub the client
// inline (no external mock library) by building a minimal object that matches
// the shape used inside category.ts.
//
// Run via:
//
//   npm test --workspace=@auction-platform/domain-lotting

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveCategoryAlias, resolveSingleCategory } from '../category';

// ---------------------------------------------------------------------------
// Minimal Supabase stub helpers
// ---------------------------------------------------------------------------

type RpcResult<T> = { data: T | null; error: { message: string } | null };

function makeStub(result: RpcResult<unknown>): SupabaseClient {
  return {
    rpc: (_fn: string, _args: unknown) => Promise.resolve(result),
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// resolveCategoryAlias
// ---------------------------------------------------------------------------

describe('resolveCategoryAlias — empty input short-circuit', () => {
  it('empty array → [] without calling rpc', async () => {
    // Stub that would fail if rpc were called
    const stub = {
      rpc: () => {
        throw new Error('rpc should not be called for empty input');
      },
    } as unknown as SupabaseClient;
    const result = await resolveCategoryAlias(stub, []);
    expect(result).toEqual([]);
  });
});

describe('resolveCategoryAlias — successful RPC response', () => {
  it('maps 1-based input_idx to 0-based output array', async () => {
    const rpcData = [
      { input_idx: 1, category_id: 'uuid-tools' },
      { input_idx: 2, category_id: 'uuid-kitchen' },
      { input_idx: 3, category_id: null },
    ];
    const stub = makeStub({ data: rpcData, error: null });
    const result = await resolveCategoryAlias(stub, ['Power Tools', 'Kitchen', 'Unknown']);
    expect(result).toEqual(['uuid-tools', 'uuid-kitchen', null]);
  });

  it('preserves null category_id for unmatched rows', async () => {
    const rpcData = [{ input_idx: 1, category_id: null }];
    const stub = makeStub({ data: rpcData, error: null });
    const result = await resolveCategoryAlias(stub, ['Gibberish Category']);
    expect(result).toEqual([null]);
  });

  it('out-of-range input_idx is safely ignored (no crash)', async () => {
    // input_idx=99 with only 1 input value — should not throw, should leave output[0] null
    const rpcData = [{ input_idx: 99, category_id: 'uuid-x' }];
    const stub = makeStub({ data: rpcData, error: null });
    const result = await resolveCategoryAlias(stub, ['Only One']);
    expect(result).toEqual([null]);
  });

  it('result length matches input length', async () => {
    const inputs = ['A', 'B', 'C', 'D', 'E'];
    const rpcData = inputs.map((_, i) => ({ input_idx: i + 1, category_id: `uuid-${i}` }));
    const stub = makeStub({ data: rpcData, error: null });
    const result = await resolveCategoryAlias(stub, inputs);
    expect(result).toHaveLength(inputs.length);
  });
});

describe('resolveCategoryAlias — RPC error handling', () => {
  it('RPC error → returns all-null array (graceful degradation)', async () => {
    const stub = makeStub({ data: null, error: { message: 'connection refused' } });
    const result = await resolveCategoryAlias(stub, ['Power Tools', 'Kitchen']);
    expect(result).toEqual([null, null]);
  });

  it('null data with no error → returns all-null array', async () => {
    const stub = makeStub({ data: null, error: null });
    const result = await resolveCategoryAlias(stub, ['Power Tools']);
    expect(result).toEqual([null]);
  });

  it('empty data array → returns all-null array (no matches)', async () => {
    const stub = makeStub({ data: [], error: null });
    const result = await resolveCategoryAlias(stub, ['Power Tools', 'Kitchen']);
    expect(result).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------
// resolveSingleCategory (convenience wrapper)
// ---------------------------------------------------------------------------

describe('resolveSingleCategory', () => {
  it('returns the resolved uuid on match', async () => {
    const rpcData = [{ input_idx: 1, category_id: 'uuid-tools' }];
    const stub = makeStub({ data: rpcData, error: null });
    const result = await resolveSingleCategory(stub, 'Power Tools');
    expect(result).toBe('uuid-tools');
  });

  it('returns null when no match', async () => {
    const rpcData = [{ input_idx: 1, category_id: null }];
    const stub = makeStub({ data: rpcData, error: null });
    const result = await resolveSingleCategory(stub, 'Unknown');
    expect(result).toBeNull();
  });

  it('returns null on RPC error', async () => {
    const stub = makeStub({ data: null, error: { message: 'db error' } });
    const result = await resolveSingleCategory(stub, 'Power Tools');
    expect(result).toBeNull();
  });

  it('returns null on empty input (empty array → resolveCategoryAlias → [])', async () => {
    // resolveCategoryAlias([]) returns [] immediately, result[0] is undefined → null
    const stub = {
      rpc: () => {
        throw new Error('should not be called');
      },
    } as unknown as SupabaseClient;
    // We can't call resolveSingleCategory with truly empty input since it wraps
    // a single string; test the null-coalescing with a no-match response.
    const rpcData: unknown[] = [];
    const stubEmpty = makeStub({ data: rpcData, error: null });
    const result = await resolveSingleCategory(stubEmpty, 'AnyValue');
    expect(result).toBeNull();
  });
});
