// completeSession must not report a completion (or close the session) when a
// per-pickup completion was silently downgraded by 0487's guard.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  markResult: { ok: true } as { ok: boolean; error?: string },
  sessionUpdates: [] as Array<Record<string, unknown>>,
}));

function userClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
    },
    from(table: string) {
      if (table !== 'operator_users') throw new Error(`unexpected user table ${table}`);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: { user_id: 'user-1' } });
      return b;
    },
  };
}

function adminClient() {
  return {
    from(table: string) {
      if (table !== 'pickup_sessions') throw new Error(`unexpected admin table ${table}`);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({
        data: { id: 'session-1', bidder_id: 'bidder-1', status: 'open' },
      });
      b.update = (payload: Record<string, unknown>) => {
        state.sessionUpdates.push(payload);
        return b;
      };
      return b;
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ getSupabaseServer: async () => userClient() }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => adminClient() }));
vi.mock('@/lib/pickup-session', () => ({
  loadSessionContents: async () => ({
    invoices: [{ id: 'invoice-1', pickupId: 'pickup-1', status: 'paid' }],
    items: [],
  }),
}));
vi.mock('../../../actions', () => ({
  markPickup: async () => state.markResult,
}));

import { completeSession } from '../actions';

beforeEach(() => {
  state.markResult = { ok: true };
  state.sessionUpdates = [];
});

describe('completeSession completion result', () => {
  it('closes the session only when every pickup actually completed', async () => {
    const r = await completeSession('token-1');
    expect(r).toMatchObject({ ok: true, completed: 1, errors: [] });
    expect(state.sessionUpdates).toHaveLength(1);
    expect(state.sessionUpdates[0]).toMatchObject({ status: 'completed' });
  });

  it('stays open and reports the error when a pickup was kept checked_in', async () => {
    state.markResult = {
      ok: false,
      error: 'Pickup kept checked in: an item undone from this visit is still owed.',
    };
    const r = await completeSession('token-1');
    expect(r.ok).toBe(false);
    expect(r.completed).toBe(0);
    expect(r.errors.join(' ')).toMatch(/kept checked in/i);
    expect(state.sessionUpdates).toHaveLength(0);
  });
});
