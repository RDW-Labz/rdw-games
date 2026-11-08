// Dashboard server actions.

'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServer } from '@/lib/supabase-server';

/**
 * Mark Stripe Tax as acknowledged for the calling user's operator.
 *
 * Path A topology (LAUNCH_PLAN §2.1) makes the operator the legal
 * merchant of record for sales tax. They're responsible for either
 * enabling Stripe Tax on their connected Stripe account OR handling
 * sales-tax filing themselves. This action just records the
 * acknowledgement — we don't verify Stripe Tax is actually enabled.
 *
 * Accepts FormData (and ignores it) so it can be used directly as the
 * `<form action={...}>` attribute. Non-admin or unauthenticated calls
 * are silently no-ops (the page-level guards already block them; this
 * is defense-in-depth).
 */
export async function acknowledgeStripeTax(_formData: FormData): Promise<void> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff?.operator_id || staff.role !== 'admin') return;

  await supabase
    .from('operators')
    .update({ stripe_tax_acknowledged_at: new Date().toISOString() })
    .eq('id', staff.operator_id);

  revalidatePath('/dashboard');
  revalidatePath('/settings/stripe-tax');
}
