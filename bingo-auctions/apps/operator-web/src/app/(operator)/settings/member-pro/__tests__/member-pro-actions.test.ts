// Member Pro settings server actions — validation, role gate, audit logging,
// typed staff-name requirement. Mirrors the mocking pattern in
// settings/pro-plan/__tests__/pro-plan-actions.test.ts (PR #521).

import { describe, it, expect, vi, beforeEach } from 'vitest';

type PlanRow = {
  id: string;
  operator_id: string;
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

type WarehouseSettingsRow = {
  id: string;
  operator_id: string;
  warehouse_id: string;
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

const state = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  role: 'admin' as string,
  operatorId: 'op-1',
  plans: [] as PlanRow[],
  warehouseSettings: [] as WarehouseSettingsRow[],
  warehouses: [{ id: '00000000-0000-0000-0000-000000000b01', operator_id: 'op-1' }] as { id: string; operator_id: string }[],
  userInserts: {} as Record<string, Record<string, unknown>[]>,
  userUpdates: {} as Record<string, Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }>>,
  adminInserts: [] as Record<string, unknown>[],
  adminOtherOps: 0,
  auditInsertError: null as string | null,
  updateReturnsRow: true,
}));

function matchFilters(row: Record<string, unknown>, filters: Record<string, unknown>) {
  return Object.entries(filters).every(([k, v]) => row[k] === v);
}

function tableArray(table: string): Record<string, unknown>[] {
  if (table === 'operator_pro_plans') return state.plans as unknown as Record<string, unknown>[];
  if (table === 'member_warehouse_settings') return state.warehouseSettings as unknown as Record<string, unknown>[];
  if (table === 'warehouses') return state.warehouses as unknown as Record<string, unknown>[];
  return [];
}

function userClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
    },
    from(table: string) {
      let op: 'select' | 'insert' | 'update' = 'select';
      const filters: Record<string, unknown> = {};
      let insertRow: Record<string, unknown> | null = null;
      let patch: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};

      b.select = () => b;
      b.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return b;
      };
      b.order = () => b;
      b.limit = () => b;
      b.insert = (row: Record<string, unknown>) => {
        op = 'insert';
        insertRow = row;
        return b;
      };
      b.update = (p: Record<string, unknown>) => {
        op = 'update';
        patch = p;
        return b;
      };
      b.single = async () => {
        if (table === 'operator_users') {
          if (!state.user) return { data: null, error: null };
          return { data: { operator_id: state.operatorId, role: state.role }, error: null };
        }
        if (op === 'insert' && insertRow) {
          const id = `${table}-${tableArray(table).length + 1}`;
          const row = { id, ...insertRow } as Record<string, unknown>;
          tableArray(table).push(row);
          state.userInserts[table] ??= [];
          state.userInserts[table]!.push(insertRow);
          return { data: { id }, error: null };
        }
        return { data: null, error: null };
      };
      b.maybeSingle = async () => {
        if (table === 'operator_users') {
          if (!state.user) return { data: null, error: null };
          return { data: { operator_id: state.operatorId, role: state.role }, error: null };
        }
        const rows = tableArray(table);
        if (op === 'select') {
          const row = rows.find((r) => matchFilters(r, filters));
          return { data: row ?? null, error: null };
        }
        if (op === 'update') {
          state.userUpdates[table] ??= [];
          state.userUpdates[table]!.push({ patch, filters: { ...filters } });
          const idx = rows.findIndex((r) => matchFilters(r, filters));
          if (idx < 0 || !state.updateReturnsRow) return { data: null, error: null };
          rows[idx] = { ...rows[idx], ...patch };
          return { data: { id: rows[idx]!.id }, error: null };
        }
        return { data: null, error: null };
      };

      return b;
    },
  };
}

function adminClient() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      b.insert = async (row: Record<string, unknown> | Record<string, unknown>[]) => {
        if (table !== 'operator_audit_log') {
          state.adminOtherOps++;
          return { error: { message: 'unexpected admin write' } };
        }
        const rows = Array.isArray(row) ? row : [row];
        state.adminInserts.push(...rows);
        if (state.auditInsertError) {
          return { error: { message: state.auditInsertError } };
        }
        return { error: null };
      };
      return b;
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ getSupabaseServer: async () => userClient() }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => adminClient() }));

import { saveMemberProPlanSettings, saveMemberProWarehouseSettings } from '../actions';

const PLAN_ID = 'operator_pro_plans-1';

const validPlanInput = {
  staffName: 'Braden',
  priceCents: 10000,
  billingInterval: 'month' as const,
  introPriceCents: 5000,
  introMonths: 6,
  introSeats: 30,
  memberCap: 30,
  pastDueGraceDays: 7,
  earlyAccessMinutes: 15,
  extendedPickupDays: 0,
  extraGraceHours: 0,
  perkInspectionBeforePickup: true,
  perkStagingAheadOfArrival: true,
  perkScheduledPickupSlots: true,
  perkEarlyBuildingAccess: true,
  perkLongerPickupWindow: true,
  perkPaymentGrace: true,
  standardPickupAllowanceQty: 10,
  standardPickupAllowanceUnit: 'items' as const,
  largeOrderSlotMinutes: 60,
  largeOrderFeeEnabled: false,
  largeOrderFeeCents: null,
  inspectionsPerMemberMonth: 4,
  maxActiveSlotsPerMember: 2,
};

const validWarehouseInput = {
  staffName: 'Braden',
  warehouseId: '00000000-0000-0000-0000-000000000b01',
  stagedOrdersPerDay: 15,
  inspectionsPerDay: 10,
  slotMinutes: 30,
  membersPerSlot: 3,
  bookingDaysAhead: 7,
  changeCutoffHours: 2,
  largeOrdersPerDay: 2,
  standardPickupAllowanceQtyOverride: null,
  standardPickupAllowanceUnitOverride: null,
};

beforeEach(() => {
  state.user = { id: 'user-1' };
  state.role = 'admin';
  state.operatorId = 'op-1';
  state.plans = [];
  state.warehouseSettings = [];
  state.warehouses = [{ id: '00000000-0000-0000-0000-000000000b01', operator_id: 'op-1' }];
  state.userInserts = {};
  state.userUpdates = {};
  state.adminInserts = [];
  state.adminOtherOps = 0;
  state.auditInsertError = null;
  state.updateReturnsRow = true;
});

describe('saveMemberProPlanSettings', () => {
  it('creates a new plan with active:false and audits, even with no existing row', async () => {
    const r = await saveMemberProPlanSettings(validPlanInput);
    expect(r).toEqual({ ok: true });
    expect(state.userInserts['operator_pro_plans']).toHaveLength(1);
    const inserted = state.userInserts['operator_pro_plans']![0]!;
    expect(inserted).toMatchObject({
      operator_id: 'op-1',
      name: 'Pro',
      active: false,
      price_cents: 10000,
      billing_interval: 'month',
      intro_price_cents: 5000,
      member_cap: 30,
    });
    expect(state.adminInserts).toHaveLength(1);
    expect(state.adminInserts[0]).toMatchObject({
      action_type: 'member_pro.settings_updated',
      operator_id: 'op-1',
      actor_user_id: 'user-1',
      before_state: null,
    });
    expect((state.adminInserts[0]!.after_state as Record<string, unknown>).staff_name).toBe('Braden');
    expect(state.adminInserts[0]!.reason_note).toBe('Saved by Braden');
  });

  it('updates the existing plan row scoped by operator_id, never setting active', async () => {
    state.plans = [
      {
        id: PLAN_ID,
        operator_id: 'op-1',
        price_cents: 10000,
        billing_interval: 'month',
        intro_price_cents: 5000,
        intro_months: 6,
        intro_seats: 30,
        member_cap: 30,
        past_due_grace_days: 7,
        early_access_minutes: 15,
        extended_pickup_days: 0,
        extra_grace_hours: 0,
        perk_inspection_before_pickup: true,
        staging_prep: true,
        perk_scheduled_pickup_slots: true,
        perk_early_building_access: true,
        perk_longer_pickup_window: true,
        perk_payment_grace: true,
        standard_pickup_allowance_qty: 10,
        standard_pickup_allowance_unit: 'items',
        large_order_slot_minutes: 60,
        large_order_fee_enabled: false,
        large_order_fee_cents: null,
        inspections_per_member_month: 4,
        max_active_slots_per_member: 2,
        active: false,
      },
    ];
    const r = await saveMemberProPlanSettings({ ...validPlanInput, memberCap: 20 });
    expect(r).toEqual({ ok: true });
    const upd = state.userUpdates['operator_pro_plans']![0]!;
    expect(upd.patch).not.toHaveProperty('active');
    expect(upd.patch).toMatchObject({ member_cap: 20 });
    expect(upd.filters).toEqual({ id: PLAN_ID, operator_id: 'op-1' });
    expect(state.adminInserts[0]).toMatchObject({ action_type: 'member_pro.settings_updated' });
  });

  it('requires a typed staff name', async () => {
    const r = await saveMemberProPlanSettings({ ...validPlanInput, staffName: '   ' });
    expect(r).toEqual({ ok: false, error: 'Enter your name' });
    expect(state.userInserts['operator_pro_plans']).toBeUndefined();
  });

  it('rejects out-of-range values without writes', async () => {
    expect(await saveMemberProPlanSettings({ ...validPlanInput, priceCents: 0 })).toEqual({
      ok: false,
      error: 'Price must be more than $0',
    });
    expect(await saveMemberProPlanSettings({ ...validPlanInput, memberCap: 0 })).toEqual({
      ok: false,
      error: 'Member cap must be at least 1',
    });
    expect(await saveMemberProPlanSettings({ ...validPlanInput, billingInterval: 'week' as never })).toMatchObject({
      ok: false,
    });
    expect(state.userInserts['operator_pro_plans']).toBeUndefined();
    expect(state.adminInserts).toEqual([]);
  });

  it('refuses picker role with no write', async () => {
    state.role = 'picker';
    const r = await saveMemberProPlanSettings(validPlanInput);
    expect(r).toEqual({ ok: false, error: 'Only admins and managers can change Member Pro settings' });
    expect(state.userInserts['operator_pro_plans']).toBeUndefined();
    expect(state.adminInserts).toEqual([]);
  });

  it('refuses when not signed in', async () => {
    state.user = null;
    const r = await saveMemberProPlanSettings(validPlanInput);
    expect(r).toEqual({ ok: false, error: 'Not signed in' });
  });

  it('requires a fee amount when the large-order fee is turned on', async () => {
    const r = await saveMemberProPlanSettings({
      ...validPlanInput,
      largeOrderFeeEnabled: true,
      largeOrderFeeCents: null,
    });
    expect(r).toEqual({ ok: false, error: 'Enter a fee amount, or turn the fee off' });
    expect(state.userInserts['operator_pro_plans']).toBeUndefined();
  });

  it('accepts a positive fee amount when the fee is turned on, and nulls it when off', async () => {
    const onResult = await saveMemberProPlanSettings({
      ...validPlanInput,
      largeOrderFeeEnabled: true,
      largeOrderFeeCents: 2500,
    });
    expect(onResult).toEqual({ ok: true });
    expect(state.userInserts['operator_pro_plans']![0]).toMatchObject({
      large_order_fee_enabled: true,
      large_order_fee_cents: 2500,
    });

    state.plans = [];
    state.userInserts = {};
    const offResult = await saveMemberProPlanSettings({
      ...validPlanInput,
      largeOrderFeeEnabled: false,
      largeOrderFeeCents: 2500, // ignored/nulled when the switch is off
    });
    expect(offResult).toEqual({ ok: true });
    expect(state.userInserts['operator_pro_plans']![0]).toMatchObject({
      large_order_fee_enabled: false,
      large_order_fee_cents: null,
    });
  });

  it('still returns ok when the audit insert fails (log-and-continue)', async () => {
    state.auditInsertError = 'audit down';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await saveMemberProPlanSettings(validPlanInput);
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith('[member-pro] audit insert failed', 'audit down');
    spy.mockRestore();
  });
});

describe('saveMemberProWarehouseSettings', () => {
  it('creates settings for a warehouse that belongs to the operator', async () => {
    const r = await saveMemberProWarehouseSettings(validWarehouseInput);
    expect(r).toEqual({ ok: true });
    expect(state.userInserts['member_warehouse_settings']).toHaveLength(1);
    expect(state.userInserts['member_warehouse_settings']![0]).toMatchObject({
      operator_id: 'op-1',
      warehouse_id: '00000000-0000-0000-0000-000000000b01',
      staged_orders_per_day: 15,
    });
    expect(state.adminInserts[0]).toMatchObject({ action_type: 'member_pro.warehouse_settings_updated' });
  });

  it('refuses a warehouse belonging to another operator', async () => {
    state.warehouses = [{ id: '00000000-0000-0000-0000-000000000b01', operator_id: 'op-OTHER' }];
    const r = await saveMemberProWarehouseSettings(validWarehouseInput);
    expect(r).toEqual({ ok: false, error: 'Warehouse not found' });
    expect(state.userInserts['member_warehouse_settings']).toBeUndefined();
  });

  it('updates an existing warehouse settings row', async () => {
    state.warehouseSettings = [
      {
        id: 'mws-1',
        operator_id: 'op-1',
        warehouse_id: '00000000-0000-0000-0000-000000000b01',
        staged_orders_per_day: 15,
        inspections_per_day: 10,
        slot_minutes: 30,
        members_per_slot: 3,
        booking_days_ahead: 7,
        change_cutoff_hours: 2,
        large_orders_per_day: 2,
        standard_pickup_allowance_qty_override: null,
        standard_pickup_allowance_unit_override: null,
      },
    ];
    const r = await saveMemberProWarehouseSettings({ ...validWarehouseInput, inspectionsPerDay: 20 });
    expect(r).toEqual({ ok: true });
    const upd = state.userUpdates['member_warehouse_settings']![0]!;
    expect(upd.patch).toMatchObject({ inspections_per_day: 20 });
    expect(upd.filters).toEqual({ id: 'mws-1' });
  });

  it('requires a typed staff name', async () => {
    const r = await saveMemberProWarehouseSettings({ ...validWarehouseInput, staffName: '' });
    expect(r).toEqual({ ok: false, error: 'Enter your name' });
  });

  it('rejects out-of-range values', async () => {
    expect(await saveMemberProWarehouseSettings({ ...validWarehouseInput, slotMinutes: 0 })).toEqual({
      ok: false,
      error: 'Must be at least 1 minute',
    });
  });

  it('refuses picker role', async () => {
    state.role = 'picker';
    const r = await saveMemberProWarehouseSettings(validWarehouseInput);
    expect(r).toEqual({ ok: false, error: 'Only admins and managers can change Member Pro settings' });
  });

  it('saves a per-warehouse pickup allowance override alongside large_orders_per_day', async () => {
    const r = await saveMemberProWarehouseSettings({
      ...validWarehouseInput,
      largeOrdersPerDay: 5,
      standardPickupAllowanceQtyOverride: 3,
      standardPickupAllowanceUnitOverride: 'pallets',
    });
    expect(r).toEqual({ ok: true });
    expect(state.userInserts['member_warehouse_settings']![0]).toMatchObject({
      large_orders_per_day: 5,
      standard_pickup_allowance_qty_override: 3,
      standard_pickup_allowance_unit_override: 'pallets',
    });
  });
});
