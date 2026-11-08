import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  server: [] as string[],
  calls: [] as { name: string; params: Record<string, unknown> }[],
  failAppend: false,
  failRemove: false,
  failReorder: false,
}));

vi.mock('@auction-platform/supabase-client', () => ({
  supabase: {
    rpc: async (name: string, params: Record<string, unknown>) => {
      state.calls.push({ name, params });
      if (name === 'remove_lot_photo_urls') {
        if (state.failRemove) return { data: null, error: { message: 'remove offline' } };
        const urls = params['p_urls'] as string[];
        state.server = state.server.filter((url) => !urls.includes(url));
        return { data: { ok: true, reason: 'removed' }, error: null };
      }
      if (name === 'append_lot_photo_url') {
        if (state.failAppend) return { data: { ok: false, reason: 'append_failed' }, error: null };
        const url = params['p_url'] as string;
        if (!state.server.includes(url)) state.server.push(url);
        return { data: { ok: true, reason: 'appended' }, error: null };
      }
      if (name === 'reorder_lot_photo_urls') {
        if (state.failReorder)
          return { data: { ok: false, reason: 'reorder_failed' }, error: null };
        const order = params['p_urls'] as string[];
        const ordered = order.filter((url) => state.server.includes(url));
        const extra = state.server.filter((url) => !ordered.includes(url));
        state.server = [...ordered, ...extra];
        return { data: { ok: true, reason: 'reordered' }, error: null };
      }
      return { data: null, error: { message: 'unknown rpc' } };
    },
  },
}));

import { applyLotPhotoDelta, planPhotoDelta } from './lot-photo-delta';

describe('planPhotoDelta', () => {
  it('reports only new and removed URLs', () => {
    expect(planPhotoDelta(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
  });

  it('is empty when nothing changed', () => {
    expect(planPhotoDelta(['a', 'b'], ['a', 'b'])).toEqual({ added: [], removed: [] });
  });

  it('reports a reorder when the same photos move', () => {
    expect(planPhotoDelta(['a', 'b'], ['b', 'a'])).toEqual({
      added: [],
      removed: [],
      reorder: ['b', 'a'],
    });
  });

  it('does not reorder for an add-only change', () => {
    expect(planPhotoDelta(['a', 'b'], ['a', 'b', 'c'])).toEqual({ added: ['c'], removed: [] });
  });

  it('reorders when a newly added photo becomes the hero before Save', () => {
    expect(planPhotoDelta(['a', 'b'], ['c', 'b', 'a'])).toEqual({
      added: ['c'],
      removed: [],
      reorder: ['c', 'b', 'a'],
    });
  });

  it('reorders an add+remove while keeping the requested order', () => {
    expect(planPhotoDelta(['a', 'b', 'c'], ['d', 'c'])).toEqual({
      added: ['d'],
      removed: ['a', 'b'],
      reorder: ['d', 'c'],
    });
  });
});

describe('applyLotPhotoDelta', () => {
  beforeEach(() => {
    state.server = [];
    state.calls = [];
    state.failAppend = false;
    state.failRemove = false;
    state.failReorder = false;
  });

  it('keeps a photo another device appended while this screen was open', async () => {
    const base = ['seed'];
    const desired = ['seed', 'mine'];
    // Another device attached after this screen loaded its snapshot.
    state.server = ['seed', 'other-device'];

    const result = await applyLotPhotoDelta('lot-1', 'op-1', base, desired);

    expect(result).toEqual({ ok: true });
    expect(state.server).toEqual(['seed', 'other-device', 'mine']);
    // A delta, never a full-array replacement.
    expect(state.calls.map((call) => call.name)).toEqual(['append_lot_photo_url']);
  });

  it('removes only the named URL and keeps a concurrent append', async () => {
    const base = ['seed', 'gone'];
    const desired = ['seed'];
    state.server = ['seed', 'gone', 'other-device'];

    const result = await applyLotPhotoDelta('lot-1', 'op-1', base, desired);

    expect(result).toEqual({ ok: true });
    expect(state.server).toEqual(['seed', 'other-device']);
    expect(state.calls.map((call) => call.name)).toEqual(['remove_lot_photo_urls']);
  });

  it('sends nothing when the list did not change', async () => {
    const result = await applyLotPhotoDelta('lot-1', 'op-1', ['a'], ['a']);
    expect(result).toEqual({ ok: true });
    expect(state.calls).toHaveLength(0);
  });

  it('reports a failed append instead of claiming the photo was attached', async () => {
    state.failAppend = true;
    const result = await applyLotPhotoDelta('lot-1', 'op-1', [], ['new']);
    expect(result.ok).toBe(false);
  });

  it('reports a failed removal', async () => {
    state.failRemove = true;
    const result = await applyLotPhotoDelta('lot-1', 'op-1', ['old'], []);
    expect(result.ok).toBe(false);
  });

  it('persists a hero reorder while keeping a concurrent append', async () => {
    state.server = ['a', 'b', 'other-device'];
    const result = await applyLotPhotoDelta('lot-1', 'op-1', ['a', 'b'], ['b', 'a']);
    expect(result).toEqual({ ok: true });
    expect(state.server).toEqual(['b', 'a', 'other-device']);
    expect(state.calls.map((call) => call.name)).toEqual(['reorder_lot_photo_urls']);
  });

  it('puts a new photo first when it was made hero before Save', async () => {
    state.server = ['a', 'b', 'other-device'];
    const result = await applyLotPhotoDelta('lot-1', 'op-1', ['a', 'b'], ['new', 'b', 'a']);
    expect(result).toEqual({ ok: true });
    // Added, then ordered first; the concurrent URL still survives.
    expect(state.server).toEqual(['new', 'b', 'a', 'other-device']);
    expect(state.calls.map((call) => call.name)).toEqual([
      'append_lot_photo_url',
      'reorder_lot_photo_urls',
    ]);
  });

  it('reports a failed reorder instead of claiming the hero changed', async () => {
    state.failReorder = true;
    state.server = ['a', 'b'];
    const result = await applyLotPhotoDelta('lot-1', 'op-1', ['a', 'b'], ['b', 'a']);
    expect(result.ok).toBe(false);
  });
});
