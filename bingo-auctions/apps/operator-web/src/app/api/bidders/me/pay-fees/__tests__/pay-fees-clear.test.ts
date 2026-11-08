// Mig 0435: fees are cleared by the service-role-only clear_relot_fees_for_bidder,
// keyed on the verified caller, and only after Square says the charge cleared.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const scopedRpc = vi.fn();
const charge = vi.fn();

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'order', 'limit']) c[m] = () => c;
  c.maybeSingle = async () => result;
  return c;
}

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(async () => ({ userId: 'bidder-1', scopedClient: { rpc: scopedRpc } })),
}));
vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    from: (t: string) =>
      t === 'bidders'
        ? chain({ data: { id: 'bidder-1', unpaid_fees_cents: 500, square_customer_id: 'C1', default_payment_method_id: 'ccof:1' }, error: null })
        : chain({ data: { id: 'fee-1' }, error: null }),
    rpc,
  }),
}));
vi.mock('@/lib/square', () => ({
  chargeCardOnFile: (...a: unknown[]) => charge(...a),
  SquareApiError: class extends Error {},
}));

const { POST } = await import('../route');
const req = () => new Request('http://x/api/bidders/me/pay-fees', { method: 'POST' }) as never;

describe('pay-fees clears fees via the service-role RPC (0435)', () => {
  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ error: null });
    scopedRpc.mockReset();
    charge.mockReset();
  });

  it('after a COMPLETED charge: admin rpc with the caller id + Square payment id, never the bidder client', async () => {
    charge.mockResolvedValue({ status: 'COMPLETED', paymentId: 'sqpay_123' });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('clear_relot_fees_for_bidder', { p_bidder_id: 'bidder-1', p_payment_id: 'sqpay_123' });
    expect(scopedRpc).not.toHaveBeenCalled();
    // $5.00 owed → charged exactly 500 cents
    expect(charge.mock.calls[0]?.[0]).toMatchObject({ amountCents: 500, customerId: 'C1', cardId: 'ccof:1' });
  });

  it('declined charge: fees are NOT cleared', async () => {
    charge.mockResolvedValue({ status: 'FAILED', paymentId: 'sqpay_x' });
    const res = await POST(req());
    expect(res.status).toBe(402);
    expect(rpc).not.toHaveBeenCalled();
  });
});
