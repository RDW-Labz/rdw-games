'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
// BID-3 (mig 0194): shared tier-array validation (first tier $0, strictly
// ascending, step >= $0.25; null = legacy ladder). Lives in a plain lib module
// — a 'use server' file can only export async functions — and is reused by the
// per-auction override action so both enforce identical rules.
import { bidIncrementScheduleSchema } from '@/lib/bid-increment-schedule';

const settingsSchema = z.object({
  businessName: z.string().min(1).max(200),
  legalName: z.string().max(200).nullable(),
  contactEmail: z.string().email(),
  contactPhone: z.string().max(20).nullable(),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb hex color')
    .nullable(),
  logoUrl: z.string().url().nullable(),
  defaultBuyerPremiumBps: z.number().int().min(0).max(3000),
  defaultSoftCloseMinutes: z.number().int().min(0).max(30),
  // null = use the legacy ladder. Stored as JSONB in operators.bid_increment_schedule.
  bidIncrementSchedule: bidIncrementScheduleSchema,
});

export async function saveSettings(input: z.infer<typeof settingsSchema>) {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'invalid' };

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
  if (!staff || staff.role !== 'admin') {
    return { ok: false as const, error: 'Only admins can change settings' };
  }

  const { error } = await supabase
    .from('operators')
    .update({
      business_name: parsed.data.businessName,
      legal_name: parsed.data.legalName,
      contact_email: parsed.data.contactEmail,
      contact_phone: parsed.data.contactPhone,
      logo_url: parsed.data.logoUrl,
      brand_color: parsed.data.brandColor,
      default_buyer_premium_bps: parsed.data.defaultBuyerPremiumBps,
      default_soft_close_minutes: parsed.data.defaultSoftCloseMinutes,
      // BID-3: null = legacy ladder; otherwise the validated tier array (cents).
      bid_increment_schedule: parsed.data.bidIncrementSchedule,
    })
    .eq('id', staff.operator_id);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath('/settings');
  return { ok: true as const };
}
