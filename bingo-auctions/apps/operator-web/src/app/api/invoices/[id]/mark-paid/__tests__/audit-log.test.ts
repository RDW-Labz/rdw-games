// Mark-paid (offline) must write an operator_audit_log row so who marked an
// invoice paid, and why, is recorded (4 prod invoices had no actor trace).
//
// Covers:
//   - the audit row has the right actor, target, before/after state and reason
//   - a missing reason/method still works (back-compat: console button posts
//     no body today)
//   - an unauthorized caller writes nothing (neither invoices.update, the
//     charge_attempts insert, nor operator_audit_log)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

type Call = { table: string; op: string; payload?: unknown };

const { calls, rpc, recordChargeAttempt, invoiceRow, staffRow, sentryCapture, fromOverride } =
  vi.hoisted(() => ({
    calls: [] as Call[],
    rpc: vi.fn(async () => ({ data: null, error: null })),
    recordChargeAttempt: vi.fn(async () => {}),
    invoiceRow: {
      value: {} as Record<string, unknown>,
    },
    staffRow: {
      value: { operator_id: 'op-1', role: 'admin' } as Record<string, unknown> | null,
    },
    sentryCapture: vi.fn(),
    // Lets one test swap in a per-table override (e.g. a failing insert)
    // without needing to spy on an object the route creates for itself —
    // getSupabaseAdmin() returns a fresh object on every call.
    fromOverride: { current: null as null | ((table: string) => Record<string, unknown>) },
  }));

// Minimal PostgREST builder: filters return the builder; awaiting resolves by
// table + first operation. Records every write for assertions. Mirrors
// ../__tests__/pickup-row-error.test.ts.
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

vi.mock('@sentry/nextjs', () => ({ captureException: sentryCapture }));
vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: staffRow.value }) }),
      }),
    }),
  }),
}));
vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    rpc,
    from: (table: string) => (fromOverride.current ? fromOverride.current(table) : builder(table)),
  }),
}));
vi.mock('@/lib/require-aal2', () => ({ requireAAL2ForAdmin: async () => ({ ok: true }) }));
vi.mock('@/lib/charge-attempts', () => ({ recordChargeAttempt }));
vi.mock('@/lib/invoice-lot-code', () => ({ primaryLotDisplayCode: async () => 'A-1' }));

import { POST } from '../route';

function callMarkPaid(body?: Record<string, unknown>) {
  return POST(
    new Request('https://bingoauctions.com/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      ...(body
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: 'inv-1' }) },
  );
}

function auditInsertCall() {
  return calls.find((c) => c.table === 'operator_audit_log' && c.op === 'insert');
}

describe('mark-paid — operator_audit_log', () => {
  beforeEach(() => {
    calls.length = 0;
    staffRow.value = { operator_id: 'op-1', role: 'admin' };
    invoiceRow.value = {
      id: 'inv-1',
      status: 'payment_failed_grace',
      operator_id: 'op-1',
      auction_id: 'auc-1',
      fulfillment_method: 'pickup',
      bidder_id: 'b-1',
      total_cents: 2500,
      paid_at: null,
    };
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
    recordChargeAttempt.mockClear();
    sentryCapture.mockClear();
    fromOverride.current = null;
  });

  it('writes the audit row with actor, target, before/after state and reason', async () => {
    const res = await callMarkPaid({ method: 'cash', reason: 'Customer paid at counter' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const audit = auditInsertCall();
    expect(audit).toBeTruthy();
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      operator_id: 'op-1',
      actor_user_id: 'user-1',
      action_type: 'invoice.mark_paid_offline',
      target_id: 'inv-1',
      before_state: { status: 'payment_failed_grace', paid_at: null },
      reason_note: 'Customer paid at counter',
    });
    expect(payload.after_state).toMatchObject({
      status: 'paid',
      amount_cents: 2500,
      method: 'cash',
    });
    expect((payload.after_state as Record<string, unknown>).paid_at).toEqual(expect.any(String));
  });

  it('still works with no reason/method (back-compat with a bare POST)', async () => {
    const res = await callMarkPaid();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const audit = auditInsertCall();
    expect(audit).toBeTruthy();
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload.reason_note).toBeNull();
    expect((payload.after_state as Record<string, unknown>).method).toBeNull();

    // The invoice is still marked paid and the charge attempt still recorded.
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
  });

  it('rejects an invalid method and writes nothing', async () => {
    const res = await callMarkPaid({ method: 'bitcoin' });
    expect(res.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it('an unauthorized caller (non admin/manager role) writes nothing', async () => {
    staffRow.value = { operator_id: 'op-1', role: 'picker' };
    const res = await callMarkPaid({ reason: 'should never land' });
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
    expect(auditInsertCall()).toBeUndefined();
  });

  it('a caller from a different operator writes nothing', async () => {
    staffRow.value = { operator_id: 'op-OTHER', role: 'admin' };
    const res = await callMarkPaid({ reason: 'should never land' });
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it('reports to Sentry and still returns ok when the audit insert fails', async () => {
    fromOverride.current = (table: string) => {
      if (table === 'operator_audit_log') {
        return {
          insert: (payload: unknown) => {
            calls.push({ table, op: 'insert', payload });
            return {
              then: (res: (v: unknown) => unknown) =>
                Promise.resolve({ data: null, error: { message: 'boom' } }).then(res),
            };
          },
        };
      }
      return builder(table);
    };

    const res = await callMarkPaid({ method: 'cash' });
    // The payment itself must still succeed — audit-insert failure is
    // reported, not surfaced as a failed mark-paid.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sentryCapture).toHaveBeenCalledTimes(1);
  });
});
