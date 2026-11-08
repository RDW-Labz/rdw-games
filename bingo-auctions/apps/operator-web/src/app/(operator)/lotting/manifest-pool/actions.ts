'use server';

// Server action for the GLOBAL manifest pool — drop pending import_rows
// across any imports. Mirrors the per-import dropSelectedRows action in
// imports/[id]/actions.ts but doesn't require an importId param so the
// global view can drop rows from multiple manifests at once.
//
// Lots are NEVER created here — that only happens at physical intake via
// the picker app's intake_lot_to_bin RPC (see migration 0059).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

const dropSchema = z.object({
  rowIds: z.array(z.string().uuid()).min(1).max(2000),
  reason: z.string().max(200).nullable().optional(),
});

export type DropResult =
  | { ok: true; dropped: number }
  | { ok: false; error: string };

export async function dropPoolRows(
  input: z.infer<typeof dropSchema>,
): Promise<DropResult> {
  const parsed = dropSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  // The drop_import_rows RPC is SECURITY DEFINER and enforces
  // admin/manager + operator scoping itself.
  const { data, error } = await supabase.rpc('drop_import_rows', {
    p_import_row_ids: parsed.data.rowIds,
    p_reason: parsed.data.reason ?? null,
  });
  if (error) {
    // SF-11 (2026-05-24 audit): surface the real Supabase error message instead
    // of the opaque 'drop_failed' sentinel so callers can show meaningful errors.
    console.error('[drop_import_rows global pool] failed', { error });
    return { ok: false, error: error.message };
  }

  revalidatePath('/lotting/manifest-pool');
  // Also refresh per-import detail pages — we don't know which imports
  // the dropped rows came from, so a coarse revalidate is correct.
  revalidatePath('/imports', 'layout');
  return { ok: true, dropped: (data as number) ?? 0 };
}
