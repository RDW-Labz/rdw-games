'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { parseCustomerInfoInput, type CustomerInfoInput } from './parse-customer-info';

export async function saveCustomerInfo(
  warehouseId: string,
  input: CustomerInfoInput,
): Promise<{ error: string | null }> {
  const parsed = parseCustomerInfoInput(input);
  if (!parsed.ok) return { error: parsed.error };

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
  if (!['admin', 'manager'].includes((me as { role: string }).role)) {
    return { error: 'Insufficient permissions' };
  }

  const { data: wh } = await supabase
    .from('warehouses')
    .select('id, operator_id')
    .eq('id', warehouseId)
    .single();
  if (!wh || (wh as { operator_id: string }).operator_id !== (me as { operator_id: string }).operator_id) {
    return { error: 'Warehouse not found' };
  }

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('warehouses')
    .update({
      pickup_instructions: parsed.data.pickup_instructions,
      customer_notice: parsed.data.customer_notice,
      active: parsed.data.active,
      updated_at: new Date().toISOString(),
    })
    .eq('id', warehouseId)
    .eq('operator_id', (me as { operator_id: string }).operator_id);

  if (error) return { error: error.message };

  revalidatePath(`/warehouses/${warehouseId}`);
  revalidatePath(`/warehouses/${warehouseId}/customer-info`);
  revalidatePath('/warehouses');
  return { error: null };
}
