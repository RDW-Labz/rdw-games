'use server';

// Server actions on the manifest pool.
//
// Architectural note (migration 0059):
//   "Lot N selected" is gone. Lots are not minted from manifest rows here
//   anymore — they only come into existence at physical intake, when a
//   picker scans the item's identifier (UPC/ASIN/FNSKU/LPN/external_code)
//   plus a bin QR. The mobile picker's intake_lot_to_bin RPC now falls
//   through to import_rows and mints a fully-populated lot directly into
//   `in_inventory` at that moment. See packages/db/migrations/0059.
//
// What's left here: dropSelectedRows. The operator can still mark a
// manifest row as "not sellable" without ever creating a lot for it
// (e.g. damaged, stolen, never arrived). drop_import_rows RPC is
// unchanged — same behavior, same RBAC.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

const dropSchema = z.object({
  importId: z.string().uuid(),
  rowIds: z.array(z.string().uuid()).min(1).max(2000),
  reason: z.string().max(200).nullable().optional(),
});

export type DropResult =
  | { ok: true; dropped: number }
  | { ok: false; error: string };

export async function dropSelectedRows(
  input: z.infer<typeof dropSchema>,
): Promise<DropResult> {
  const parsed = dropSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }

  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  const { data, error } = await supabase.rpc('drop_import_rows', {
    p_import_row_ids: parsed.data.rowIds,
    p_reason: parsed.data.reason ?? null,
  });
  if (error) {
    console.error('[drop_import_rows] failed', { error });
    return { ok: false, error: 'drop_failed' };
  }

  revalidatePath(`/imports/${parsed.data.importId}`);
  revalidatePath('/lotting/manifest-pool');
  return { ok: true, dropped: (data as number) ?? 0 };
}
