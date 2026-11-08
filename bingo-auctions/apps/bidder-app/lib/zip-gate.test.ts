// requireZip must never hold a bid on our own failure, and must stop looking
// once it knows the bidder has a ZIP.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ uid: 'u1' as string | null, row: null as unknown, reads: 0 }));

vi.mock('@auction-platform/supabase-client', () => ({
  supabase: {},
  getCurrentUserId: async () => state.uid,
}));
vi.mock('./postal-code', () => ({
  fetchZipPromptState: async () => {
    state.reads++;
    return state.row;
  },
  saveMyZip: async () => 'saved',
}));

beforeEach(() => {
  vi.resetModules();
  state.uid = 'u1';
  state.row = null;
  state.reads = 0;
});

async function load() {
  return await import('./zip-gate');
}

describe('requireZip', () => {
  it('not signed in: lets the action run', async () => {
    state.uid = null;
    const { requireZip } = await load();
    expect(await requireZip()).toBe(true);
  });

  it('cannot read her row (offline): lets the bid run', async () => {
    state.row = null;
    const { requireZip } = await load();
    expect(await requireZip()).toBe(true);
  });

  it('has a ZIP: runs, and the next bid does not look it up again', async () => {
    state.row = { postal_code: '72601' };
    const { requireZip } = await load();
    expect(await requireZip()).toBe(true);
    expect(await requireZip()).toBe(true);
    expect(state.reads).toBe(1);
  });

  it('confirmed empty ZIP: opens the sheet and waits; saving resolves it', async () => {
    state.row = { postal_code: null };
    const m = await load();
    const opened: boolean[] = [];
    m.registerZipGateListener((o) => opened.push(o));
    const p = m.requireZip();
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toEqual([true]);
    expect(await m.saveAndResolveZipGate('72601')).toBe('saved');
    expect(await p).toBe(true);
    state.row = { postal_code: null };
    expect(await m.requireZip()).toBe(true); // remembered after the save
  });

  it('backing out of the sheet cancels the action', async () => {
    state.row = { postal_code: null };
    const m = await load();
    m.registerZipGateListener(() => {});
    const p = m.requireZip();
    await new Promise((r) => setTimeout(r, 0));
    m.resolveZipGate(false);
    expect(await p).toBe(false);
  });
});
