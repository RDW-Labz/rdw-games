// Grace expiry relisted an invoice without asking Square about its recorded
// payment. Square answers some charges PENDING; the drain parks those in grace
// too, and a PENDING payment can complete after the 48h — so the customer was
// charged for lots that had already been sent back to auction. Now a payment
// that may still land (or can't be looked up) keeps the invoice in grace.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Inv = { id: string; bidder_id: string; operator_id: string; square_payment_id: string | null; status: string };

const { db, getPayment, rpc } = vi.hoisted(() => ({
  db: { invoices: [] as Inv[], lotUpdates: [] as string[][], notified: [] as string[] },
  getPayment: vi.fn(),
  rpc: vi.fn(),
}));

function builder(table: string) {
  let patch: Record<string, unknown> | null = null;
  let id: string | null = null;
  let status: string | null = null;
  let ids: string[] = [];
  const run = () => {
    if (table === 'invoices') {
      const hit = db.invoices.filter((r) => (id === null || r.id === id) && (status === null || r.status === status));
      if (patch) for (const r of hit) Object.assign(r, patch);
      return hit.map((r) => ({ ...r }));
    }
    if (table === 'invoice_lots') return ids.map((invoice_id) => ({ invoice_id, lot_id: `lot-${invoice_id}`, picked_up_at: null }));
    if (table === 'lots' && patch) db.lotUpdates.push(ids);
    return [];
  };
  const b: Record<string, unknown> = {};
  const self = () => b;
  b.select = self;
  b.lt = self;
  b.limit = self;
  b.order = self;
  b.returns = self;
  b.update = (p: Record<string, unknown>) => {
    patch = p;
    return b;
  };
  b.eq = (col: string, v: string) => {
    if (col === 'id') id = v;
    if (col === 'status') status = v;
    return b;
  };
  b.in = (_col: string, v: string[]) => {
    ids = v;
    return b;
  };
  b.insert = (row: { idempotency_key?: string }) => {
    if (table === 'notifications_outbox') db.notified.push(String(row.idempotency_key));
    return Promise.resolve({ data: null, error: null });
  };
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: run(), error: null }).then(res, rej);
  return b;
}

vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ rpc, from: builder }) }));
vi.mock('@/lib/square', () => ({ getPayment }));
vi.mock('@/lib/app-links', () => ({ bidderDeepLink: (p: string) => `bingo://${p}` }));

import { runGraceExpiry } from '../grace-expiry';

const inv = (id: string, square_payment_id: string | null): Inv => ({
  id,
  bidder_id: `b-${id}`,
  operator_id: 'op-1',
  square_payment_id,
  status: 'payment_failed_grace',
});

describe('grace expiry asks Square before relisting', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    db.invoices = [];
    db.lotUpdates = [];
    db.notified = [];
    getPayment.mockReset();
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it.each(['PENDING', 'COMPLETED', 'APPROVED'])(
    'Square says %s: stays in grace, no fee, lots not released, bidder not told',
    async (squareStatus) => {
      getPayment.mockResolvedValue({ paymentId: 'sq_1', status: squareStatus });
      db.invoices = [inv('i1', 'sq_1')];
      const out = await runGraceExpiry();

      expect(getPayment).toHaveBeenCalledWith('sq_1');
      expect(db.invoices[0]?.status).toBe('payment_failed_grace');
      expect(rpc).not.toHaveBeenCalled();
      expect(db.lotUpdates).toEqual([]);
      expect(db.notified).toEqual([]);
      expect(out).toMatchObject({ relisted_invoices: 0, held_for_square: 1 });
    },
  );

  it('Square lookup fails: stays in grace (retried next hour), nothing released', async () => {
    getPayment.mockRejectedValue(new Error('square 500'));
    db.invoices = [inv('i1', 'sq_1')];
    const out = await runGraceExpiry();

    expect(db.invoices[0]?.status).toBe('payment_failed_grace');
    expect(db.lotUpdates).toEqual([]);
    expect(out).toMatchObject({ relisted_invoices: 0, held_for_square: 1 });
  });

  it.each(['FAILED', 'CANCELED'])('Square says %s: relisted as before', async (squareStatus) => {
    getPayment.mockResolvedValue({ paymentId: 'sq_1', status: squareStatus });
    db.invoices = [inv('i1', 'sq_1')];
    const out = await runGraceExpiry();

    expect(db.invoices[0]?.status).toBe('payment_failed_relisted');
    expect(rpc).toHaveBeenCalledWith('apply_relot_fee', { p_invoice_id: 'i1' });
    expect(db.lotUpdates).toEqual([['lot-i1']]);
    expect(out).toMatchObject({ relisted_invoices: 1, held_for_square: 0 });
  });

  it('Square has no such payment (404): relisted', async () => {
    getPayment.mockResolvedValue(null);
    db.invoices = [inv('i1', 'sq_gone')];
    await runGraceExpiry();
    expect(db.invoices[0]?.status).toBe('payment_failed_relisted');
  });

  it('no recorded payment (no card on file): relisted without a Square call', async () => {
    db.invoices = [inv('i1', null)];
    const out = await runGraceExpiry();

    expect(getPayment).not.toHaveBeenCalled();
    expect(db.invoices[0]?.status).toBe('payment_failed_relisted');
    expect(out).toMatchObject({ relisted_invoices: 1 });
  });

  it('one held invoice does not stop the others in the batch', async () => {
    getPayment.mockImplementation(async (id: string) => ({ paymentId: id, status: id === 'sq_p' ? 'PENDING' : 'FAILED' }));
    db.invoices = [inv('held', 'sq_p'), inv('gone', 'sq_f'), inv('nocard', null)];
    const out = await runGraceExpiry();

    expect(db.invoices.map((r) => [r.id, r.status])).toEqual([
      ['held', 'payment_failed_grace'],
      ['gone', 'payment_failed_relisted'],
      ['nocard', 'payment_failed_relisted'],
    ]);
    expect(out).toMatchObject({ scanned: 3, relisted_invoices: 2, held_for_square: 1 });
  });
});
