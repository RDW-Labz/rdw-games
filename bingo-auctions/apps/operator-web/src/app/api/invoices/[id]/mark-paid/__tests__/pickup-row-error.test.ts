// Staff mark-paid: when ensure_pickup_row RETURNS an error (supabase-js does
// not throw — e.g. P0001 invoice_has_no_warehouse_lots) it used to be dropped
// silently. It must now be logged, and the mark-paid result must be unchanged:
// invoice marked paid, offline settlement recorded, 200 { ok: true }.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

type Call = { table: string; op: string; payload?: unknown };

// vi.hoisted: vi.mock factories are lifted above normal const declarations.
const { calls, rpc, recordChargeAttempt, invoiceRow } = vi.hoisted(() => ({
  calls: [] as Call[],
  rpc: vi.fn(),
  recordChargeAttempt: vi.fn(async () => {}),
  invoiceRow: {
    value: {} as Record<string, unknown>,
  },
}));

// Minimal PostgREST builder: filters return the builder; awaiting resolves by
// table + first operation. Records every write for assertions.
function builder(table: string) {
  let op = 'select';
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['eq', 'in', 'is', 'limit']) b[m] = self;
  for (const m of ['update', 'insert', 'delete']) {
    b[m] = (payload?: unknown) => {
      op = m;
      calls.push({ table, op: m, payload });
      return b;
    };
  }
  b.select = () => b;
  b.maybeSingle = async () => ({
    data: table === 'invoices' ? invoiceRow.value : null,
    error: null,
  });
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(op === 'select' ? { data: [], error: null } : { data: null, error: null }).then(
      res,
      rej,
    );
  return b;
}

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { operator_id: 'op-1', role: 'admin' } }) }),
      }),
    }),
  }),
}));
vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({ rpc, from: (table: string) => builder(table) }),
}));
vi.mock('@/lib/require-aal2', () => ({ requireAAL2ForAdmin: async () => ({ ok: true }) }));
vi.mock('@/lib/charge-attempts', () => ({ recordChargeAttempt }));
vi.mock('@/lib/invoice-lot-code', () => ({ primaryLotDisplayCode: async () => 'A-1' }));

import { POST } from '../route';

const PICKUP_ERROR = { message: 'invoice_has_no_warehouse_lots: inv-1', code: 'P0001' };

function callMarkPaid() {
  return POST(
    new Request('https://bingoauctions.com/api/invoices/inv-1/mark-paid', {
      method: 'POST',
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: 'inv-1' }) },
  );
}

describe('mark-paid — ensure_pickup_row returned error', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    calls.length = 0;
    invoiceRow.value = {
      id: 'inv-1',
      status: 'payment_failed_grace',
      operator_id: 'op-1',
      auction_id: 'auc-1',
      fulfillment_method: 'pickup',
      bidder_id: 'b-1',
      total_cents: 2500,
    };
    rpc.mockReset().mockResolvedValue({ data: null, error: PICKUP_ERROR });
    recordChargeAttempt.mockClear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('logs the failure and still marks the invoice paid', async () => {
    const res = await callMarkPaid();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('ensure_pickup_row', { p_invoice_id: 'inv-1' });
    expect(warn).toHaveBeenCalledWith(
      '[mark-paid] ensure_pickup_row failed for invoice',
      'inv-1',
      PICKUP_ERROR.message,
    );
    expect(
      calls.some(
        (c) =>
          c.table === 'invoices' &&
          c.op === 'update' &&
          (c.payload as { status?: string }).status === 'paid',
      ),
    ).toBe(true);
    expect(recordChargeAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceId: 'inv-1', outcome: 'settled_offline' }),
    );
    expect(calls.some((c) => c.table === 'auto_charge_jobs' && c.op === 'delete')).toBe(true);
  });

  it('does not create a pickup row for a ship invoice', async () => {
    invoiceRow.value = { ...invoiceRow.value, fulfillment_method: 'ship' };
    const res = await callMarkPaid();

    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });
});
