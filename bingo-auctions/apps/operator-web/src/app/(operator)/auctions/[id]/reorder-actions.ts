'use server';

// Server action wrapper around reorder_auction_lots (migration 0054).
// Used by the drag-to-reorder UI on the auction detail page.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

const schema = z.object({
  auctionId: z.string().uuid(),
  // Ordered list of lot UUIDs — position 1 in the array becomes
  // lot_number 1 (first to close).
  orderedIds: z.array(z.string().uuid()).min(1).max(2500),
});

export type ReorderResult =
  | { ok: true; updated: number }
  | { ok: false; error: string };

export async function reorderAuctionLots(
  input: z.infer<typeof schema>,
): Promise<ReorderResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data, error } = await supabase.rpc('reorder_auction_lots', {
    p_auction_id: parsed.data.auctionId,
    p_ordered_ids: parsed.data.orderedIds,
  });
  if (error) {
    // Map structured RPC errors to friendly copy.
    const msg = error.message ?? '';
    if (msg.includes('auction is')) {
      return { ok: false, error: 'Cannot reorder a live or closed auction' };
    }
    if (msg.includes('do not belong to this auction')) {
      return { ok: false, error: 'One or more lots no longer belong to this auction. Refresh and try again.' };
    }
    if (msg.includes('provided')) {
      return { ok: false, error: 'Lot count mismatch. Refresh and try again.' };
    }
    if (error.code === '28000' || error.code === '42501') {
      return { ok: false, error: 'Not authorized for this auction' };
    }
    return { ok: false, error: msg || 'Reorder failed' };
  }

  const updated = typeof data === 'number' ? data : 0;
  revalidatePath(`/auctions/${parsed.data.auctionId}`);
  return { ok: true, updated };
}
