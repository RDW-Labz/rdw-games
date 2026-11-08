import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchOffsiteSales } from './offsite-sales';

function fakeRpcClient(result: { data: unknown; error: unknown }) {
  return {
    rpc: async () => result,
  } as unknown as Pick<SupabaseClient, 'rpc'>;
}

describe('fetchOffsiteSales', () => {
  it('returns [] when the rpc fails', async () => {
    const client = fakeRpcClient({ data: null, error: { message: 'boom' } });
    await expect(fetchOffsiteSales(client)).resolves.toEqual([]);
  });

  it('passes rows through on success', async () => {
    const rows = [
      {
        warehouse_id: 'wh-1',
        name: 'Crandall',
        customer_notice: 'Off-site pickup',
        auction_count: 2,
      },
    ];
    const client = fakeRpcClient({ data: rows, error: null });
    await expect(fetchOffsiteSales(client)).resolves.toEqual(rows);
  });
});
