import { beforeEach, describe, expect, it, vi } from 'vitest';

// #770 RED TEAM HIGH: a failed probe must not let a lower-priority probe (or a
// stale tombstone) confirm a different lot. These tests drive the real
// `resolveLotScan` against a scripted query queue.

const mock = vi.hoisted(() => ({
  queue: [] as Array<{ data: unknown; error: { message: string } | null }>,
  calls: [] as string[],
}));

vi.mock('@auction-platform/supabase-client', () => {
  function makeBuilder() {
    const builder: Record<string, unknown> = {};
    const chain = (name: string) => (arg?: unknown) => {
      if (name === 'or') mock.calls.push(String(arg));
      return builder;
    };
    for (const name of ['select', 'or', 'is', 'limit', 'abortSignal', 'eq']) {
      builder[name] = chain(name);
    }
    const next = () => mock.queue.shift() ?? { data: [], error: null };
    builder.maybeSingle = async () => next();
    builder.then = (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(next()).then(resolve, reject);
    return builder;
  }
  return { supabase: { from: () => makeBuilder() } };
});

import { resolveLotScan } from './resolve-lot-scan';

const LIVE = {
  id: '11111111-1111-4111-8111-111111111111',
  lot_code: 'BIN-000001',
  sticker_code: 'BIN:TEA4858852',
  display_code: 'BIN-000001',
  status: 'in_inventory',
  created_at: '2026-11-01T00:00:00Z',
  warehouse_id: 'wh-1',
};

const RETIRED_PARENT = {
  id: '22222222-2222-4222-8222-222222222222',
  lot_code: 'TEA4858852',
  sticker_code: null,
  display_code: 'TEA4858852',
  status: 'relisted',
  created_at: '2026-01-01T00:00:00Z',
  warehouse_id: null,
};

beforeEach(() => {
  mock.queue = [];
  mock.calls = [];
});

describe('resolveLotScan failClosed', () => {
  it('never falls through to a sticker row when the identity probe failed', async () => {
    mock.queue.push({ data: null, error: { message: 'identity probe down' } });
    mock.queue.push({ data: [LIVE], error: null });

    await expect(
      resolveLotScan('3f2504e0-4f89-11d3-9a0c-0305e82c3301', '', { failClosed: true }),
    ).rejects.toThrow('identity probe down');

    // The second (sticker) probe must never run and its row must never win.
    expect(mock.calls).toHaveLength(1);
    expect(mock.queue).toHaveLength(1);
  });

  it('never confirms a tombstone when the lineage walk failed', async () => {
    mock.queue.push({ data: [RETIRED_PARENT], error: null });
    mock.queue.push({ data: null, error: { message: 'lineage probe down' } });

    await expect(resolveLotScan('TEA4858852', '', { failClosed: true })).rejects.toThrow(
      'lineage probe down',
    );
  });

  it('still resolves a clean canonical hit', async () => {
    mock.queue.push({ data: [LIVE], error: null });

    const result = await resolveLotScan('3f2504e0-4f89-11d3-9a0c-0305e82c3301', '', {
      failClosed: true,
    });

    expect(result?.lot.id).toBe(LIVE.id);
    expect(mock.calls).toHaveLength(1);
  });

  it('keeps the lenient behaviour for callers that did not opt in', async () => {
    mock.queue.push({ data: null, error: { message: 'identity probe down' } });
    mock.queue.push({ data: [LIVE], error: null });

    const result = await resolveLotScan('3f2504e0-4f89-11d3-9a0c-0305e82c3301', '');

    expect(result?.lot.id).toBe(LIVE.id);
  });
});
