// The console New lot form never created a lot in prod (2026-09-30): first the
// validator rejected the database's '+00:00' close time (#413), then the insert
// failed on lots.lot_code NOT NULL. Both are covered here: the insert carries a
// lot_code minted by next_lot_code, and a '+00:00' closeAt gets through.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const AUCTION_ID = '369e6b1a-dfdb-44db-8351-22346af967ae';
const WAREHOUSE_ID = 'ce9646af-55b5-412b-bff1-b86a5cdd8b54';
const OPERATOR_ID = '0d2a1f2e-1111-4111-8111-111111111111';
const ENDS_AT = '2026-10-07T18:51:00+00:00'; // exactly as PostgREST returns timestamptz

const { rpc, insert, state } = vi.hoisted(() => ({
  rpc: vi.fn(),
  insert: vi.fn(),
  state: { auctionStatus: 'draft' },
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    rpc,
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            if (table === 'operator_users') return { data: { operator_id: OPERATOR_ID } };
            if (table === 'auctions') {
              return {
                data: {
                  id: AUCTION_ID,
                  status: state.auctionStatus,
                  operator_id: OPERATOR_ID,
                  warehouse_id: WAREHOUSE_ID,
                  ends_at: ENDS_AT,
                  last_lot_ends_at: null,
                },
              };
            }
            return { data: null };
          },
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        insert(row);
        return { select: () => ({ single: async () => ({ data: { id: 'lot-1' }, error: null }) }) };
      },
    }),
  }),
}));

import { createLot } from '../actions';

const input = {
  auctionId: AUCTION_ID,
  warehouseId: WAREHOUSE_ID,
  title: 'Staff keep test',
  condition: 'good' as const,
  startingBidCents: 100,
  closeAt: ENDS_AT,
  photoUrls: [],
};

beforeEach(() => {
  rpc.mockReset();
  insert.mockReset();
  state.auctionStatus = 'draft';
  rpc.mockImplementation(async (name: string) => {
    if (name === 'reserve_next_lot_number') return { data: 7, error: null };
    if (name === 'next_lot_code') return { data: 'BIN-029600', error: null };
    return { data: null, error: null };
  });
});

describe('createLot', () => {
  it('accepts the database close time and inserts a minted lot_code', async () => {
    const result = await createLot(input);
    expect(result).toEqual({ ok: true, lotId: 'lot-1', operatorId: OPERATOR_ID });
    expect(rpc).toHaveBeenCalledWith('next_lot_code', { p_operator_id: OPERATOR_ID });
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.lot_code).toBe('BIN-029600');
    expect(row.lot_number).toBe(7);
    expect(row.close_at).toBe(ENDS_AT);
    expect(row.status).toBe('draft');
    expect(row.source).toBe('manual');
  });

  it('does not insert when no lot code can be minted', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'reserve_next_lot_number') return { data: 7, error: null };
      if (name === 'next_lot_code') return { data: null, error: { message: 'next_lot_code: caller is not staff of the operator' } };
      return { data: null, error: null };
    });
    const result = await createLot(input);
    expect(result).toEqual({ ok: false, error: 'next_lot_code: caller is not staff of the operator' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('still refuses a live auction (unchanged until #408)', async () => {
    state.auctionStatus = 'live';
    const result = await createLot(input);
    expect(result.ok).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
});
