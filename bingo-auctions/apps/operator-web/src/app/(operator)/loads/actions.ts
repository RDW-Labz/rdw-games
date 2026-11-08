'use server';

// Server actions for /loads — create a manual load and archive a load.
//
// Both wrap RPCs defined in migration 0148_loads_table.sql. RLS already
// enforces admin/manager-only writes; these actions provide better error
// messages and centralized validation via Zod.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

// ── createManualLoad ────────────────────────────────────────────────────────

const createManualLoadSchema = z.object({
  sourceName: z.string().min(1, 'Source name is required').max(200),
  purchaseCostCents: z.number().int().min(0).nullable().optional(),
  purchaseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Purchase date must be YYYY-MM-DD')
    .nullable()
    .optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export type CreateManualLoadInput = z.infer<typeof createManualLoadSchema>;

export type CreateManualLoadResult =
  | { ok: true; loadId: string }
  | { ok: false; error: string };

export async function createManualLoad(
  input: CreateManualLoadInput,
): Promise<CreateManualLoadResult> {
  const parsed = createManualLoadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data, error } = await supabase.rpc('create_manual_load', {
    p_source_name: parsed.data.sourceName,
    p_purchase_cost_cents: parsed.data.purchaseCostCents ?? null,
    p_purchase_date: parsed.data.purchaseDate ?? null,
    p_notes: parsed.data.notes ?? null,
  });

  if (error) {
    // Map common RPC errors to friendly messages
    const msg = error.message;
    if (msg.includes('forbidden')) {
      return { ok: false, error: 'Only admins and managers can create loads.' };
    }
    if (msg.includes('source_name_required')) {
      return { ok: false, error: 'Source name is required.' };
    }
    if (msg.includes('source_name_too_long')) {
      return { ok: false, error: 'Source name must be 200 characters or fewer.' };
    }
    if (msg.includes('notes_too_long')) {
      return { ok: false, error: 'Notes must be 2000 characters or fewer.' };
    }
    if (msg.includes('not_an_operator')) {
      return { ok: false, error: 'Not an operator user.' };
    }
    return { ok: false, error: msg };
  }

  if (!data) return { ok: false, error: 'No load id returned' };

  revalidatePath('/loads');
  return { ok: true, loadId: String(data) };
}

// ── archiveLoad ─────────────────────────────────────────────────────────────

const archiveLoadSchema = z.object({
  loadId: z.string().uuid('Invalid load id'),
});

export type ArchiveLoadResult = { ok: true } | { ok: false; error: string };

export async function archiveLoad(loadId: string): Promise<ArchiveLoadResult> {
  const parsed = archiveLoadSchema.safeParse({ loadId });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data, error } = await supabase.rpc('archive_load', {
    p_load_id: parsed.data.loadId,
  });

  if (error) {
    if (error.message.includes('forbidden')) {
      return { ok: false, error: 'Only admins and managers can archive loads.' };
    }
    return { ok: false, error: error.message };
  }

  if (data === false) {
    return {
      ok: false,
      error: 'Load not found or already archived.',
    };
  }

  revalidatePath('/loads');
  return { ok: true };
}

// ── updateLoadCost ──────────────────────────────────────────────────────────

const updateLoadCostSchema = z.object({
  loadId: z.string().uuid('Invalid load id'),
  costCents: z
    .number()
    .int()
    .min(0)
    .max(100_000_000)
    .nullable(),
  purchaseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Purchase date must be YYYY-MM-DD')
    .nullable()
    .optional(),
});

export async function updateLoadCost(
  input: z.infer<typeof updateLoadCostSchema>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = updateLoadCostSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in' };

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!staff) return { ok: false, error: 'Not a staff member' };

  const role = (staff as { role: string }).role;
  const operatorId = (staff as { operator_id: string }).operator_id;
  if (role !== 'admin' && role !== 'manager') {
    return { ok: false, error: 'Only admins and managers can change load costs' };
  }

  const { loadId, costCents, purchaseDate } = parsed.data;

  const { data: existing, error: readErr } = await supabase
    .from('loads')
    .select('purchase_cost_cents, purchase_date')
    .eq('id', loadId)
    .eq('operator_id', operatorId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!existing) return { ok: false, error: 'Load not found' };

  const beforeState = {
    purchase_cost_cents: (existing as { purchase_cost_cents: number | null }).purchase_cost_cents,
    purchase_date: (existing as { purchase_date: string | null }).purchase_date,
  };

  const updatePayload: {
    purchase_cost_cents: number | null;
    purchase_date?: string | null;
  } = { purchase_cost_cents: costCents };
  if (purchaseDate !== undefined) {
    updatePayload.purchase_date = purchaseDate;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('loads')
    .update(updatePayload)
    .eq('id', loadId)
    .eq('operator_id', operatorId)
    .select('id');
  if (updateErr) return { ok: false, error: updateErr.message };
  if (!updated?.length) return { ok: false, error: 'Load not found' };

  const afterState = {
    purchase_cost_cents: costCents,
    purchase_date:
      purchaseDate !== undefined ? purchaseDate : beforeState.purchase_date,
  };

  const admin = getSupabaseAdmin();
  const { error: auditErr } = await admin.from('operator_audit_log').insert({
    operator_id: operatorId,
    actor_user_id: user.id,
    action_type: 'load.cost_updated',
    target_id: loadId,
    before_state: beforeState,
    after_state: afterState,
  });
  if (auditErr) {
    console.error('[loads] audit insert failed', auditErr.message);
  }

  revalidatePath('/loads');
  return { ok: true };
}
