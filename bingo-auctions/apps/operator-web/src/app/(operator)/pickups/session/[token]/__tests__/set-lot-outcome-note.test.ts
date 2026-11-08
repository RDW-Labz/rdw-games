// #849: the counter's Missing confirmation keeps the note optional, persists a
// chosen quick reason, and still enforces staff + session ownership.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const TOKEN = 'session-token';
const PICKUP = '00000000-0000-0000-0000-0000000000a1';
const LOT = '00000000-0000-0000-0000-0000000000b1';
const USER = 'user-1';

const state = vi.hoisted(() => ({
  signedIn: true,
  staff: true,
  sessionBidder: 'bidder-1' as string | null,
  pickupBidder: 'bidder-1' as string | null,
  upserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  deletes: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/pickup-session', () => ({ loadSessionContents: vi.fn() }));
vi.mock('../../../actions', () => ({ markPickup: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: state.signedIn ? { id: USER } : null } }) },
    from: (table: string) => {
      if (table !== 'operator_users') throw new Error(`unexpected table ${table}`);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: state.staff ? { user_id: USER } : null });
      return b;
    },
  }),
}));
vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'pickup_sessions') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: state.sessionBidder ? { bidder_id: state.sessionBidder } : null,
              }),
            }),
          }),
        };
      }
      if (table === 'pickups') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: state.pickupBidder
                  ? { id: PICKUP, invoices: { bidder_id: state.pickupBidder } }
                  : null,
              }),
            }),
          }),
        };
      }
      if (table === 'pickup_lot_outcomes') {
        return {
          upsert: async (payload: Record<string, unknown>) => {
            state.upserts.push({ table, payload });
            return { error: null };
          },
          delete: () => {
            const removed: Record<string, unknown> = {};
            const b = {
              eq: (column: string, value: unknown) => {
                removed[column] = value;
                return b;
              },
              then: (resolve: (v: { error: null }) => void) => {
                state.deletes.push(removed);
                resolve({ error: null });
              },
            };
            return b;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { setLotOutcome } from '../actions';

beforeEach(() => {
  state.signedIn = true;
  state.staff = true;
  state.sessionBidder = 'bidder-1';
  state.pickupBidder = 'bidder-1';
  state.upserts = [];
  state.deletes = [];
});

describe('setLotOutcome missing note (#849)', () => {
  it('accepts a blank note with no mandatory-reason gate', async () => {
    expect(
      await setLotOutcome({ token: TOKEN, pickupId: PICKUP, lotId: LOT, outcome: 'missing' }),
    ).toEqual({ ok: true });
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]?.payload).toMatchObject({ outcome: 'missing', note: null });
  });

  it('persists a quick reason / typed note when supplied', async () => {
    await setLotOutcome({
      token: TOKEN,
      pickupId: PICKUP,
      lotId: LOT,
      outcome: 'missing',
      note: '  Not in the bin — checked twice ',
    });
    expect(state.upserts[0]?.payload.note).toBe('Not in the bin — checked twice');
  });

  it('accepts a composed note at exactly 500 and rejects 501', async () => {
    expect(
      (
        await setLotOutcome({
          token: TOKEN,
          pickupId: PICKUP,
          lotId: LOT,
          outcome: 'missing',
          note: 'x'.repeat(500),
        })
      ).ok,
    ).toBe(true);
    expect(state.upserts[0]?.payload.note).toHaveLength(500);

    state.upserts = [];
    expect(
      await setLotOutcome({
        token: TOKEN,
        pickupId: PICKUP,
        lotId: LOT,
        outcome: 'missing',
        note: 'x'.repeat(501),
      }),
    ).toEqual({ ok: false, error: 'Invalid input' });
    expect(state.upserts).toEqual([]);
  });

  it('rejects an over-long note without writing', async () => {
    expect(
      await setLotOutcome({
        token: TOKEN,
        pickupId: PICKUP,
        lotId: LOT,
        outcome: 'missing',
        note: 'x'.repeat(501),
      }),
    ).toEqual({ ok: false, error: 'Invalid input' });
    expect(state.upserts).toEqual([]);
  });

  it('clears the outcome row and any note when unset', async () => {
    expect(
      (await setLotOutcome({ token: TOKEN, pickupId: PICKUP, lotId: LOT, outcome: null })).ok,
    ).toBe(true);
    expect(state.deletes).toEqual([{ pickup_id: PICKUP, lot_id: LOT }]);
    expect(state.upserts).toEqual([]);
  });

  it('keeps the staff and ownership gates', async () => {
    state.staff = false;
    expect(
      await setLotOutcome({ token: TOKEN, pickupId: PICKUP, lotId: LOT, outcome: 'missing' }),
    ).toEqual({ ok: false, error: 'Not operator staff' });

    state.staff = true;
    state.pickupBidder = 'someone-else';
    expect(
      await setLotOutcome({ token: TOKEN, pickupId: PICKUP, lotId: LOT, outcome: 'missing' }),
    ).toEqual({ ok: false, error: 'Pickup does not belong to this session' });
    expect(state.upserts).toEqual([]);
  });
});
