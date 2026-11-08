'use server';

// Manager actions for warehouse PIN workers (#2 phase 3). Thin wrappers over the
// SECURITY DEFINER RPCs (mig 0281/0282), which enforce manager-gating and PIN
// hashing server-side. We ALSO re-check manager here so a non-manager never even
// reaches the RPC. PINs pass straight through to create_worker/set_worker_pin,
// which bcrypt-hash them — the plaintext is never stored or returned.

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSupabaseServer } from '@/lib/supabase-server';

async function requireManager() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');
  const role = (me as { role: string }).role;
  if (role !== 'admin' && role !== 'manager') {
    throw new Error('Only managers can manage warehouse workers.');
  }
  return { supabase, operatorId: (me as { operator_id: string }).operator_id };
}

function friendly(msg: string): string {
  if (msg.includes('pin_must_be_4_to_8_digits')) return 'PIN must be 4–8 digits.';
  if (msg.includes('requires_manager')) return 'Only managers can manage warehouse workers.';
  if (msg.includes('workers_operator_active_name') || msg.includes('duplicate key')) {
    return 'A worker with that name already exists.';
  }
  if (msg.includes('warehouse_not_found_for_operator')) {
    return 'That location does not belong to this operator.';
  }
  if (msg.includes('worker_not_found')) return 'That worker no longer exists.';
  return msg;
}

export async function createWorkerAction(input: {
  displayName: string;
  pin: string;
  role: string;
}) {
  const { supabase, operatorId } = await requireManager();
  const { error } = await supabase.rpc('create_worker', {
    p_operator_id: operatorId,
    p_display_name: input.displayName.trim(),
    p_pin: input.pin,
    p_role: input.role,
  });
  if (error) throw new Error(friendly(error.message));
  revalidatePath('/staff/workers');
}

export async function setWorkerPinAction(input: { workerId: string; pin: string }) {
  const { supabase } = await requireManager();
  const { error } = await supabase.rpc('set_worker_pin', {
    p_worker_id: input.workerId,
    p_pin: input.pin,
  });
  if (error) throw new Error(friendly(error.message));
  revalidatePath('/staff/workers');
}

export async function setWorkerActiveAction(input: { workerId: string; active: boolean }) {
  const { supabase } = await requireManager();
  const { error } = await supabase.rpc('set_worker_active', {
    p_worker_id: input.workerId,
    p_active: input.active,
  });
  if (error) throw new Error(friendly(error.message));
  revalidatePath('/staff/workers');
}

/**
 * Post a worker to one location, or to all of them.
 *
 * `warehouseId: null` means "all locations" — the state every worker is in
 * today, and the right one for an owner or a manager who covers both
 * buildings. Assigning is per-person and opt-in; nothing about a worker
 * changes until somebody picks a location for them.
 */
export async function setWorkerWarehouseAction(input: {
  workerId: string;
  warehouseId: string | null;
}) {
  const { supabase } = await requireManager();
  const { error } = await supabase.rpc('set_worker_warehouse', {
    p_worker_id: input.workerId,
    p_warehouse_id: input.warehouseId,
  });
  if (error) throw new Error(friendly(error.message));
  revalidatePath('/staff/workers');
  // The productivity table shows each worker's assignment beside their counts,
  // so it goes stale the moment this changes.
  revalidatePath('/dashboard/workers');
}
