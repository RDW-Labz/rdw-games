'use server';

// Server action wrapper around the redistribute_close_times RPC from
// migration 0053. Recomputes lots.close_at across the auction's
// [ends_at, last_lot_ends_at] window evenly.
//
// Operators run this after adding/removing lots so the spacing is
// uniform. The RPC handles auth (auth.uid not null + caller_op match)
// and refuses to run on live/closed/canceled auctions (would surprise
// bidders).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

const schema = z.object({ auctionId: z.string().uuid() });

export type RedistributeResult =
  | { ok: true; updated: number }
  | { ok: false; error: string };

export async function redistributeCloseTimes(
  input: z.infer<typeof schema>,
): Promise<RedistributeResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data, error } = await supabase.rpc('redistribute_close_times', {
    p_auction_id: parsed.data.auctionId,
  });
  if (error) {
    // Map the RPC's structured errors to friendlier copy.
    const msg = error.message ?? '';
    if (msg.includes('auction is')) {
      return { ok: false, error: 'Cannot redistribute on a live or closed auction' };
    }
    if (error.code === '28000' || error.code === '42501') {
      return { ok: false, error: 'Not authorized for this auction' };
    }
    return { ok: false, error: msg || 'Redistribute failed' };
  }

  const updated = typeof data === 'number' ? data : 0;
  revalidatePath(`/auctions/${parsed.data.auctionId}`);
  return { ok: true, updated };
}
