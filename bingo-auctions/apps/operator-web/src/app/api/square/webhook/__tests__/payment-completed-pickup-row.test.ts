// The payment.updated COMPLETED backstop must create the invoice's pickups row
// (ensure_pickup_row) for every still-owed invoice it flips to paid — the same
// as mark-paid and auto-charge-drain. Without it the paid invoice never showed
// up in staff's QR pickup scan or the bidder's Pickup Pass (real case: auto-
// charge parked an invoice in payment_failed_grace, the webhook flipped it to
// paid 2s later, and no pickups row was ever made).
//
// An invoice that was canceled / unpaid_no_show / payment_failed_relisted before
// the payment landed is dead: its lots may already be relisted to someone else.
// It must NOT be marked paid (that kept the customer's money for something
// canceled, 2026-09-28). The payment is refunded in full, once, the invoice
// keeps its status, and a human is told.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { Constants } from '@auction-platform/shared/database.types';

const ALL_INVOICE_STATUSES: readonly string[] = Constants.public.Enums.invoice_status;

type Row = {
  id: string;
  bidder_id: string;
  operator_id: string;
  total_cents: number;
  fulfillment_method: string | null;
  status: string;
  square_refund_id: string | null;
  square_payment_id?: string | null;
  refunded_cash_cents?: number | null;
  refunded_at?: string | null;
};

// vi.hoisted: vi.mock factories are lifted above normal const declarations.
const { db, rpc, insert, audit, refundPayment, getPayment, sendOpsAlert } = vi.hoisted(() => ({
  db: { rows: [] as Row[], updates: 0 },
  rpc: vi.fn(),
  insert: vi.fn(),
  audit: vi.fn(),
  refundPayment: vi.fn(),
  getPayment: vi.fn(),
  sendOpsAlert: vi.fn(),
}));

// invoices: a lazy PostgREST builder. Filters narrow the row set; awaiting it
// (directly, or through .select()/.maybeSingle()) applies a pending update to
// the matched rows and returns them, like a conditional UPDATE … RETURNING or
// a plain SELECT. Only the filters the route uses are modelled.
function invoicesBuilder() {
  let patch: Partial<Row> | null = null;
  let statuses: string[] | null = null;
  let id: string | null = null;
  let paymentId: string | null = null;
  let refundIsNull = false;
  const run = () => {
    const hit = db.rows.filter(
      (r) =>
        (statuses === null || statuses.includes(r.status)) &&
        (id === null || r.id === id) &&
        (paymentId === null || r.square_payment_id === paymentId) &&
        (!refundIsNull || r.square_refund_id === null),
    );
    if (patch) for (const r of hit) Object.assign(r, patch);
    return hit.map((r) => ({ ...r }));
  };
  const b = {
    update: (p: Partial<Row>) => {
      patch = p;
      db.updates++;
      return b;
    },
    select: () => b,
    or: () => b,
    is: (col: string) => {
      if (col === 'square_refund_id') refundIsNull = true;
      return b;
    },
    // Kept so a regression back to the old single .not(...) update still runs.
    not: (_col: string, _op: string, list: string) => {
      const excluded = list.replace(/[()]/g, '').split(',');
      statuses = ALL_INVOICE_STATUSES.filter((s) => !excluded.includes(s));
      return b;
    },
    in: (_col: string, list: string[]) => {
      statuses = list;
      return b;
    },
    eq: (col: string, value: string) => {
      if (col === 'status') statuses = [value];
      else if (col === 'id') id = value;
      else if (col === 'square_payment_id') paymentId = value;
      return b;
    },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: run(), error: null }).then(res, rej),
  };
  return b;
}

vi.mock('@/lib/square', () => ({
  verifySquareWebhook: vi.fn(async () => true),
  refundPayment,
  getPayment,
  idempotencyKey45: async (s: string) => `k45:${s}`,
}));
vi.mock('@/lib/ops-alert', () => ({ sendOpsAlert }));
vi.mock('@/lib/invoice-lot-code', () => ({ primaryLotDisplayCode: vi.fn(async () => 'A-1') }));
vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    rpc,
    from: (table: string) =>
      table === 'notifications_outbox'
        ? { insert }
        : table === 'operator_audit_log'
          ? { insert: audit }
          : invoicesBuilder(),
  }),
}));

import { POST } from '../route';

function post(event: unknown): NextRequest {
  return new Request('https://bingoauctions.com/api/square/webhook', {
    method: 'POST',
    headers: { 'x-square-hmacsha256-signature': 'sig' },
    body: JSON.stringify(event),
  }) as unknown as NextRequest;
}

function completedPayment(amount: number | null = 1200): NextRequest {
  return post({
    type: 'payment.updated',
    data: {
      object: {
        payment: {
          id: 'sq_pay_1',
          status: 'COMPLETED',
          reference_id: 'inv-1',
          ...(amount === null ? {} : { amount_money: { amount, currency: 'USD' } }),
        },
      },
    },
  });
}

function invoice(status: string, fulfillment_method: string | null = 'pickup'): Row {
  return {
    id: 'inv-1',
    bidder_id: 'b-1',
    operator_id: 'op-1',
    total_cents: 1200,
    fulfillment_method,
    status,
    square_refund_id: null,
  };
}

const DEAD = ['canceled', 'unpaid_no_show', 'payment_failed_relisted'];

describe('square webhook — payment COMPLETED backstop and the pickup row', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    db.rows = [];
    db.updates = 0;
    rpc.mockReset().mockResolvedValue({ data: 'pickup-1', error: null });
    insert.mockReset().mockResolvedValue({ data: null, error: null });
    audit.mockReset().mockResolvedValue({ data: null, error: null });
    refundPayment.mockReset().mockResolvedValue({ refundId: 'rf_late_1', status: 'PENDING' });
    getPayment.mockReset().mockResolvedValue(null);
    sendOpsAlert.mockReset().mockResolvedValue(true);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('pending → paid: calls ensure_pickup_row once for that invoice', async () => {
    db.rows = [invoice('pending')];
    const res = await POST(completedPayment());

    expect(res.status).toBe(200);
    expect(db.rows[0]?.status).toBe('paid');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('ensure_pickup_row', { p_invoice_id: 'inv-1' });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it('payment_failed_grace → paid: calls ensure_pickup_row once (the original customer bug)', async () => {
    db.rows = [invoice('payment_failed_grace')];
    const res = await POST(completedPayment());

    expect(res.status).toBe(200);
    expect(db.rows[0]?.status).toBe('paid');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('ensure_pickup_row', { p_invoice_id: 'inv-1' });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it('treats a null fulfillment_method as pickup, like mark-paid does', async () => {
    db.rows = [invoice('pending', null)];
    await POST(completedPayment());

    expect(rpc).toHaveBeenCalledWith('ensure_pickup_row', { p_invoice_id: 'inv-1' });
  });

  it.each(DEAD)(
    '%s: NOT marked paid — the payment is refunded in full, recorded, audited, and a human told',
    async (priorStatus) => {
      db.rows = [invoice(priorStatus)];
      const res = await POST(completedPayment(1200));

      expect(res.status).toBe(200);
      expect(refundPayment).toHaveBeenCalledTimes(1);
      expect(refundPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: 'sq_pay_1',
          amountCents: 1200,
          idempotencyKey: 'k45:late:sq_pay_1',
        }),
      );
      expect(db.rows[0]).toMatchObject({
        status: priorStatus,
        square_payment_id: 'sq_pay_1',
        square_refund_id: 'rf_late_1',
        refunded_cash_cents: 1200,
      });
      expect(db.rows[0]?.refunded_at).toEqual(expect.any(String));
      // No "payment received" receipt, no pickup row.
      expect(insert).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action_type: 'invoice.late_payment_refunded', target_id: 'inv-1', actor_user_id: null }),
      );
      expect(sendOpsAlert).toHaveBeenCalledWith(
        expect.anything(),
        'late_payment_refunded',
        expect.any(String),
        expect.stringContaining('sq_pay_1'),
      );
    },
  );

  it('refunds the amount Square actually approved when the event carries it', async () => {
    db.rows = [invoice('canceled')];
    await POST(
      post({
        type: 'payment.updated',
        data: {
          object: {
            payment: {
              id: 'sq_pay_1',
              status: 'COMPLETED',
              reference_id: 'inv-1',
              amount_money: { amount: 1200 },
              approved_money: { amount: 950 },
            },
          },
        },
      }),
    );
    expect(refundPayment).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 950 }));
  });

  it('falls back to GetPayment for the amount when the event has none', async () => {
    getPayment.mockResolvedValue({ paymentId: 'sq_pay_1', status: 'COMPLETED', approvedCents: 777 });
    db.rows = [invoice('payment_failed_relisted')];
    await POST(completedPayment(null));

    expect(getPayment).toHaveBeenCalledWith('sq_pay_1');
    expect(refundPayment).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 777 }));
  });

  it('no amount anywhere: no refund guessed, invoice untouched, human paged by SMS', async () => {
    getPayment.mockResolvedValue(null);
    db.rows = [invoice('canceled')];
    const res = await POST(completedPayment(null));

    expect(res.status).toBe(200);
    expect(refundPayment).not.toHaveBeenCalled();
    expect(db.rows[0]).toMatchObject({ status: 'canceled', square_refund_id: null });
    expect(sendOpsAlert).toHaveBeenCalledWith(
      expect.anything(),
      'late_payment_refund_failed',
      expect.any(String),
      expect.stringContaining('amount unknown'),
      { sms: true },
    );
  });

  it('refund call fails: still 200 to Square, invoice untouched, human paged by SMS', async () => {
    refundPayment.mockRejectedValue(new Error('square 503'));
    db.rows = [invoice('payment_failed_relisted')];
    const res = await POST(completedPayment());

    expect(res.status).toBe(200);
    expect(db.rows[0]).toMatchObject({ status: 'payment_failed_relisted', square_refund_id: null });
    expect(insert).not.toHaveBeenCalled();
    expect(sendOpsAlert).toHaveBeenCalledWith(
      expect.anything(),
      'late_payment_refund_failed',
      expect.any(String),
      expect.stringContaining('square 503'),
      { sms: true },
    );
  });

  it('a redelivered event after the refund makes no second refund', async () => {
    db.rows = [invoice('canceled')];
    await POST(completedPayment());
    await POST(completedPayment());

    expect(refundPayment).toHaveBeenCalledTimes(1);
    expect(db.rows[0]?.status).toBe('canceled');
  });

  it('refund.updated COMPLETED on a dead invoice records the refund but keeps its status', async () => {
    db.rows = [{ ...invoice('payment_failed_relisted'), square_payment_id: 'sq_pay_1' }];
    await POST(
      post({
        type: 'refund.updated',
        data: {
          object: {
            refund: { id: 'rf_late_1', status: 'COMPLETED', payment_id: 'sq_pay_1', amount_money: { amount: 1200 } },
          },
        },
      }),
    );
    expect(db.rows[0]).toMatchObject({ status: 'payment_failed_relisted', square_refund_id: 'rf_late_1' });
  });

  it('refund.updated COMPLETED on a paid invoice still sets refunded / partially_refunded', async () => {
    db.rows = [{ ...invoice('paid'), square_payment_id: 'sq_pay_1' }];
    await POST(
      post({
        type: 'refund.updated',
        data: { object: { refund: { id: 'rf_2', status: 'COMPLETED', payment_id: 'sq_pay_1', amount_money: { amount: 500 } } } },
      }),
    );
    expect(db.rows[0]?.status).toBe('partially_refunded');
  });

  it.each(['paid', 'refunded', 'partially_refunded'])(
    'already %s: nothing flipped, no ensure_pickup_row, no receipt, no refund',
    async (status) => {
      db.rows = [invoice(status)];
      const res = await POST(completedPayment());

      expect(res.status).toBe(200);
      expect(db.rows[0]?.status).toBe(status);
      expect(rpc).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(refundPayment).not.toHaveBeenCalled();
    },
  );

  it('an invoice carrying a refund id is never flipped or refunded again', async () => {
    db.rows = [{ ...invoice('pending'), square_refund_id: 'rf_1' }, { ...invoice('canceled'), id: 'inv-2', square_refund_id: 'rf_0' }];
    await POST(completedPayment());

    expect(db.rows[0]?.status).toBe('pending');
    expect(rpc).not.toHaveBeenCalled();
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it('skips ship invoices (they go to the shipping queue), matching mark-paid', async () => {
    db.rows = [invoice('pending', 'ship')];
    await POST(completedPayment());

    expect(rpc).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('still returns 200 and enqueues the receipt when ensure_pickup_row returns an error', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'invoice_has_no_warehouse_lots: inv-1' },
    });
    db.rows = [invoice('pending')];
    const res = await POST(completedPayment());

    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[square/webhook] ensure_pickup_row failed for invoice',
      'inv-1',
      'invoice_has_no_warehouse_lots: inv-1',
    );
  });

  it('still returns 200 when ensure_pickup_row throws', async () => {
    rpc.mockRejectedValue(new Error('network down'));
    db.rows = [invoice('pending')];
    const res = await POST(completedPayment());

    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[square/webhook] ensure_pickup_row failed for invoice',
      'inv-1',
      'network down',
    );
  });

  // Guards the split against drift: every invoice_status the old single
  // .not('status','in','(paid,refunded,partially_refunded)') update touched is
  // handled exactly once — flipped to paid, or refunded — and nothing else is.
  // A new enum value fails here until someone decides where it belongs.
  it('handles exactly the statuses the old single update did, each exactly once', async () => {
    const OLD_EXCLUDED = ['paid', 'refunded', 'partially_refunded'];
    const PICKUP = ['pending', 'payment_failed_grace'];
    expect([...PICKUP, ...DEAD].sort()).toEqual(
      ALL_INVOICE_STATUSES.filter((s) => !OLD_EXCLUDED.includes(s)).sort(),
    );

    db.rows = ALL_INVOICE_STATUSES.map((status, i) => ({
      ...invoice(status),
      id: `inv-${status}`,
      bidder_id: `b-${i}`,
    }));
    await POST(completedPayment());

    const receipted = insert.mock.calls.map(
      (c) => (c[0] as { payload: { invoice_id: string } }).payload.invoice_id,
    );
    expect(receipted.sort()).toEqual(PICKUP.map((s) => `inv-${s}`).sort());
    expect(rpc.mock.calls.map((c) => (c[1] as { p_invoice_id: string }).p_invoice_id).sort()).toEqual(
      PICKUP.map((s) => `inv-${s}`).sort(),
    );
    // Every dead status is matched by this one payment: ambiguous, so none is
    // refunded or flipped, and a person is paged.
    expect(refundPayment).not.toHaveBeenCalled();
    for (const s of DEAD) {
      expect(db.rows.find((r) => r.id === `inv-${s}`)).toMatchObject({ status: s, square_refund_id: null });
    }
    expect(sendOpsAlert).toHaveBeenCalledWith(
      expect.anything(),
      'late_payment_refund_failed',
      expect.stringContaining('several'),
      expect.any(String),
      { sms: true },
    );
    for (const s of OLD_EXCLUDED) {
      expect(db.rows.find((r) => r.id === `inv-${s}`)?.status).toBe(s);
    }
  });
});
