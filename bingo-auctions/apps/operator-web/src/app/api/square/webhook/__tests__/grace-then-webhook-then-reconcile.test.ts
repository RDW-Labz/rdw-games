// The original bug's sequence, end to end at the mock level:
//   1. auto-charge thought the charge failed and parked the invoice in
//      payment_failed_grace;
//   2. two seconds later Square's payment.updated COMPLETED reached the webhook,
//      which flipped grace → paid and (now) created the pickups row;
//   3. an auto-charge-drain tick holding a stale snapshot (still grace) runs the
//      reconcile-before-charge path, finds the COMPLETED payment, marks paid and
//      calls ensure_pickup_row again.
// Both calls must target the same invoice and nothing may throw. (That the
// second call creates no second row is the RPC's ON CONFLICT (invoice_id) DO
// NOTHING — proven against real Postgres separately.)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

type Invoice = Record<string, unknown> & { id: string; status: string };

// vi.hoisted: vi.mock factories are lifted above normal const declarations.
const { db, rpc, findCompletedPaymentForInvoice } = vi.hoisted(() => ({
  db: {
    invoice: {} as Invoice,
    // What the drain's batch SELECT returns — a snapshot taken before step 2.
    staleSnapshot: {} as Invoice,
    pickupIds: new Map<string, string>(),
  },
  rpc: vi.fn(),
  findCompletedPaymentForInvoice: vi.fn(),
}));

const SELECT_ROWS: Record<string, () => unknown[]> = {
  auto_charge_jobs: () => [{ invoice_id: 'inv-1', bidder_id: 'b-1', attempt_count: 1 }],
  invoices: () => [db.staleSnapshot],
  bidders: () => [{ id: 'b-1', square_customer_id: 'cust-1', default_payment_method_id: 'ccof:1' }],
};

// One PostgREST stand-in shared by the webhook and the drain. For invoices,
// update(...).…in|eq('status', …).select() acts as a conditional UPDATE …
// RETURNING on the single row; a plain awaited update applies unconditionally
// (the drain's `.eq('id', …)` writes).
function builder(table: string) {
  let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  let patch: Record<string, unknown> = {};
  let statuses: string[] | null = null;
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['or', 'is', 'neq', 'lte', 'order', 'limit', 'returns', 'not']) b[m] = self;
  b.in = (col: string, list: string[]) => {
    if (col === 'status') statuses = list;
    return b;
  };
  b.eq = (col: string, value: string) => {
    if (col === 'status') statuses = [value];
    return b;
  };
  b.update = (p: Record<string, unknown>) => {
    op = 'update';
    patch = p;
    return b;
  };
  b.insert = () => {
    op = 'insert';
    return b;
  };
  b.delete = () => {
    op = 'delete';
    return b;
  };
  b.select = () => {
    if (op !== 'update') return b;
    // Conditional UPDATE … RETURNING (webhook).
    const hit = statuses === null || statuses.includes(db.invoice.status);
    if (hit) Object.assign(db.invoice, patch);
    return Promise.resolve({ data: hit ? [{ ...db.invoice }] : [], error: null });
  };
  b.maybeSingle = async () => ({ data: null, error: null });
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
    if (op === 'update' && table === 'invoices') Object.assign(db.invoice, patch);
    const result =
      op === 'select'
        ? {
            // A status filter narrows invoice reads too (the webhook's
            // dead-invoice lookup), not only conditional updates.
            data: (SELECT_ROWS[table]?.() ?? []).filter(
              (r) =>
                table !== 'invoices' || statuses === null || statuses.includes(String((r as { status?: string }).status)),
            ),
            error: null,
          }
        : { data: null, error: null };
    return Promise.resolve(result).then(res, rej);
  };
  return b;
}

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({ rpc, from: (table: string) => builder(table) }),
}));
vi.mock('@/lib/ops-alert', () => ({ sendOpsAlert: vi.fn(async () => true) }));
vi.mock('@/lib/payments-mode', () => ({ isPaymentsDisabled: async () => false }));
vi.mock('@/lib/referral-credits', () => ({ applyCreditToInvoice: vi.fn(async () => 0) }));
vi.mock('@/lib/invoice-lot-code', () => ({ primaryLotDisplayCode: vi.fn(async () => 'A-1') }));
vi.mock('@/lib/charge-attempts', () => ({
  recordChargeAttempt: vi.fn(async () => {}),
  persistBidderCardFacts: vi.fn(async () => {}),
  squareErrorParts: () => ({ code: null, detail: null }),
}));
vi.mock('@/lib/square', () => ({
  verifySquareWebhook: vi.fn(async () => true),
  chargeCardOnFile: vi.fn(async () => {
    throw new Error('must not charge again — reconcile should have found the payment');
  }),
  getPayment: vi.fn(),
  refundPayment: vi.fn(async () => {
    throw new Error('must not refund — this invoice is owed, not dead');
  }),
  findCompletedPaymentForInvoice,
  idempotencyKey45: vi.fn(async () => 'idem-key'),
  SquareApiError: class SquareApiError extends Error {
    errors: Array<{ code?: string }> = [];
  },
}));

import { POST } from '../route';
import { runAutoChargeDrain } from '@/lib/cron/auto-charge-drain';

function completedPayment(): NextRequest {
  return new Request('https://bingoauctions.com/api/square/webhook', {
    method: 'POST',
    headers: { 'x-square-hmacsha256-signature': 'sig' },
    body: JSON.stringify({
      type: 'payment.updated',
      data: { object: { payment: { id: 'sq_pay_1', status: 'COMPLETED', reference_id: 'inv-1' } } },
    }),
  }) as unknown as NextRequest;
}

describe("original bug: grace → webhook paid → drain reconcile", () => {
  beforeEach(() => {
    db.invoice = {
      id: 'inv-1',
      bidder_id: 'b-1',
      total_cents: 1200,
      fulfillment_method: 'pickup',
      status: 'payment_failed_grace',
      square_refund_id: null,
    };
    db.staleSnapshot = {
      id: 'inv-1',
      status: 'payment_failed_grace',
      total_cents: 1200,
      operator_id: 'op-1',
      auction_id: 'auc-1',
      fulfillment_method: 'pickup',
      square_payment_id: null,
      created_at: '2026-09-25T00:00:00Z',
      last_charge_attempt: null,
      operators: { auto_charge_grace_hours: 48 },
    };
    db.pickupIds.clear();
    // Idempotent like the real RPC: one pickup id per invoice, however often called.
    rpc.mockReset().mockImplementation(async (_fn: string, args: { p_invoice_id: string }) => {
      if (!db.pickupIds.has(args.p_invoice_id)) {
        db.pickupIds.set(args.p_invoice_id, `pickup-${db.pickupIds.size + 1}`);
      }
      return { data: db.pickupIds.get(args.p_invoice_id), error: null };
    });
    findCompletedPaymentForInvoice.mockReset().mockResolvedValue({
      status: 'COMPLETED',
      paymentId: 'sq_pay_1',
      approvedCents: 1200,
      cardFacts: null,
    });
  });

  it('both paths ensure the same invoice’s pickup row and nothing throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Step 2: the webhook lands on the grace invoice.
    const res = await POST(completedPayment());
    expect(res.status).toBe(200);
    expect(db.invoice.status).toBe('paid');
    expect(rpc).toHaveBeenCalledTimes(1);

    // Step 3: a drain tick with the stale grace snapshot reconciles.
    const result = await runAutoChargeDrain();
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, skipped: 0, deferred: 0 });

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls).toEqual([
      ['ensure_pickup_row', { p_invoice_id: 'inv-1' }],
      ['ensure_pickup_row', { p_invoice_id: 'inv-1' }],
    ]);
    expect(db.pickupIds.size).toBe(1);
    expect(db.invoice.status).toBe('paid');
    expect(db.invoice.square_payment_id).toBe('sq_pay_1');
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('ensure_pickup_row failed'),
      expect.anything(),
      expect.anything(),
    );
    warn.mockRestore();
  });
});
