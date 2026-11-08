// Member Pro usage — admin/manager, READ-ONLY. Per warehouse per day for the
// last 7 days + today + the next 6 days: member slots booked vs capacity,
// large-order slots used vs the daily cap, staged orders vs the daily cap,
// inspections vs the daily cap, each with a % full and a plain "full" marker.
// Below that: members who have hit a limit this month (monthly inspections,
// or active booked slots).
//
// mig 0457 added member_slot_bookings / member_inspections as MINIMAL tables
// -- nothing writes to them in THIS PR (PRs 7/8 are the booking/inspection
// flows). So today this view reads two empty tables and shows zeros / "No
// member bookings yet" -- that's expected, not a bug. See ./aggregate.ts for
// the (database-free, unit-tested) counting rules.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { memberProSchemaReady, MEMBER_PRO_NOT_READY_MESSAGE } from '@/lib/member-pro-schema';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { DataTable, type Column } from '@/components/console';
import {
  buildWarehouseDayRows,
  buildMembersAtLimit,
  type UsageWarehouse,
  type UsageSlotBooking,
  type UsageInspection,
  type WarehouseDayRow,
  type MemberAtLimit,
} from './aggregate';

export const dynamic = 'force-dynamic';

// Matches the mig 0457 column DEFAULTs -- used only when a warehouse has no
// member_warehouse_settings row yet (same fallback the settings page's
// WAREHOUSE_DEFAULTS uses for the form).
const WAREHOUSE_SETTINGS_DEFAULTS = {
  staged_orders_per_day: 15,
  inspections_per_day: 10,
  slot_minutes: 30,
  members_per_slot: 3,
  large_orders_per_day: 2,
};

function dayLabel(offset: number): string {
  if (offset === 0) return 'Today';
  if (offset < 0) return `${Math.abs(offset)}d ago`;
  return `in ${offset}d`;
}

function usageCell(u: { used: number; capacity: number; pctFull: number; full: boolean }): string {
  return `${u.used}/${u.capacity} (${u.pctFull}%${u.full ? ' — FULL' : ''})`;
}

export default async function MemberProUsagePage() {
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

  if (role !== 'admin' && role !== 'manager') {
    return (
      <div>
        <PageHeader title="Member Pro usage" />
        <p style={{ color: 'var(--fg-muted)' }}>Admins and managers only.</p>
      </div>
    );
  }

  if (!(await memberProSchemaReady(supabase))) {
    return (
      <div>
        <PageHeader title="Member Pro usage" />
        <p style={{ color: 'var(--fg-muted)' }}>{MEMBER_PRO_NOT_READY_MESSAGE}</p>
      </div>
    );
  }

  const { data: plan } = await supabase
    .from('operator_pro_plans')
    .select('inspections_per_member_month, max_active_slots_per_member')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const inspectionsPerMemberMonth = (plan as { inspections_per_member_month: number } | null)
    ?.inspections_per_member_month ?? 4;
  const maxActiveSlotsPerMember = (plan as { max_active_slots_per_member: number } | null)
    ?.max_active_slots_per_member ?? 2;

  const { data: warehousesRaw } = await supabase
    .from('warehouses')
    .select('id, name, timezone, pickup_hours')
    .eq('operator_id', operatorId)
    .order('name');

  const { data: settingsRaw } = await supabase
    .from('member_warehouse_settings')
    .select('warehouse_id, staged_orders_per_day, inspections_per_day, slot_minutes, members_per_slot, large_orders_per_day')
    .eq('operator_id', operatorId);
  const settingsByWarehouse = new Map(
    (settingsRaw ?? []).map((s) => [s.warehouse_id as string, s as Record<string, number>]),
  );

  const warehouses: UsageWarehouse[] = (warehousesRaw ?? []).map((w) => {
    const s = settingsByWarehouse.get(w.id as string) ?? WAREHOUSE_SETTINGS_DEFAULTS;
    return {
      id: w.id as string,
      name: w.name as string,
      timezone: (w.timezone as string) ?? 'America/Chicago',
      pickupHours: (w.pickup_hours as UsageWarehouse['pickupHours']) ?? {},
      stagedOrdersPerDay: s.staged_orders_per_day,
      inspectionsPerDay: s.inspections_per_day,
      slotMinutes: s.slot_minutes,
      membersPerSlot: s.members_per_slot,
      largeOrdersPerDay: s.large_orders_per_day,
    };
  });

  const now = new Date();
  const windowStart = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000).toISOString();

  // Window query (for the per-day grid) + a separate unbounded-future /
  // whole-month query (for the "members at a limit" list, which must not
  // miss a slot booked further out, or an inspection earlier in the month,
  // than the 15-day display window).
  const [windowBookings, activeBookings, windowInspections, monthInspections] = await Promise.all([
    supabase
      .from('member_slot_bookings')
      .select('warehouse_id, bidder_id, slot_starts_at, kind, status')
      .eq('operator_id', operatorId)
      .gte('slot_starts_at', windowStart)
      .lte('slot_starts_at', windowEnd),
    supabase
      .from('member_slot_bookings')
      .select('warehouse_id, bidder_id, slot_starts_at, kind, status')
      .eq('operator_id', operatorId)
      .eq('status', 'booked')
      .gt('slot_starts_at', now.toISOString()),
    supabase
      .from('member_inspections')
      .select('warehouse_id, bidder_id, requested_for, status')
      .eq('operator_id', operatorId)
      .gte('requested_for', windowStart.slice(0, 10))
      .lte('requested_for', windowEnd.slice(0, 10)),
    supabase
      .from('member_inspections')
      .select('warehouse_id, bidder_id, requested_for, status')
      .eq('operator_id', operatorId)
      .neq('status', 'canceled')
      .gte('requested_for', `${now.toISOString().slice(0, 7)}-01`),
  ]);

  const toBookings = (rows: typeof windowBookings.data): UsageSlotBooking[] =>
    (rows ?? []).map((r) => ({
      warehouseId: r.warehouse_id as string,
      bidderId: r.bidder_id as string,
      slotStartsAt: r.slot_starts_at as string,
      kind: r.kind as 'standard' | 'large_order',
      status: r.status as string,
    }));
  const toInspections = (rows: typeof windowInspections.data): UsageInspection[] =>
    (rows ?? []).map((r) => ({
      warehouseId: r.warehouse_id as string,
      bidderId: r.bidder_id as string,
      requestedFor: r.requested_for as string,
      status: r.status as string,
    }));

  const dayRows: WarehouseDayRow[] = buildWarehouseDayRows(
    warehouses,
    toBookings(windowBookings.data),
    toInspections(windowInspections.data),
    now,
  );

  const membersAtLimit: MemberAtLimit[] = buildMembersAtLimit(
    toInspections(monthInspections.data),
    toBookings(activeBookings.data),
    inspectionsPerMemberMonth,
    maxActiveSlotsPerMember,
    now,
  );

  let memberNames = new Map<string, string>();
  if (membersAtLimit.length > 0) {
    const { data: bidders } = await supabase
      .from('bidders')
      .select('id, display_name, email')
      .in('id', membersAtLimit.map((m) => m.bidderId));
    memberNames = new Map(
      (bidders ?? []).map((b) => [b.id as string, (b.display_name as string | null) ?? (b.email as string)]),
    );
  }

  const columns: Column<WarehouseDayRow>[] = [
    { key: 'warehouse', header: 'Warehouse', cell: (r) => r.warehouseName },
    { key: 'day', header: 'Day', cell: (r) => `${r.date} (${dayLabel(r.offsetFromToday)})` },
    { key: 'slots', header: 'Member slots', cell: (r) => usageCell(r.usage.memberSlots) },
    { key: 'large', header: 'Large orders', cell: (r) => usageCell(r.usage.largeOrders) },
    { key: 'staged', header: 'Staged orders', cell: (r) => usageCell(r.usage.stagedOrders) },
    { key: 'inspections', header: 'Inspections', cell: (r) => usageCell(r.usage.inspections) },
  ];

  const limitColumns: Column<MemberAtLimit>[] = [
    { key: 'member', header: 'Member', cell: (m) => memberNames.get(m.bidderId) ?? m.bidderId },
    {
      key: 'reasons',
      header: 'Hit limit',
      cell: (m) =>
        m.reasons
          .map((r) => (r === 'inspections' ? 'Monthly inspections used up' : 'Max active booked slots'))
          .join(', '),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Member Pro usage"
        action={
          <Link href="/settings/member-pro" style={{ ...secondaryButtonStyle, textDecoration: 'none' }}>
            ← Member Pro settings
          </Link>
        }
      />
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: -8, marginBottom: '1.5rem' }}>
        Read-only. Last 7 days and next 7 days, per warehouse. Nothing here can be edited or
        charged — capacity settings live on the{' '}
        <Link href="/settings/member-pro">Member Pro settings page</Link>.
      </p>

      <h3>Capacity by day</h3>
      <DataTable
        columns={columns}
        rows={dayRows}
        rowKey={(r, i) => `${r.warehouseId}-${r.date}-${i}`}
        empty="No warehouses configured yet."
      />

      <h3 style={{ marginTop: '2rem' }}>Members at a limit</h3>
      <DataTable
        columns={limitColumns}
        rows={membersAtLimit}
        rowKey={(m) => m.bidderId}
        empty="No member bookings yet."
      />
    </div>
  );
}
