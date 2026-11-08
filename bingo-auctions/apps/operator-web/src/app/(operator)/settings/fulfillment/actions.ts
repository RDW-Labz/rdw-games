'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

const addressSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  company: z.string().min(1).max(120).optional(),
  street1: z.string().min(1).max(120),
  street2: z.string().max(120).optional(),
  city: z.string().min(1).max(80),
  state: z.string().min(2).max(2),
  zip: z.string().min(5).max(10),
  country: z.string().min(2).max(2).optional(),
  phone: z.string().min(7).max(20).optional(),
});

const fulfillmentSchema = z.object({
  offersPickup: z.boolean(),
  offersShipping: z.boolean(),
  returnAddress: addressSchema.optional(),
  defaultPkgWeightOz: z.number().int().min(1).max(1120).optional(),
  defaultPkgLengthIn: z.number().min(1).max(108).optional(),
  defaultPkgWidthIn: z.number().min(1).max(108).optional(),
  defaultPkgHeightIn: z.number().min(1).max(108).optional(),
  handlingFeeCents: z.number().int().min(0).max(50000).optional(),
});

export type FulfillmentSettings = z.infer<typeof fulfillmentSchema>;

type Result = { ok: true } | { ok: false; error: string };

// Save operator fulfillment settings. Requires admin role (managers
// shouldn't be flipping toggles that affect every active auction).
export async function saveFulfillmentSettings(input: FulfillmentSettings): Promise<Result> {
  const parsed = fulfillmentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) return { ok: false, error: 'not_in_operator_users' };
  const meTyped = me as { operator_id: string; role: string };
  if (meTyped.role !== 'admin') {
    return { ok: false, error: 'admin_only' };
  }

  // Sanity check: at least one of offers_pickup / offers_shipping must
  // be true. The DB CHECK enforces this, but we surface a clearer error
  // here so the form can highlight both fields.
  if (!parsed.data.offersPickup && !parsed.data.offersShipping) {
    return { ok: false, error: 'must_offer_at_least_one_method' };
  }

  // If shipping is being enabled, a return address is mandatory (we
  // can't generate labels without a from-address).
  if (parsed.data.offersShipping) {
    const a = parsed.data.returnAddress;
    if (!a || !a.street1 || !a.city || !a.state || !a.zip) {
      return {
        ok: false,
        error: 'Return address is required when shipping is enabled (street, city, state, ZIP).',
      };
    }
  }

  const admin = getSupabaseAdmin();

  // Update the operator capability flags.
  const { error: opErr } = await admin
    .from('operators')
    .update({
      offers_pickup: parsed.data.offersPickup,
      offers_shipping: parsed.data.offersShipping,
      updated_at: new Date().toISOString(),
    } as never)
    .eq('id', meTyped.operator_id);
  if (opErr) return { ok: false, error: opErr.message };

  // Upsert operator_shipping_config when shipping is enabled. When
  // shipping is disabled we keep the row so the operator's settings
  // don't get wiped if they toggle back on; we just stop reading it.
  if (parsed.data.offersShipping && parsed.data.returnAddress) {
    const { error: cfgErr } = await admin
      .from('operator_shipping_config')
      .upsert(
        {
          operator_id: meTyped.operator_id,
          return_address: parsed.data.returnAddress,
          default_pkg_weight_oz: parsed.data.defaultPkgWeightOz ?? 16,
          default_pkg_length_in: parsed.data.defaultPkgLengthIn ?? 12.0,
          default_pkg_width_in: parsed.data.defaultPkgWidthIn ?? 9.0,
          default_pkg_height_in: parsed.data.defaultPkgHeightIn ?? 3.0,
          handling_fee_cents: parsed.data.handlingFeeCents ?? 0,
        } as never,
        { onConflict: 'operator_id' },
      );
    if (cfgErr) return { ok: false, error: cfgErr.message };
  }

  revalidatePath('/settings/fulfillment');
  revalidatePath('/settings');
  return { ok: true };
}
