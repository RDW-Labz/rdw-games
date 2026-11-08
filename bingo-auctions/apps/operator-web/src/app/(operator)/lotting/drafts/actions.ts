'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { lotDeleteErrorMessage } from '@/lib/lot-delete';

const deleteSchema = z.object({
  lot_id: z.string().uuid(),
});

export type DeleteDraftResult = { ok: true } | { ok: false; error: string };

// Hard-delete a single pending_intake draft lot. Used from the Drafts
// table on /lotting/drafts.
//
// Hard, not soft, because:
//   - Drafts have no bids, no auction membership, no invoice (status
//     'pending_intake' is upstream of all of that). The lot row is
//     entirely disposable.
//   - The trash/restore UI is gone — soft-delete with no UI to surface
//     it would just bloat the table.
//   - import_rows.lot_id has ON DELETE SET NULL (0029), so the source
//     manifest row stays intact and re-scannable.
//
// Guards:
//   - Caller must be operator-staff with role admin or manager.
//   - Lot must belong to the caller's operator.
//   - Lot must still be status='pending_intake' (in case it got bin-
//     scanned between page load and click).
//   - Mig 0400's BEFORE DELETE trigger refuses a draft with a physical
//     footprint (most drafts carry a printed sticker) and writes an
//     operator_audit_log row for every delete it allows. This delete runs as
//     the service role, so x-bingo-actor tells the trigger who asked.
export async function deleteDraftLot(
  input: z.infer<typeof deleteSchema>,
): Promise<DeleteDraftResult> {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'Not an operator' };
  if (staff.role !== 'admin' && staff.role !== 'manager') {
    return { ok: false, error: 'Admins or managers only' };
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('lots')
    .delete()
    .eq('id', parsed.data.lot_id)
    .eq('operator_id', staff.operator_id as string)
    .eq('status', 'pending_intake')
    .select('id')
    .setHeader('x-bingo-actor', user.id);
  if (error) return { ok: false, error: lotDeleteErrorMessage(error) };
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: 'Lot not found, already deleted, or no longer a draft.',
    };
  }

  revalidatePath('/lotting/drafts');
  revalidatePath('/lotting/inventory');
  return { ok: true };
}
