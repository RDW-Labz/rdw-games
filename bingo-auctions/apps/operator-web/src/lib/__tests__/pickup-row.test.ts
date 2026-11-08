// ensurePickupRow must log BOTH failure shapes and never throw. supabase-js
// reports an RPC error in the returned `error` (it does not throw), which the
// old try/catch-only call sites silently dropped.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensurePickupRow } from '../pickup-row';

function adminWith(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as Parameters<typeof ensurePickupRow>[0];
}

describe('ensurePickupRow', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('calls ensure_pickup_row with the invoice id and stays quiet on success', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'pickup-1', error: null });

    await expect(ensurePickupRow(adminWith(rpc), 'inv-1', 'mark-paid')).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('ensure_pickup_row', { p_invoice_id: 'inv-1' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a returned error with the calling path and invoice id, without throwing', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'invoice_has_no_warehouse_lots: inv-1', code: 'P0001' },
    });

    await expect(
      ensurePickupRow(adminWith(rpc), 'inv-1', 'auto-charge-drain:charge'),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[auto-charge-drain:charge] ensure_pickup_row failed for invoice',
      'inv-1',
      'invoice_has_no_warehouse_lots: inv-1',
    );
  });

  it('logs a thrown error without rethrowing', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('fetch failed'));

    await expect(ensurePickupRow(adminWith(rpc), 'inv-1', 'square/webhook')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[square/webhook] ensure_pickup_row failed for invoice',
      'inv-1',
      'fetch failed',
    );
  });
});
