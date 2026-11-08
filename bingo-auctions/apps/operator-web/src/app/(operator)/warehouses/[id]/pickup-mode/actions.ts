'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';

export type PickupMode = 'staff_assisted' | 'counter_pickup' | 'self_serve_floor_plan' | 'hybrid';

const PICKUP_MODES: PickupMode[] = ['staff_assisted', 'counter_pickup', 'self_serve_floor_plan', 'hybrid'];

// Persist the warehouse's pickup_mode. Mirrors the authorization pattern in
// pickup-hours/actions.ts: explicit operator-membership check + admin/manager
// role gate + .eq('operator_id', …) on the UPDATE so RLS bypass via the
// admin client still can't cross tenants.
export async function setPickupMode(
  warehouseId: string,
  pickupMode: PickupMode,
): Promise<{ error: string | null }> {
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
  if (!me) return { error: 'Not authorized' };
  const meTyped = me as { operator_id: string; role: string };
  if (!['admin', 'manager'].includes(meTyped.role)) {
    return { error: 'Insufficient permissions' };
  }

  if (!PICKUP_MODES.includes(pickupMode)) {
    return { error: 'Invalid pickup mode' };
  }

  const { data: wh } = await supabase
    .from('warehouses')
    .select('id, operator_id')
    .eq('id', warehouseId)
    .single();
  if (!wh || (wh as { operator_id: string }).operator_id !== meTyped.operator_id) {
    return { error: 'Warehouse not found' };
  }

  const { error } = await supabase
    .from('warehouses')
    .update({
      // Cast to the right shape since the type generator may not have picked
      // up the new column on every dev machine yet. Migration 0094 added it
      // as NOT NULL with default 'staff_assisted'.
      pickup_mode: pickupMode,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', warehouseId)
    .eq('operator_id', meTyped.operator_id);

  if (error) return { error: error.message };

  revalidatePath(`/warehouses/${warehouseId}`);
  revalidatePath(`/warehouses/${warehouseId}/pickup-mode`);
  return { error: null };
}
