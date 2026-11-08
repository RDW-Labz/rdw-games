'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';

const schema = z.object({
  autoRelistMaxAttempts: z.number().int().min(0).max(10),
  // mig 0180 — review gate + SINGLE source of truth. 'auto' mints relisted
  // lots automatically; 'review'/'off' leave unsold lots on /worklist for
  // manual handling. The legacy auto_relist_enabled boolean is DERIVED from
  // this (enabled === mode === 'auto') so the two can never disagree.
  autoRelistMode: z.enum(['auto', 'review', 'off']),
});

type Result = { ok: true } | { ok: false; error: string };

// Save the auto-relist policy. Admin-only. The DB CHECK on operators
// (added in migration 0097) also enforces the 0..10 bounds.
export async function saveAutoRelistSettings(
  input: z.infer<typeof schema>,
): Promise<Result> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'Not an operator' };
  const staffTyped = staff as { operator_id: string; role: string };
  if (staffTyped.role !== 'admin') {
    return { ok: false, error: 'Admin role required' };
  }

  const { error } = await supabase
    .from('operators')
    .update({
      // Derived, not user-set: enabled iff mode === 'auto'. Keeps the column
      // (still read by the relist cron + field-mobile relist counter) in
      // lockstep with mode, so they can never contradict.
      auto_relist_enabled: parsed.data.autoRelistMode === 'auto',
      auto_relist_max_attempts: parsed.data.autoRelistMaxAttempts,
      auto_relist_mode: parsed.data.autoRelistMode,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', staffTyped.operator_id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}
