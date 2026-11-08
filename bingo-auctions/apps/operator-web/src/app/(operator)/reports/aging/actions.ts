'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

// Aging-inventory triage action (Jared patch notes 2026-07-24 #3). Staff pick a
// disposition for an item that has cycled through too many auctions and want it
// out of the normal rotation. All dispositions delegate to the mark_lot_disposed
// RPC (mig 0146) — itself admin/manager-only, operator-scoped, and idempotent —
// stamping the chosen reason so the "why" is on the record. 'markdown' is NOT a
// removal (the item stays for sale at a lower price) so it is deliberately not
// offered here; it belongs on the lot edit page.
const DISPOSITIONS = ['dispose', 'donate', 'liquidate', 'other'] as const;

const schema = z.object({
  lotId: z.string().uuid(),
  disposition: z.enum(DISPOSITIONS),
  note: z.string().max(400).nullable().optional(),
});

export type RemoveFromCycleResult = { ok: true } | { ok: false; error: string };

export async function removeFromCycle(
  input: z.infer<typeof schema>,
): Promise<RemoveFromCycleResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data: staff } = await supabase
    .from('operator_users')
    .select('role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'Not an operator' };
  if (!['admin', 'manager'].includes((staff as { role: string }).role)) {
    return { ok: false, error: 'Admin or manager role required' };
  }

  // Compose the disposal reason: the disposition plus an optional staff note.
  // e.g. "aging: liquidate — pallet 12" or "aging: donate".
  const note = parsed.data.note?.trim();
  const reason = `aging: ${parsed.data.disposition}${note ? ` — ${note}` : ''}`;

  const { data: result, error } = await supabase.rpc('mark_lot_disposed', {
    p_lot_id: parsed.data.lotId,
    p_reason: reason,
  });
  if (error) return { ok: false, error: error.message };
  const res = (result ?? {}) as { ok?: boolean; reason?: string };
  if (res.ok === false) {
    return {
      ok: false,
      error:
        res.reason === 'lot_live_with_bids'
          ? "This lot is in a running auction and already has bids, so it can't be removed now. Remove it after the auction closes."
          : (res.reason ?? 'could not remove from cycle'),
    };
  }

  revalidatePath('/reports/aging');
  revalidatePath('/worklist');
  revalidatePath('/lotting/inventory');
  revalidatePath(`/lots/${parsed.data.lotId}`);
  return { ok: true };
}
