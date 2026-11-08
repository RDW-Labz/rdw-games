// 0436: the card save keeps the card's billing ZIP when the bidder has none.
// The fill is best effort: the save must succeed even when the RPC throws,
// errors, hangs, or does not exist yet. Fake data only; Square is a mocked fetch.

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { NextRequest } from 'next/server';

const { rpc, update, ensureCustomer } = vi.hoisted(() => ({
  rpc: vi.fn(),
  update: vi.fn(),
  ensureCustomer: vi.fn(),
}));

const BIDDER = '11111111-1111-4111-8111-111111111111';

vi.mock('@/lib/auth', () => ({
  verifyAuth: async () => ({ userId: BIDDER, email: 'bidder@example.invalid', displayName: 'Test Bidder' }),
}));

vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    rpc,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: BIDDER }, error: null }) }) }),
      update: (row: unknown) => {
        update(row);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

vi.mock('@/lib/square', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/square')>();
  return { ...actual, ensureBidderSquareCustomer: ensureCustomer };
});

import { POST } from '../route';
import { FILL_ZIP_TIMEOUT_MS } from '@/lib/bidder-postal-code-from-card';

function req(): NextRequest {
  return new Request('https://bingoauctions.com/api/bidder/square/save-card', {
    method: 'POST',
    body: JSON.stringify({ source_id: 'cnon:fake-token' }),
  }) as unknown as NextRequest;
}

function squareCard(billing?: { postal_code?: string; country?: string }) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        card: {
          id: 'ccof:fake-card-0001',
          card_brand: 'VISA',
          last_4: '1111',
          exp_month: 12,
          exp_year: 2030,
          ...(billing ? { billing_address: billing } : {}),
        },
      }),
  };
}

const okBody = { ok: true, card: { brand: 'VISA', last4: '1111', exp_month: 12, exp_year: 2030 } };

describe('POST /api/bidder/square/save-card — billing ZIP (0436)', () => {
  let errSpy: MockInstance<typeof console.error>;
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    process.env.SQUARE_ACCESS_TOKEN = 'fake-square-token';
    rpc.mockReset();
    update.mockReset();
    ensureCustomer.mockReset().mockResolvedValue('FAKE_CUSTOMER_1');
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    errSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('calls the RPC with the 5-digit ZIP from a ZIP+4 billing address', async () => {
    fetchSpy.mockResolvedValue(squareCard({ postal_code: '72701-1234', country: 'US' }) as unknown as Response);
    rpc.mockResolvedValue({ data: true, error: null });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(okBody);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('fill_bidder_postal_code_if_empty', {
      p_bidder_id: BIDDER,
      p_postal_code: '72701',
    });
    // The card row write never carries the ZIP (0434's guard would refuse it).
    expect(update.mock.calls[0]?.[0]).not.toHaveProperty('postal_code');
  });

  it('does not call the RPC when Square returns no, a non-US, or a malformed ZIP', async () => {
    for (const billing of [undefined, {}, { postal_code: '' }, { postal_code: 'A1B 2C3', country: 'CA' }, { postal_code: '72701', country: 'GB' }, { postal_code: '7270' }]) {
      fetchSpy.mockResolvedValue(squareCard(billing) as unknown as Response);
      const res = await POST(req());
      expect(res.status).toBe(200);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('still succeeds when the RPC is missing (before 0434/0436), without logging it', async () => {
    fetchSpy.mockResolvedValue(squareCard({ postal_code: '72701' }) as unknown as Response);
    for (const code of ['PGRST202', '42883']) {
      rpc.mockResolvedValueOnce({ data: null, error: { code, message: 'function not found' } });
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(okBody);
    }
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('still succeeds when the RPC errors or throws, and logs no customer data', async () => {
    fetchSpy.mockResolvedValue(squareCard({ postal_code: '72701' }) as unknown as Response);
    rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'statement timeout' } });
    expect((await POST(req())).status).toBe(200);
    rpc.mockRejectedValueOnce(new Error('fetch failed'));
    expect((await POST(req())).status).toBe(200);
    rpc.mockImplementationOnce(() => {
      throw new Error('sync boom');
    });
    expect((await POST(req())).status).toBe(200);
    const logged = JSON.stringify(errSpy.mock.calls);
    expect(errSpy).toHaveBeenCalledTimes(3);
    expect(logged).not.toContain('72701');
    expect(logged).not.toContain(BIDDER);
  });

  it('does not wait more than the cap when the RPC hangs', async () => {
    fetchSpy.mockResolvedValue(squareCard({ postal_code: '72701' }) as unknown as Response);
    rpc.mockReturnValue(new Promise(() => {}));
    const t0 = Date.now();
    const res = await POST(req());
    const ms = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(okBody);
    expect(ms).toBeGreaterThanOrEqual(FILL_ZIP_TIMEOUT_MS - 50);
    expect(ms).toBeLessThan(FILL_ZIP_TIMEOUT_MS + 1000);
  });
});
