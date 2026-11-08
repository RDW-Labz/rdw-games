// Auto-charge is how most invoices get paid. When ensure_pickup_row RETURNS an
// error (supabase-js does not throw — e.g. P0001 invoice_has_no_warehouse_lots)
// the drain used to drop it silently, leaving a paid invoice invisible at the
// pickup counter with no log. It must now log the failure, and the payment
// outcome must be exactly what it was: invoice marked paid, charge recorded,
// receipt queued, job deleted, counted as succeeded.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Call = { table: string; op: string; payload?: unknown };

// vi.hoisted: vi.mock factories are lifted above normal const declarations.
const { calls, rpc, chargeCardOnFile, recordChargeAttempt, paymentsOff } = vi.hoisted(() => ({
  calls: [] as Call[],
  rpc: vi.fn(),
  chargeCardOnFile: vi.fn(),
  recordChargeAttempt: vi.fn(async () => {}),
  paymentsOff: { value: false },
}));

const INVOICE = {
  id: 'inv-1',
  status: 'pending',
  total_cents: 2500,
  operator_id: 'op-1',
  auction_id: 'auc-1',
  fulfillment_method: 'pickup',
  square_payment_id: null,
  created_at: '2026-09-25T00:00:00Z',
  last_charge_attempt: null,
  operators: { auto_charge_grace_hours: 48 },
};

// What each table's SELECT resolves to. Writes resolve to { error: null }.
const SELECT_ROWS: Record<string, unknown[]> = {
  auto_charge_jobs: [{ invoice_id: 'inv-1', bidder_id: 'b-1', attempt_count: 0 }],
  invoices: [INVOICE],
  bidders: [{ id: 'b-1', square_customer_id: 'cust-1', default_payment_method_id: 'ccof:1' }],
  invoice_lots: [],
  bidder_subscriptions: [],
  lots: [], // auction settled — no live/scheduled lots
  auctions: [],
};

// Minimal PostgREST builder: every filter returns the builder, and awaiting it
// resolves by table + first operation. Records every write for assertions.
function builder(table: string) {
  let op = 'select';
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['eq', 'neq', 'in', 'is', 'lte', 'or', 'not', 'order', 'limit', 'returns']) {
    b[m] = self;
  }
  for (const m of ['update', 'insert', 'delete']) {
    b[m] = (payload?: unknown) => {
      op = m;
      calls.push({ table, op: m, payload });
      return b;
    };
  }
  b.select = () => b;
  b.maybeSingle = async () => ({ data: SELECT_ROWS[table]?.[0] ?? null, error: null });
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(
      op === 'select' ? { data: SELECT_ROWS[table] ?? [], error: null } : { data: [], error: null },
    ).then(res, rej);
  return b;
}

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({ rpc, from: (table: string) => builder(table) }),
}));
vi.mock('@/lib/payments-mode', () => ({ isPaymentsDisabled: async () => paymentsOff.value }));
vi.mock('@/lib/referral-credits', () => ({ applyCreditToInvoice: vi.fn(async () => 0) }));
vi.mock('@/lib/charge-attempts', () => ({
  recordChargeAttempt,
  persistBidderCardFacts: vi.fn(async () => {}),
  squareErrorParts: () => ({ code: null, detail: null }),
}));
vi.mock('@/lib/square', () => ({
  chargeCardOnFile,
  getPayment: vi.fn(),
  findCompletedPaymentForInvoice: vi.fn(),
  idempotencyKey45: vi.fn(async () => 'idem-key'),
  SquareApiError: class SquareApiError extends Error {
    errors: Array<{ code?: string }> = [];
  },
}));

import { runAutoChargeDrain } from '../auto-charge-drain';

const PICKUP_ERROR = { message: 'invoice_has_no_warehouse_lots: inv-1', code: 'P0001' };

function paidUpdates() {
  return calls.filter(
    (c) => c.table === 'invoices' && c.op === 'update' && (c.payload as { status?: string })?.status === 'paid',
  );
}

describe('auto-charge drain — ensure_pickup_row returned error', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    calls.length = 0;
    paymentsOff.value = false;
    rpc.mockReset().mockResolvedValue({ data: null, error: PICKUP_ERROR });
    chargeCardOnFile.mockReset().mockResolvedValue({
      status: 'COMPLETED',
      paymentId: 'sq_pay_1',
      cardFacts: null,
    });
    recordChargeAttempt.mockClear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('card charge path: logs the failure and still records the payment as succeeded', async () => {
    const result = await runAutoChargeDrain();

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, skipped: 0, deferred: 0 });
    expect(rpc).toHaveBeenCalledWith('ensure_pickup_row', { p_invoice_id: 'inv-1' });
    expect(warn).toHaveBeenCalledWith(
      '[auto-charge-drain:charge] ensure_pickup_row failed for invoice',
      'inv-1',
      PICKUP_ERROR.message,
    );
    // Payment result unchanged by the pickup failure.
    const paid = paidUpdates();
    expect(paid).toHaveLength(1);
    expect((paid[0]?.payload as { square_payment_id?: string }).square_payment_id).toBe(
      'sq_pay_1',
    );
    expect(recordChargeAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceId: 'inv-1', outcome: 'succeeded' }),
    );
    expect(calls.some((c) => c.table === 'notifications_outbox' && c.op === 'insert')).toBe(true);
    expect(calls.some((c) => c.table === 'auto_charge_jobs' && c.op === 'delete')).toBe(true);
    // Never flipped to grace.
    expect(
      calls.some(
        (c) =>
          c.table === 'invoices' &&
          (c.payload as { status?: string })?.status === 'payment_failed_grace',
      ),
    ).toBe(false);
  });

  it('offline (payments disabled) path: logs the failure and still marks paid', async () => {
    paymentsOff.value = true;
    const result = await runAutoChargeDrain();

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, skipped: 0, deferred: 0 });
    expect(chargeCardOnFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[auto-charge-drain:offline] ensure_pickup_row failed for invoice',
      'inv-1',
      PICKUP_ERROR.message,
    );
    expect(paidUpdates()).toHaveLength(1);
  });

  it('is quiet when ensure_pickup_row succeeds', async () => {
    rpc.mockResolvedValue({ data: 'pickup-1', error: null });
    const result = await runAutoChargeDrain();

    expect(result.succeeded).toBe(1);
    expect(rpc).toHaveBeenCalledWith('ensure_pickup_row', { p_invoice_id: 'inv-1' });
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('ensure_pickup_row failed'),
      expect.anything(),
      expect.anything(),
    );
  });
});
