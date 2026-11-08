// Member Pro settings — plan pricing/perks + per-warehouse capacity (staff
// only). Plans created/edited here start OFF: no customer can see or buy a
// plan until billing through Square is built and a plan is turned on in a
// later release (this page has no control that can set active=true).

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { memberProSchemaReady, MEMBER_PRO_NOT_READY_MESSAGE } from '@/lib/member-pro-schema';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { MemberProForm } from './MemberProForm';

export default async function MemberProSettingsPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  const operatorId = (me as { operator_id: string }).operator_id;
  const role = (me as { role: string }).role;

  if (!(await memberProSchemaReady(supabase))) {
    return (
      <div>
        <PageHeader title="Member Pro" />
        <p style={{ color: 'var(--fg-muted)' }}>{MEMBER_PRO_NOT_READY_MESSAGE}</p>
      </div>
    );
  }

  const { data: plan } = await supabase
    .from('operator_pro_plans')
    .select(
      'id, price_cents, billing_interval, intro_price_cents, intro_months, intro_seats, member_cap, past_due_grace_days, early_access_minutes, extended_pickup_days, extra_grace_hours, perk_inspection_before_pickup, staging_prep, perk_scheduled_pickup_slots, perk_early_building_access, perk_longer_pickup_window, perk_payment_grace, standard_pickup_allowance_qty, standard_pickup_allowance_unit, large_order_slot_minutes, large_order_fee_enabled, large_order_fee_cents, inspections_per_member_month, max_active_slots_per_member, active, updated_at',
    )
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const { data: warehouses } = await supabase
    .from('warehouses')
    .select('id, name')
    .eq('operator_id', operatorId)
    .order('name');

  const { data: warehouseSettings } = await supabase
    .from('member_warehouse_settings')
    .select('id, warehouse_id, staged_orders_per_day, inspections_per_day, slot_minutes, members_per_slot, booking_days_ahead, change_cutoff_hours, large_orders_per_day, standard_pickup_allowance_qty_override, standard_pickup_allowance_unit_override, updated_at')
    .eq('operator_id', operatorId);

  const settingsByWarehouse = new Map(
    (warehouseSettings ?? []).map((s) => [s.warehouse_id as string, s]),
  );

  return (
    <div>
      <PageHeader
        title="Member Pro"
        action={
          <Link href="/settings" style={{ ...secondaryButtonStyle, textDecoration: 'none' }}>
            ← Settings
          </Link>
        }
      />
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: -8, marginBottom: '1.5rem' }}>
        Member Pro is a paid membership your bidders can join for perks like item
        inspection before pickup, staging ahead of arrival, and scheduled pickup
        slots. Settings you save here start OFF: no customer can see or buy a
        plan until billing is built and a plan is turned on in a later release.
      </p>
      <p style={{ marginTop: -8, marginBottom: '1.5rem' }}>
        <Link href="/settings/member-pro/usage">See today&apos;s capacity usage →</Link>
      </p>
      <MemberProForm
        canEdit={role === 'admin' || role === 'manager'}
        plan={
          plan
            ? {
                id: plan.id as string,
                priceCents: plan.price_cents as number,
                billingInterval: plan.billing_interval as 'month' | 'year',
                introPriceCents: plan.intro_price_cents as number,
                introMonths: plan.intro_months as number,
                introSeats: plan.intro_seats as number,
                memberCap: plan.member_cap as number,
                pastDueGraceDays: plan.past_due_grace_days as number,
                earlyAccessMinutes: plan.early_access_minutes as number,
                extendedPickupDays: plan.extended_pickup_days as number,
                extraGraceHours: plan.extra_grace_hours as number,
                perkInspectionBeforePickup: plan.perk_inspection_before_pickup as boolean,
                perkStagingAheadOfArrival: plan.staging_prep as boolean,
                perkScheduledPickupSlots: plan.perk_scheduled_pickup_slots as boolean,
                perkEarlyBuildingAccess: plan.perk_early_building_access as boolean,
                perkLongerPickupWindow: plan.perk_longer_pickup_window as boolean,
                perkPaymentGrace: plan.perk_payment_grace as boolean,
                standardPickupAllowanceQty: plan.standard_pickup_allowance_qty as number,
                standardPickupAllowanceUnit: plan.standard_pickup_allowance_unit as 'items' | 'pallets',
                largeOrderSlotMinutes: plan.large_order_slot_minutes as number,
                largeOrderFeeEnabled: plan.large_order_fee_enabled as boolean,
                largeOrderFeeCents: plan.large_order_fee_cents as number | null,
                inspectionsPerMemberMonth: plan.inspections_per_member_month as number,
                maxActiveSlotsPerMember: plan.max_active_slots_per_member as number,
                active: plan.active as boolean,
              }
            : null
        }
        warehouses={(warehouses ?? []).map((w) => {
          const s = settingsByWarehouse.get(w.id as string);
          return {
            id: w.id as string,
            name: w.name as string,
            settings: s
              ? {
                  stagedOrdersPerDay: s.staged_orders_per_day as number,
                  inspectionsPerDay: s.inspections_per_day as number,
                  slotMinutes: s.slot_minutes as number,
                  membersPerSlot: s.members_per_slot as number,
                  bookingDaysAhead: s.booking_days_ahead as number,
                  changeCutoffHours: s.change_cutoff_hours as number,
                  largeOrdersPerDay: s.large_orders_per_day as number,
                  standardPickupAllowanceQtyOverride: s.standard_pickup_allowance_qty_override as number | null,
                  standardPickupAllowanceUnitOverride: s.standard_pickup_allowance_unit_override as 'items' | 'pallets' | null,
                }
              : null,
          };
        })}
      />
    </div>
  );
}
