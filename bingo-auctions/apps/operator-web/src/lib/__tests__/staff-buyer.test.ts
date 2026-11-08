// loadBuyerForStaff: buyer name only for staff of the invoice's operator.
import { describe, expect, it, vi } from 'vitest';

// The module is marked server-only (never in a browser bundle); the marker
// throws outside a React Server Component build, so stub it here.
vi.mock('server-only', () => ({}));
import { loadBuyerForStaff } from '../staff-buyer';

function client(rows: Record<string, unknown>, user: { id: string } | null = { id: 'u1' }) {
  const from = vi.fn((table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
    return b;
  });
  return { auth: { getUser: async () => ({ data: { user } }) }, from } as never;
}

describe('loadBuyerForStaff', () => {
  const buyer = { display_name: 'Madden Inc', email: 'm@example.test', bidder_number: 42 };
  it('staff of the same operator: buyer fields', async () => {
    const viewer = client({ operator_users: { operator_id: 'op1' } });
    const admin = client({ invoices: { operator_id: 'op1', bidder_id: 'b1' }, bidders: buyer });
    expect(await loadBuyerForStaff(viewer, admin, 'inv')).toEqual(buyer);
  });
  it('staff of another operator: nothing', async () => {
    const viewer = client({ operator_users: { operator_id: 'op2' } });
    const admin = client({ invoices: { operator_id: 'op1', bidder_id: 'b1' }, bidders: buyer });
    expect(await loadBuyerForStaff(viewer, admin, 'inv')).toBeNull();
  });
  it('not staff, or not signed in: nothing', async () => {
    const admin = client({ invoices: { operator_id: 'op1', bidder_id: 'b1' }, bidders: buyer });
    expect(await loadBuyerForStaff(client({}), admin, 'inv')).toBeNull();
    expect(await loadBuyerForStaff(client({}, null), admin, 'inv')).toBeNull();
  });
});
