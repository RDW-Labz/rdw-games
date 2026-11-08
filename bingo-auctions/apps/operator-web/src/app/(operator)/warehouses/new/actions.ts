'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServer } from '@/lib/supabase-server';
import { warehouseInputSchema, type WarehouseInput } from '@auction-platform/shared/schemas';

export type CreateWarehouseResult =
  | { ok: true; warehouseId: string }
  | { ok: false; error: string };

export async function createWarehouse(input: WarehouseInput): Promise<CreateWarehouseResult> {
  const parsed = warehouseInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const supabase = await getSupabaseServer();

  // Look up the current operator via RLS-permitted operator_users join
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'Not an operator' };

  const { data, error } = await supabase
    .from('warehouses')
    .insert({
      operator_id: staff.operator_id,
      name: parsed.data.name,
      address_line1: parsed.data.addressLine1,
      address_line2: parsed.data.addressLine2 ?? null,
      city: parsed.data.city,
      state: parsed.data.state,
      postal_code: parsed.data.postalCode,
      timezone: parsed.data.timezone,
    })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Insert failed' };

  revalidatePath('/warehouses');
  return { ok: true, warehouseId: data.id };
}
