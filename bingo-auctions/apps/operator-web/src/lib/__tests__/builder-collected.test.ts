import { describe, it, expect, vi } from 'vitest';
import { loadCollectedCarryoverIds } from '../builder-collected';

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
const client = (rpc: Rpc) => ({ rpc }) as never;

describe('loadCollectedCarryoverIds (mig 0447)', () => {
  it('asks for the auction warehouse and returns the ids as a set', async () => {
    const rpc = vi.fn<Rpc>(async () => ({ data: ['lot-1', 'lot-2', 'lot-1'], error: null }));
    const s = await loadCollectedCarryoverIds(client(rpc), 'wh-harrison');
    expect(rpc).toHaveBeenCalledWith('builder_collected_lot_ids', { p_warehouse_id: 'wh-harrison' });
    expect([...s].sort()).toEqual(['lot-1', 'lot-2']);
  });

  it('passes null for an auction with no warehouse', async () => {
    const rpc = vi.fn<Rpc>(async () => ({ data: [], error: null }));
    await loadCollectedCarryoverIds(client(rpc), null);
    expect(rpc).toHaveBeenCalledWith('builder_collected_lot_ids', { p_warehouse_id: null });
  });

  it('hides nothing when the function is missing (console deployed before 0447)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rpc = vi.fn<Rpc>(async () => ({ data: null, error: { message: 'Could not find the function public.builder_collected_lot_ids' } }));
    expect((await loadCollectedCarryoverIds(client(rpc), 'wh')).size).toBe(0);
    warn.mockRestore();
  });

  it('hides nothing when the call throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rpc = vi.fn<Rpc>(async () => {
      throw new Error('network');
    });
    expect((await loadCollectedCarryoverIds(client(rpc), 'wh')).size).toBe(0);
    warn.mockRestore();
  });
});
