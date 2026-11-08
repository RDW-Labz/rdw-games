'use server';

// Member Pro ("Pro plan") settings — server actions for the console page.
// Writes to operator_pro_plans (plan-level settings, mig 0457) and
// member_warehouse_settings (per-warehouse capacity + slot config, mig 0457).
// No Square/billing calls here -- plans always save with active=false in
// this PR; turning a plan on is a later PR once billing exists.
//
// BinGo staff share one admin login per warehouse (see the console-shared-
// admin-login convention) -- auth.uid() alone doesn't tell you WHO made a
// change, just which shared account. Every save requires a typed staffName
// so operator_audit_log records who actually did it, not just "the admin
// account". Mirrors the reasoning in the mark-paid-offline audit log (#557).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

const staffNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter your name')
  .max(100, 'Name is too long (100 characters max)');

const planSettingsSchema = z.object({
  staffName: staffNameSchema,
  priceCents: z.number().int().min(1, 'Price must be more than $0').max(100000, 'Price must be $1,000 or less'),
  billingInterval: z.enum(['month', 'year']),
  introPriceCents: z.number().int().min(1, 'Intro price must be more than $0').max(100000, 'Intro price must be $1,000 or less'),
  introMonths: z.number().int().min(1, 'Intro months must be 1 to 24').max(24, 'Intro months must be 1 to 24'),
  introSeats: z.number().int().min(0, 'Intro seats must be 0 or more').max(1000, 'Intro seats must be 1000 or fewer'),
  memberCap: z.number().int().min(1, 'Member cap must be at least 1').max(5000, 'Member cap must be 5000 or fewer'),
  pastDueGraceDays: z.number().int().min(0, 'Grace days must be 0 or more').max(60, 'Grace days must be 60 or fewer'),
  earlyAccessMinutes: z.number().int().min(0, 'Minutes must be 0 or more').max(240, 'Minutes must be 240 or fewer'),
  extendedPickupDays: z.number().int().min(0, 'Extra pickup days must be 0 to 30').max(30, 'Extra pickup days must be 0 to 30'),
  extraGraceHours: z.number().int().min(0, 'Extra hours to pay must be 0 to 168').max(168, 'Extra hours to pay must be 0 to 168'),
  perkInspectionBeforePickup: z.boolean(),
  perkStagingAheadOfArrival: z.boolean(),
  perkScheduledPickupSlots: z.boolean(),
  perkEarlyBuildingAccess: z.boolean(),
  perkLongerPickupWindow: z.boolean(),
  perkPaymentGrace: z.boolean(),
  // Added 2026-10-26 (Jared, owner changes).
  standardPickupAllowanceQty: z.number().int().min(1, 'Must be at least 1').max(10000, 'Must be 10,000 or fewer'),
  standardPickupAllowanceUnit: z.enum(['items', 'pallets']),
  largeOrderSlotMinutes: z.number().int().min(1, 'Must be at least 1 minute').max(480, 'Must be 480 minutes or fewer'),
  largeOrderFeeEnabled: z.boolean(),
  largeOrderFeeCents: z.number().int().min(1, 'Fee must be more than $0').max(100000, 'Fee must be $1,000 or less').nullable(),
  inspectionsPerMemberMonth: z.number().int().min(1, 'Must be at least 1').max(100, 'Must be 100 or fewer'),
  maxActiveSlotsPerMember: z.number().int().min(1, 'Must be at least 1').max(50, 'Must be 50 or fewer'),
}).refine((v) => !v.largeOrderFeeEnabled || (v.largeOrderFeeCents != null && v.largeOrderFeeCents > 0), {
  message: 'Enter a fee amount, or turn the fee off',
  path: ['largeOrderFeeCents'],
});

const warehouseSettingsSchema = z.object({
  staffName: staffNameSchema,
  warehouseId: z.string().uuid(),
  stagedOrdersPerDay: z.number().int().min(1, 'Must be at least 1').max(500, 'Must be 500 or fewer'),
  inspectionsPerDay: z.number().int().min(1, 'Must be at least 1').max(500, 'Must be 500 or fewer'),
  slotMinutes: z.number().int().min(1, 'Must be at least 1 minute').max(240, 'Must be 240 minutes or fewer'),
  membersPerSlot: z.number().int().min(1, 'Must be at least 1').max(50, 'Must be 50 or fewer'),
  bookingDaysAhead: z.number().int().min(1, 'Must be at least 1 day').max(90, 'Must be 90 days or fewer'),
  changeCutoffHours: z.number().int().min(0, 'Must be 0 or more').max(168, 'Must be 168 hours or fewer'),
  // Added 2026-10-26 (Jared, owner changes).
  largeOrdersPerDay: z.number().int().min(1, 'Must be at least 1').max(100, 'Must be 100 or fewer'),
  standardPickupAllowanceQtyOverride: z.number().int().min(1, 'Must be at least 1').max(10000, 'Must be 10,000 or fewer').nullable(),
  standardPickupAllowanceUnitOverride: z.enum(['items', 'pallets']).nullable(),
});

export type MemberProActionResult = { ok: true } | { ok: false; error: string };

type Staff = { operator_id: string; role: string };

async function requireEditor(): Promise<
  | { ok: true; supabase: Awaited<ReturnType<typeof getSupabaseServer>>; userId: string; staff: Staff }
  | { ok: false; error: string }
> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in' };

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) return { ok: false, error: 'Not a staff member' };

  const staff = me as Staff;
  if (staff.role !== 'admin' && staff.role !== 'manager') {
    return { ok: false, error: 'Only admins and managers can change Member Pro settings' };
  }

  return { ok: true, supabase, userId: user.id, staff };
}

async function writeAudit(
  operatorId: string,
  actorUserId: string,
  staffName: string,
  actionType: 'member_pro.settings_updated' | 'member_pro.warehouse_settings_updated',
  targetId: string,
  beforeState: Record<string, unknown> | null,
  afterState: Record<string, unknown>,
) {
  const admin = getSupabaseAdmin();
  const { error: auditErr } = await admin.from('operator_audit_log').insert({
    operator_id: operatorId,
    actor_user_id: actorUserId,
    action_type: actionType,
    target_id: targetId,
    before_state: beforeState,
    after_state: { ...afterState, staff_name: staffName },
    reason_note: `Saved by ${staffName}`,
  } as never);
  if (auditErr) {
    console.error('[member-pro] audit insert failed', auditErr.message);
  }
}

type PlanRow = {
  id: string;
  price_cents: number;
  billing_interval: string;
  intro_price_cents: number;
  intro_months: number;
  intro_seats: number;
  member_cap: number;
  past_due_grace_days: number;
  early_access_minutes: number;
  extended_pickup_days: number;
  extra_grace_hours: number;
  perk_inspection_before_pickup: boolean;
  staging_prep: boolean;
  perk_scheduled_pickup_slots: boolean;
  perk_early_building_access: boolean;
  perk_longer_pickup_window: boolean;
  perk_payment_grace: boolean;
  standard_pickup_allowance_qty: number;
  standard_pickup_allowance_unit: 'items' | 'pallets';
  large_order_slot_minutes: number;
  large_order_fee_enabled: boolean;
  large_order_fee_cents: number | null;
  inspections_per_member_month: number;
  max_active_slots_per_member: number;
  active: boolean;
};

/**
 * Plans stay OFF in this PR -- there is no path here (or anywhere in the
 * console yet) that sets active=true. `active` is read but never written.
 */
export async function saveMemberProPlanSettings(
  input: z.infer<typeof planSettingsSchema>,
): Promise<MemberProActionResult> {
  const parsed = planSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const auth = await requireEditor();
  if (!auth.ok) return auth;

  const patch = {
    price_cents: parsed.data.priceCents,
    billing_interval: parsed.data.billingInterval,
    intro_price_cents: parsed.data.introPriceCents,
    intro_months: parsed.data.introMonths,
    intro_seats: parsed.data.introSeats,
    member_cap: parsed.data.memberCap,
    past_due_grace_days: parsed.data.pastDueGraceDays,
    early_access_minutes: parsed.data.earlyAccessMinutes,
    extended_pickup_days: parsed.data.extendedPickupDays,
    extra_grace_hours: parsed.data.extraGraceHours,
    perk_inspection_before_pickup: parsed.data.perkInspectionBeforePickup,
    staging_prep: parsed.data.perkStagingAheadOfArrival,
    perk_scheduled_pickup_slots: parsed.data.perkScheduledPickupSlots,
    perk_early_building_access: parsed.data.perkEarlyBuildingAccess,
    perk_longer_pickup_window: parsed.data.perkLongerPickupWindow,
    perk_payment_grace: parsed.data.perkPaymentGrace,
    standard_pickup_allowance_qty: parsed.data.standardPickupAllowanceQty,
    standard_pickup_allowance_unit: parsed.data.standardPickupAllowanceUnit,
    large_order_slot_minutes: parsed.data.largeOrderSlotMinutes,
    large_order_fee_enabled: parsed.data.largeOrderFeeEnabled,
    large_order_fee_cents: parsed.data.largeOrderFeeEnabled ? parsed.data.largeOrderFeeCents : null,
    inspections_per_member_month: parsed.data.inspectionsPerMemberMonth,
    max_active_slots_per_member: parsed.data.maxActiveSlotsPerMember,
  };

  const { data: existing, error: fetchErr } = await auth.supabase
    .from('operator_pro_plans')
    .select(
      'id, price_cents, billing_interval, intro_price_cents, intro_months, intro_seats, member_cap, past_due_grace_days, early_access_minutes, extended_pickup_days, extra_grace_hours, perk_inspection_before_pickup, staging_prep, perk_scheduled_pickup_slots, perk_early_building_access, perk_longer_pickup_window, perk_payment_grace, standard_pickup_allowance_qty, standard_pickup_allowance_unit, large_order_slot_minutes, large_order_fee_enabled, large_order_fee_cents, inspections_per_member_month, max_active_slots_per_member, active',
    )
    .eq('operator_id', auth.staff.operator_id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (fetchErr) return { ok: false, error: fetchErr.message };

  let id: string;
  if (existing) {
    const before = existing as PlanRow;
    const { data: updated, error: updateErr } = await auth.supabase
      .from('operator_pro_plans')
      .update(patch as never)
      .eq('id', before.id)
      .eq('operator_id', auth.staff.operator_id)
      .select('id')
      .maybeSingle();
    if (updateErr) return { ok: false, error: updateErr.message };
    if (!updated) return { ok: false, error: 'Plan not found' };
    id = (updated as { id: string }).id;
    await writeAudit(
      auth.staff.operator_id,
      auth.userId,
      parsed.data.staffName,
      'member_pro.settings_updated',
      id,
      { ...before },
      patch,
    );
  } else {
    const row = { operator_id: auth.staff.operator_id, name: 'Pro', active: false, ...patch };
    const { data: created, error: insertErr } = await auth.supabase
      .from('operator_pro_plans')
      .insert(row as never)
      .select('id')
      .single();
    if (insertErr || !created) {
      return { ok: false, error: insertErr?.message ?? 'Could not create plan' };
    }
    id = (created as { id: string }).id;
    await writeAudit(
      auth.staff.operator_id,
      auth.userId,
      parsed.data.staffName,
      'member_pro.settings_updated',
      id,
      null,
      { ...patch, active: false },
    );
  }

  revalidatePath('/settings/member-pro');
  return { ok: true };
}

type WarehouseSettingsRow = {
  id: string;
  staged_orders_per_day: number;
  inspections_per_day: number;
  slot_minutes: number;
  members_per_slot: number;
  booking_days_ahead: number;
  change_cutoff_hours: number;
  large_orders_per_day: number;
  standard_pickup_allowance_qty_override: number | null;
  standard_pickup_allowance_unit_override: 'items' | 'pallets' | null;
};

export async function saveMemberProWarehouseSettings(
  input: z.infer<typeof warehouseSettingsSchema>,
): Promise<MemberProActionResult> {
  const parsed = warehouseSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const auth = await requireEditor();
  if (!auth.ok) return auth;

  // Confirm the warehouse actually belongs to this operator before touching
  // member_warehouse_settings -- the DB trigger guard would also catch a
  // mismatch, but failing here gives a clean error message instead of a raw
  // SQLSTATE P0001.
  const { data: warehouse, error: whErr } = await auth.supabase
    .from('warehouses')
    .select('id')
    .eq('id', parsed.data.warehouseId)
    .eq('operator_id', auth.staff.operator_id)
    .maybeSingle();
  if (whErr) return { ok: false, error: whErr.message };
  if (!warehouse) return { ok: false, error: 'Warehouse not found' };

  const patch = {
    staged_orders_per_day: parsed.data.stagedOrdersPerDay,
    inspections_per_day: parsed.data.inspectionsPerDay,
    slot_minutes: parsed.data.slotMinutes,
    members_per_slot: parsed.data.membersPerSlot,
    booking_days_ahead: parsed.data.bookingDaysAhead,
    change_cutoff_hours: parsed.data.changeCutoffHours,
    large_orders_per_day: parsed.data.largeOrdersPerDay,
    standard_pickup_allowance_qty_override: parsed.data.standardPickupAllowanceQtyOverride,
    standard_pickup_allowance_unit_override: parsed.data.standardPickupAllowanceUnitOverride,
  };

  const { data: existing, error: fetchErr } = await auth.supabase
    .from('member_warehouse_settings')
    .select('id, staged_orders_per_day, inspections_per_day, slot_minutes, members_per_slot, booking_days_ahead, change_cutoff_hours, large_orders_per_day, standard_pickup_allowance_qty_override, standard_pickup_allowance_unit_override')
    .eq('operator_id', auth.staff.operator_id)
    .eq('warehouse_id', parsed.data.warehouseId)
    .maybeSingle();
  if (fetchErr) return { ok: false, error: fetchErr.message };

  let id: string;
  if (existing) {
    const before = existing as WarehouseSettingsRow;
    const { data: updated, error: updateErr } = await auth.supabase
      .from('member_warehouse_settings')
      .update(patch as never)
      .eq('id', before.id)
      .select('id')
      .maybeSingle();
    if (updateErr) return { ok: false, error: updateErr.message };
    if (!updated) return { ok: false, error: 'Settings not found' };
    id = (updated as { id: string }).id;
    await writeAudit(
      auth.staff.operator_id,
      auth.userId,
      parsed.data.staffName,
      'member_pro.warehouse_settings_updated',
      id,
      { ...before },
      { ...patch, warehouse_id: parsed.data.warehouseId },
    );
  } else {
    const row = {
      operator_id: auth.staff.operator_id,
      warehouse_id: parsed.data.warehouseId,
      ...patch,
    };
    const { data: created, error: insertErr } = await auth.supabase
      .from('member_warehouse_settings')
      .insert(row as never)
      .select('id')
      .single();
    if (insertErr || !created) {
      return { ok: false, error: insertErr?.message ?? 'Could not create settings' };
    }
    id = (created as { id: string }).id;
    await writeAudit(
      auth.staff.operator_id,
      auth.userId,
      parsed.data.staffName,
      'member_pro.warehouse_settings_updated',
      id,
      null,
      { ...patch, warehouse_id: parsed.data.warehouseId },
    );
  }

  revalidatePath('/settings/member-pro');
  return { ok: true };
}
