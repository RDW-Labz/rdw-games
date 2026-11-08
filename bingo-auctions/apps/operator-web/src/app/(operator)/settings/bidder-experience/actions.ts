'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import {
  FEATURE_CATALOG,
  type BidderFeatures,
  type FeatureKey,
  type FlagValue,
} from '@auction-platform/shared/features';

const VALID_VALUES: FlagValue[] = ['off', 'all', 'pro'];
const VALID_KEYS: FeatureKey[] = FEATURE_CATALOG.map((f) => f.key);

export async function saveBidderFeatures(input: BidderFeatures) {
  // Hard sanitize: drop unknown keys, drop bad values. Operator-supplied
  // input writes into a JSONB column, so we belt-and-braces validate.
  const cleaned: BidderFeatures = {};
  for (const k of VALID_KEYS) {
    const v = input[k];
    if (v && VALID_VALUES.includes(v)) cleaned[k] = v;
    else cleaned[k] = 'off';
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated' };

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false as const, error: 'Not an operator' };
  if (staff.role !== 'admin') return { ok: false as const, error: 'Admin only' };

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('operators')
    .update({ bidder_features: cleaned })
    .eq('id', staff.operator_id as string);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath('/settings/bidder-experience');
  return { ok: true as const };
}
