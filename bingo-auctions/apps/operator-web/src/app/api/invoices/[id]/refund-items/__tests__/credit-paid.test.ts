// 2026-10-27, TEA3828564: a $2.52 invoice paid fully with account credit was
// refused as no_payment_to_refund, because the route demanded a Square
// payment before working out that the whole refund is store credit. Fake ids
// and amounts only.
//
// Covers:
//   - credit-paid invoice: refunds as store credit, no Square call, line stamped
//   - offline-paid invoice (no card, no credit): refused as no_card_payment,
//     nothing moves
//   - card-paid invoice: still refunds through Square

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

type Call = { table: string; op: string; payload?: unknown };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  invoice: { value: {} as Record<string, unknown> },
  refundPayment: vi.fn(async () => ({ refundId: 'sq-ref-1', status: 'PENDING' })),
  returnRefundCredit: vi.fn(async () => {}),
}));

function builder(table: string) {
  let op = 'select';
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['eq', 'in', 'is', 'limit', 'select']) b[m] = self;
  for (const m of ['update', 'insert', 'delete']) {
    b[m] = (payload?: unknown) => {
      op = m;
      h.calls.push({ table, op: m, payload });
      return b;
    };
  }
  b.maybeSingle = async () => {
    if (table === 'operator_users') return { data: { operator_id: 'op-1', role: 'admin' }, error: null };
    if (table === 'invoices') return { data: h.invoice.value, error: null };
    return { data: null, error: null };
  };
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
    let data: unknown = op === 'select' ? [] : null;
    if (op === 'select' && table === 'invoice_lots') {
      data = [{ lot_id: '00000000-0000-4000-8000-000000000001', refunded_at: null, forfeited_at: null, lots: { lot_code: 'BIN-1' } }];
    }
    return Promise.resolve({ data, error: null, count: 0 }).then(res, rej);
  };
  return b;
}

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (t: string) => builder(t),
  }),
}));
vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    rpc: async (fn: string) => ({ data: fn === 'claim_refund' ? true : null, error: null }),
    from: (t: string) => builder(t),
  }),
}));
vi.mock('@/lib/operator-can', () => ({ operatorCan: async () => true }));
vi.mock('@/lib/require-aal2', () => ({ requireAAL2ForAdmin: async () => ({ ok: true }) }));
vi.mock('@/lib/square', () => ({
  refundPayment: h.refundPayment,
  SquareApiError: class SquareApiError extends Error {
    errors: { code?: string; detail?: string }[] = [];
  },
}));
vi.mock('@/lib/referral-credits', () => ({ returnRefundCredit: h.returnRefundCredit }));

import { POST } from '../route';

const LOT = '00000000-0000-4000-8000-000000000001';
const call = () =>
  POST(
    new Request('https://bingoauctions.com/api/invoices/inv-1/refund-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ lot_id: LOT, amount_cents: 252 }], sub_reason: 'other' }),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: 'inv-1' }) },
  );

const base = {
  id: 'inv-1',
  status: 'paid',
  operator_id: 'op-1',
  bidder_id: 'b-1',
  total_cents: 252,
  tax_cents: 22,
  refunded_cash_cents: 0,
  refunded_credit_cents: 0,
  refunded_tax_cents: 0,
  refunded_at: null,
};

describe('refund-items: who paid decides how it goes back', () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.refundPayment.mockClear();
    h.returnRefundCredit.mockClear();
  });

  it('paid fully with credit: store credit back, no Square call, line stamped', async () => {
    h.invoice.value = { ...base, credit_applied_cents: 252, square_payment_id: null };
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cash_cents: 0, credit_cents: 252 });
    expect(h.refundPayment).not.toHaveBeenCalled();
    expect(h.returnRefundCredit).toHaveBeenCalledWith(expect.anything(), { bidderId: 'b-1', invoiceId: 'inv-1', amountCents: 252 });
    expect(h.calls).toContainEqual({ table: 'invoices', op: 'update', payload: expect.objectContaining({ refunded_credit_cents: 252, status: 'refunded' }) });
    expect(h.calls.some((c) => c.table === 'invoice_lots' && c.op === 'update')).toBe(true);
  });

  it('paid offline (no card, no credit): refused as no_card_payment, nothing moves', async () => {
    h.invoice.value = { ...base, credit_applied_cents: 0, square_payment_id: null };
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_card_payment', cash_cents: 252 });
    expect(h.refundPayment).not.toHaveBeenCalled();
    expect(h.returnRefundCredit).not.toHaveBeenCalled();
    expect(h.calls.filter((c) => c.op !== 'select')).toEqual([]);
  });

  it('paid by card: still refunds through Square', async () => {
    h.invoice.value = { ...base, credit_applied_cents: 0, square_payment_id: 'sq-pay-1' };
    const res = await call();
    expect(res.status).toBe(200);
    expect(h.refundPayment).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'sq-pay-1', amountCents: 252 }));
  });
});
