import type { SupabaseClient } from '@supabase/supabase-js';

export type OffsiteSaleRow = {
  warehouse_id: string;
  name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  timezone: string | null;
  pickup_hours: Record<string, Array<{ open: string; close: string }>> | null;
  pickup_instructions: string | null;
  customer_notice: string;
  auction_count: number;
};

type Client = Pick<SupabaseClient, 'rpc'>;

export async function fetchOffsiteSales(client: Client): Promise<OffsiteSaleRow[]> {
  try {
    const { data, error } = await client.rpc('public_offsite_sales');
    if (error) return [];
    return (data ?? []) as OffsiteSaleRow[];
  } catch {
    return [];
  }
}
