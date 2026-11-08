'use server';

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

// Shape of a single day entry in pickup_hours JSONB.
export type DayWindow = { open: string; close: string };
export type PickupHours = Record<string, DayWindow[]>;

export async function savePickupHours(
  warehouseId: string,
  pickupHours: PickupHours,
  slotMinutes: number,
  slotCapacity: number,
): Promise<{ error: string | null }> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Verify the caller is admin/manager for the warehouse's operator.
  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) return { error: 'Not authorized' };
  if (!['admin', 'manager'].includes((me as { role: string }).role)) {
    return { error: 'Insufficient permissions' };
  }

  // Validate the warehouse belongs to this operator (RLS would catch it, but
  // we want a clear error message).
  const { data: wh } = await supabase
    .from('warehouses')
    .select('id, operator_id')
    .eq('id', warehouseId)
    .single();
  if (!wh || (wh as { operator_id: string }).operator_id !== (me as { operator_id: string }).operator_id) {
    return { error: 'Warehouse not found' };
  }

  // Validate slot values.
  if (!Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > 240) {
    return { error: 'Slot length must be between 5 and 240 minutes' };
  }
  if (!Number.isInteger(slotCapacity) || slotCapacity < 1 || slotCapacity > 500) {
    return { error: 'Slot capacity must be between 1 and 500' };
  }

  // Validate time strings in each day window.
  const TIME_RE = /^\d{2}:\d{2}$/;
  for (const [day, windows] of Object.entries(pickupHours)) {
    for (const w of windows) {
      if (!TIME_RE.test(w.open) || !TIME_RE.test(w.close)) {
        return { error: `Invalid time format for ${day}` };
      }
      if (w.open >= w.close) {
        return { error: `Open time must be before close time for ${day}` };
      }
    }
  }

  // Use service-role client for the write — warehouse settings are admin
  // operations and may be blocked by RLS on the operator's own row. The
  // membership check above already proved this warehouse belongs to the
  // caller's operator; the redundant `.eq('operator_id', …)` here is
  // BUG-009 defense-in-depth: admin client bypasses RLS, so a TOCTOU race
  // (or a future code path that reuses this function with stale data)
  // should still not be able to cross tenant boundaries.
  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('warehouses')
    .update({
      pickup_hours: pickupHours,
      pickup_slot_minutes: slotMinutes,
      pickup_slot_capacity: slotCapacity,
      updated_at: new Date().toISOString(),
    })
    .eq('id', warehouseId)
    .eq('operator_id', (me as { operator_id: string }).operator_id);

  if (error) return { error: error.message };
  return { error: null };
}
