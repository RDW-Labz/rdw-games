// A completion is only reported as successful when the DATABASE says the
// pickup moved to 'completed'. 0487's BEFORE trigger keeps a visit
// 'checked_in' when a line undone from that visit is still owed — the UPDATE
// succeeds, so the action must read the persisted status back instead of
// trusting "no SQL error".

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  invoiceStatus: 'paid' as string,
  persistedStatus: 'completed' as string,
  updates: [] as Array<Record<string, unknown>>,
}));

function fakeClient() {
  return {
    from(table: string) {
      if (table === 'invoices') {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.single = async () => ({ data: { status: state.invoiceStatus }, error: null });
        return b;
      }
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.single = async () => ({
        data: {
          id: '00000000-0000-0000-0000-0000000000a1',
          invoice_id: '00000000-0000-0000-0000-0000000000b1',
        },
        error: null,
      });
      b.update = (payload: Record<string, unknown>) => {
        state.updates.push(payload);
        return b;
      };
      b.maybeSingle = async () => ({ data: { status: state.persistedStatus }, error: null });
      return b;
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ getSupabaseServer: async () => fakeClient() }));

import { markPickup } from '../actions';

beforeEach(() => {
  state.invoiceStatus = 'paid';
  state.persistedStatus = 'completed';
  state.updates = [];
});

describe('markPickup completion result', () => {
  it('reports success when the pickup really persisted as completed', async () => {
    const r = await markPickup({
      pickupId: '00000000-0000-0000-0000-0000000000a1',
      status: 'completed',
    });
    expect(r).toEqual({ ok: true });
    expect(state.updates[0]).toMatchObject({ status: 'completed' });
  });

  it('reports failure when 0487 keeps an undone line owed', async () => {
    state.persistedStatus = 'checked_in';
    const r = await markPickup({
      pickupId: '00000000-0000-0000-0000-0000000000a1',
      status: 'completed',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toMatch(/kept checked in/i);
    expect(r.error).toMatch(/still owed/i);
  });
});
