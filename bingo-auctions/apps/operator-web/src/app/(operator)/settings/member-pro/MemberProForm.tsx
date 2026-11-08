'use client';

import { useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { dollarsToCents, formatCents } from '@auction-platform/shared';
import { Field, buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import { saveMemberProPlanSettings, saveMemberProWarehouseSettings } from './actions';

export type MemberProPlan = {
  id: string;
  priceCents: number;
  billingInterval: 'month' | 'year';
  introPriceCents: number;
  introMonths: number;
  introSeats: number;
  memberCap: number;
  pastDueGraceDays: number;
  earlyAccessMinutes: number;
  extendedPickupDays: number;
  extraGraceHours: number;
  perkInspectionBeforePickup: boolean;
  perkStagingAheadOfArrival: boolean;
  perkScheduledPickupSlots: boolean;
  perkEarlyBuildingAccess: boolean;
  perkLongerPickupWindow: boolean;
  perkPaymentGrace: boolean;
  standardPickupAllowanceQty: number;
  standardPickupAllowanceUnit: 'items' | 'pallets';
  largeOrderSlotMinutes: number;
  largeOrderFeeEnabled: boolean;
  largeOrderFeeCents: number | null;
  inspectionsPerMemberMonth: number;
  maxActiveSlotsPerMember: number;
  active: boolean;
};

export type WarehouseRow = {
  id: string;
  name: string;
  settings: {
    stagedOrdersPerDay: number;
    inspectionsPerDay: number;
    slotMinutes: number;
    membersPerSlot: number;
    bookingDaysAhead: number;
    changeCutoffHours: number;
    largeOrdersPerDay: number;
    standardPickupAllowanceQtyOverride: number | null;
    standardPickupAllowanceUnitOverride: 'items' | 'pallets' | null;
  } | null;
};

const PLAN_DEFAULTS = {
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
  // Defaults for the 2026-10-26 (Jared) additions.
  standardPickupAllowanceQty: 10,
  standardPickupAllowanceUnit: 'items' as const,
  largeOrderSlotMinutes: 60,
  largeOrderFeeEnabled: false,
  largeOrderFeeCents: null as number | null,
  inspectionsPerMemberMonth: 4,
  maxActiveSlotsPerMember: 2,
};

const WAREHOUSE_DEFAULTS = {
  stagedOrdersPerDay: 15,
  inspectionsPerDay: 10,
  slotMinutes: 30,
  membersPerSlot: 3,
  bookingDaysAhead: 7,
  changeCutoffHours: 2,
  largeOrdersPerDay: 2,
  standardPickupAllowanceQtyOverride: null as number | null,
  standardPickupAllowanceUnitOverride: null as 'items' | 'pallets' | null,
};

const cardStyle: CSSProperties = {
  padding: '1.25rem',
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  marginBottom: '1.5rem',
};

const checkboxRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: 14 };

export function MemberProForm({
  canEdit,
  plan,
  warehouses,
}: {
  canEdit: boolean;
  plan: MemberProPlan | null;
  warehouses: WarehouseRow[];
}) {
  const router = useRouter();
  const [staffName, setStaffName] = useState('');

  const base = plan ?? { ...PLAN_DEFAULTS, id: '', active: false };
  const [priceDollars, setPriceDollars] = useState((base.priceCents / 100).toFixed(2));
  const [billingInterval, setBillingInterval] = useState<'month' | 'year'>(base.billingInterval);
  const [introPriceDollars, setIntroPriceDollars] = useState((base.introPriceCents / 100).toFixed(2));
  const [introMonths, setIntroMonths] = useState(String(base.introMonths));
  const [introSeats, setIntroSeats] = useState(String(base.introSeats));
  const [memberCap, setMemberCap] = useState(String(base.memberCap));
  const [pastDueGraceDays, setPastDueGraceDays] = useState(String(base.pastDueGraceDays));
  const [earlyAccessMinutes, setEarlyAccessMinutes] = useState(String(base.earlyAccessMinutes));
  const [extendedPickupDays, setExtendedPickupDays] = useState(String(base.extendedPickupDays));
  const [extraGraceHours, setExtraGraceHours] = useState(String(base.extraGraceHours));
  const [perkInspectionBeforePickup, setPerkInspectionBeforePickup] = useState(base.perkInspectionBeforePickup);
  const [perkStagingAheadOfArrival, setPerkStagingAheadOfArrival] = useState(base.perkStagingAheadOfArrival);
  const [perkScheduledPickupSlots, setPerkScheduledPickupSlots] = useState(base.perkScheduledPickupSlots);
  const [perkEarlyBuildingAccess, setPerkEarlyBuildingAccess] = useState(base.perkEarlyBuildingAccess);
  const [perkLongerPickupWindow, setPerkLongerPickupWindow] = useState(base.perkLongerPickupWindow);
  const [perkPaymentGrace, setPerkPaymentGrace] = useState(base.perkPaymentGrace);
  const [standardPickupAllowanceQty, setStandardPickupAllowanceQty] = useState(String(base.standardPickupAllowanceQty));
  const [standardPickupAllowanceUnit, setStandardPickupAllowanceUnit] = useState<'items' | 'pallets'>(
    base.standardPickupAllowanceUnit,
  );
  const [largeOrderSlotMinutes, setLargeOrderSlotMinutes] = useState(String(base.largeOrderSlotMinutes));
  const [largeOrderFeeEnabled, setLargeOrderFeeEnabled] = useState(base.largeOrderFeeEnabled);
  const [largeOrderFeeDollars, setLargeOrderFeeDollars] = useState(
    base.largeOrderFeeCents != null ? (base.largeOrderFeeCents / 100).toFixed(2) : '',
  );
  const [inspectionsPerMemberMonth, setInspectionsPerMemberMonth] = useState(String(base.inspectionsPerMemberMonth));
  const [maxActiveSlotsPerMember, setMaxActiveSlotsPerMember] = useState(String(base.maxActiveSlotsPerMember));

  const [savingPlan, setSavingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planSavedAt, setPlanSavedAt] = useState<Date | null>(null);

  const disabled = !canEdit;

  async function onSavePlan() {
    setPlanError(null);
    if (!staffName.trim()) {
      setPlanError('Enter your name before saving (recorded in the audit log)');
      return;
    }
    let priceCents: number;
    let introPriceCents: number;
    let largeOrderFeeCents: number | null = null;
    try {
      priceCents = dollarsToCents(priceDollars);
      introPriceCents = dollarsToCents(introPriceDollars);
      if (largeOrderFeeEnabled) {
        if (!largeOrderFeeDollars.trim()) {
          setPlanError('Enter a fee amount, or turn the fee off');
          return;
        }
        largeOrderFeeCents = dollarsToCents(largeOrderFeeDollars);
      }
    } catch {
      setPlanError('Enter valid prices');
      return;
    }
    setSavingPlan(true);
    const result = await saveMemberProPlanSettings({
      staffName: staffName.trim(),
      priceCents,
      billingInterval,
      introPriceCents,
      introMonths: Number(introMonths),
      introSeats: Number(introSeats),
      memberCap: Number(memberCap),
      pastDueGraceDays: Number(pastDueGraceDays),
      earlyAccessMinutes: Number(earlyAccessMinutes),
      extendedPickupDays: Number(extendedPickupDays),
      extraGraceHours: Number(extraGraceHours),
      perkInspectionBeforePickup,
      perkStagingAheadOfArrival,
      perkScheduledPickupSlots,
      perkEarlyBuildingAccess,
      perkLongerPickupWindow,
      perkPaymentGrace,
      standardPickupAllowanceQty: Number(standardPickupAllowanceQty),
      standardPickupAllowanceUnit,
      largeOrderSlotMinutes: Number(largeOrderSlotMinutes),
      largeOrderFeeEnabled,
      largeOrderFeeCents,
      inspectionsPerMemberMonth: Number(inspectionsPerMemberMonth),
      maxActiveSlotsPerMember: Number(maxActiveSlotsPerMember),
    });
    setSavingPlan(false);
    if (!result.ok) {
      setPlanError(result.error);
      return;
    }
    setPlanSavedAt(new Date());
    router.refresh();
  }

  return (
    <div>
      <div style={cardStyle}>
        <Field label="Your name (recorded in the audit log — BinGo staff share one login)">
          <input
            style={inputStyle}
            value={staffName}
            maxLength={100}
            disabled={disabled}
            placeholder="e.g. Braden"
            onChange={(e) => setStaffName(e.target.value)}
          />
        </Field>
      </div>

      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Plan</h3>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
          {base.active
            ? 'This plan is somehow active — that should not be possible yet.'
            : 'Off — billing not built yet. No bidder can see or join this plan.'}
        </p>
        <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: '1fr 1fr', maxWidth: 640 }}>
          <Field label="Regular price (USD)">
            <input
              style={inputStyle}
              value={priceDollars}
              disabled={disabled}
              inputMode="decimal"
              placeholder="100.00"
              onChange={(e) => setPriceDollars(e.target.value)}
            />
          </Field>
          <Field label="Billing interval">
            <select
              style={inputStyle}
              value={billingInterval}
              disabled={disabled}
              onChange={(e) => setBillingInterval(e.target.value as 'month' | 'year')}
            >
              <option value="month">Monthly</option>
              <option value="year">Yearly</option>
            </select>
          </Field>
          <Field label="Intro price (USD)">
            <input
              style={inputStyle}
              value={introPriceDollars}
              disabled={disabled}
              inputMode="decimal"
              placeholder="50.00"
              onChange={(e) => setIntroPriceDollars(e.target.value)}
            />
          </Field>
          <Field label="Intro months">
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={24}
              value={introMonths}
              disabled={disabled}
              onChange={(e) => setIntroMonths(e.target.value)}
            />
          </Field>
          <Field label="Intro seats (first N members)">
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={1000}
              value={introSeats}
              disabled={disabled}
              onChange={(e) => setIntroSeats(e.target.value)}
            />
          </Field>
          <Field label="Member cap (full → waitlist, no charge)">
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={5000}
              value={memberCap}
              disabled={disabled}
              onChange={(e) => setMemberCap(e.target.value)}
            />
          </Field>
          <Field label="Payment grace before perks pause (days)">
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={60}
              value={pastDueGraceDays}
              disabled={disabled}
              onChange={(e) => setPastDueGraceDays(e.target.value)}
            />
          </Field>
          <Field label="Early building access (minutes, display only)">
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={240}
              value={earlyAccessMinutes}
              disabled={disabled}
              onChange={(e) => setEarlyAccessMinutes(e.target.value)}
            />
          </Field>
          <Field label="Extra pickup days (0–30)">
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={30}
              value={extendedPickupDays}
              disabled={disabled}
              onChange={(e) => setExtendedPickupDays(e.target.value)}
            />
          </Field>
          <Field label="Extra hours to pay (0–168)">
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={168}
              value={extraGraceHours}
              disabled={disabled}
              onChange={(e) => setExtraGraceHours(e.target.value)}
            />
          </Field>
        </div>

        <h4>Perks (on/off)</h4>
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={perkInspectionBeforePickup}
              disabled={disabled}
              onChange={(e) => setPerkInspectionBeforePickup(e.target.checked)}
            />
            Item inspection before pickup
          </label>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={perkStagingAheadOfArrival}
              disabled={disabled}
              onChange={(e) => setPerkStagingAheadOfArrival(e.target.checked)}
            />
            Staging ahead of arrival
          </label>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={perkScheduledPickupSlots}
              disabled={disabled}
              onChange={(e) => setPerkScheduledPickupSlots(e.target.checked)}
            />
            Scheduled pickup slots (members only)
          </label>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={perkEarlyBuildingAccess}
              disabled={disabled}
              onChange={(e) => setPerkEarlyBuildingAccess(e.target.checked)}
            />
            Early building access
          </label>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={perkLongerPickupWindow}
              disabled={disabled}
              onChange={(e) => setPerkLongerPickupWindow(e.target.checked)}
            />
            Longer pickup window
          </label>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={perkPaymentGrace}
              disabled={disabled}
              onChange={(e) => setPerkPaymentGrace(e.target.checked)}
            />
            Extra payment grace
          </label>
        </div>

        <h4>Staging allowance &amp; large orders</h4>
        <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: '1fr 1fr', maxWidth: 640 }}>
          <Field label="Standard pickup allowance (over this → large order)">
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={10000}
              value={standardPickupAllowanceQty}
              disabled={disabled}
              onChange={(e) => setStandardPickupAllowanceQty(e.target.value)}
            />
          </Field>
          <Field label="Allowance unit">
            <select
              style={inputStyle}
              value={standardPickupAllowanceUnit}
              disabled={disabled}
              onChange={(e) => setStandardPickupAllowanceUnit(e.target.value as 'items' | 'pallets')}
            >
              <option value="items">Items</option>
              <option value="pallets">Pallets</option>
            </select>
          </Field>
          <Field label="Large-order slot length (minutes)">
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={480}
              value={largeOrderSlotMinutes}
              disabled={disabled}
              onChange={(e) => setLargeOrderSlotMinutes(e.target.value)}
            />
          </Field>
          <Field label="Monthly inspections per member">
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={100}
              value={inspectionsPerMemberMonth}
              disabled={disabled}
              onChange={(e) => setInspectionsPerMemberMonth(e.target.value)}
            />
          </Field>
          <Field label="Max active booked slots per member">
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={50}
              value={maxActiveSlotsPerMember}
              disabled={disabled}
              onChange={(e) => setMaxActiveSlotsPerMember(e.target.value)}
            />
          </Field>
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={largeOrderFeeEnabled}
              disabled={disabled}
              onChange={(e) => setLargeOrderFeeEnabled(e.target.checked)}
            />
            Large-order staging fee
          </label>
          {largeOrderFeeEnabled ? (
            <div style={{ maxWidth: 300, marginTop: '0.5rem' }}>
              <Field label="Fee (USD)">
                <input
                  style={inputStyle}
                  value={largeOrderFeeDollars}
                  disabled={disabled}
                  inputMode="decimal"
                  placeholder="25.00"
                  onChange={(e) => setLargeOrderFeeDollars(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <p style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: '0.25rem' }}>
              Fee: off (Michael decides)
            </p>
          )}
        </div>

        {planError && <div style={{ color: 'var(--danger)', marginTop: '0.75rem' }}>{planError}</div>}
        <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button style={buttonStyle} disabled={disabled || savingPlan} onClick={onSavePlan}>
            {savingPlan ? 'Saving…' : 'Save plan settings'}
          </button>
          {planSavedAt && (
            <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
              Saved {planSavedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
        <p style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: '0.5rem' }}>
          Regular price preview: {formatCents(dollarsToCentsSafe(priceDollars))} / {billingInterval}.
          Intro price preview: {formatCents(dollarsToCentsSafe(introPriceDollars))} / {billingInterval}
          {' '}for the first {introSeats || '0'} members, {introMonths || '0'} months.
        </p>
      </div>

      {warehouses.map((w) => (
        <WarehouseCard key={w.id} warehouse={w} staffName={staffName} disabled={disabled} />
      ))}
      {warehouses.length === 0 && (
        <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>No warehouses yet.</p>
      )}
    </div>
  );
}

function dollarsToCentsSafe(dollars: string): number {
  try {
    return dollarsToCents(dollars);
  } catch {
    return 0;
  }
}

function WarehouseCard({
  warehouse,
  staffName,
  disabled,
}: {
  warehouse: WarehouseRow;
  staffName: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const s = warehouse.settings ?? WAREHOUSE_DEFAULTS;
  const [stagedOrdersPerDay, setStagedOrdersPerDay] = useState(String(s.stagedOrdersPerDay));
  const [inspectionsPerDay, setInspectionsPerDay] = useState(String(s.inspectionsPerDay));
  const [slotMinutes, setSlotMinutes] = useState(String(s.slotMinutes));
  const [membersPerSlot, setMembersPerSlot] = useState(String(s.membersPerSlot));
  const [bookingDaysAhead, setBookingDaysAhead] = useState(String(s.bookingDaysAhead));
  const [changeCutoffHours, setChangeCutoffHours] = useState(String(s.changeCutoffHours));
  const [largeOrdersPerDay, setLargeOrdersPerDay] = useState(String(s.largeOrdersPerDay));
  const [allowanceQtyOverride, setAllowanceQtyOverride] = useState(
    s.standardPickupAllowanceQtyOverride != null ? String(s.standardPickupAllowanceQtyOverride) : '',
  );
  const [allowanceUnitOverride, setAllowanceUnitOverride] = useState<'items' | 'pallets' | ''>(
    s.standardPickupAllowanceUnitOverride ?? '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  async function onSave() {
    setError(null);
    if (!staffName.trim()) {
      setError('Enter your name above before saving (recorded in the audit log)');
      return;
    }
    setSaving(true);
    const result = await saveMemberProWarehouseSettings({
      staffName: staffName.trim(),
      warehouseId: warehouse.id,
      stagedOrdersPerDay: Number(stagedOrdersPerDay),
      inspectionsPerDay: Number(inspectionsPerDay),
      slotMinutes: Number(slotMinutes),
      membersPerSlot: Number(membersPerSlot),
      bookingDaysAhead: Number(bookingDaysAhead),
      changeCutoffHours: Number(changeCutoffHours),
      largeOrdersPerDay: Number(largeOrdersPerDay),
      standardPickupAllowanceQtyOverride: allowanceQtyOverride.trim() ? Number(allowanceQtyOverride) : null,
      standardPickupAllowanceUnitOverride: allowanceUnitOverride || null,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSavedAt(new Date());
    router.refresh();
  }

  return (
    <div style={cardStyle}>
      <h3 style={{ marginTop: 0 }}>{warehouse.name}</h3>
      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: '1fr 1fr', maxWidth: 640 }}>
        <Field label="Staged orders per day">
          <input
            style={inputStyle}
            type="number"
            min={1}
            max={500}
            value={stagedOrdersPerDay}
            disabled={disabled}
            onChange={(e) => setStagedOrdersPerDay(e.target.value)}
          />
        </Field>
        <Field label="Inspections per day">
          <input
            style={inputStyle}
            type="number"
            min={1}
            max={500}
            value={inspectionsPerDay}
            disabled={disabled}
            onChange={(e) => setInspectionsPerDay(e.target.value)}
          />
        </Field>
        <Field label="Slot length (minutes)">
          <input
            style={inputStyle}
            type="number"
            min={1}
            max={240}
            value={slotMinutes}
            disabled={disabled}
            onChange={(e) => setSlotMinutes(e.target.value)}
          />
        </Field>
        <Field label="Members per slot">
          <input
            style={inputStyle}
            type="number"
            min={1}
            max={50}
            value={membersPerSlot}
            disabled={disabled}
            onChange={(e) => setMembersPerSlot(e.target.value)}
          />
        </Field>
        <Field label="Booking days ahead">
          <input
            style={inputStyle}
            type="number"
            min={1}
            max={90}
            value={bookingDaysAhead}
            disabled={disabled}
            onChange={(e) => setBookingDaysAhead(e.target.value)}
          />
        </Field>
        <Field label="Change cutoff (hours before slot)">
          <input
            style={inputStyle}
            type="number"
            min={0}
            max={168}
            value={changeCutoffHours}
            disabled={disabled}
            onChange={(e) => setChangeCutoffHours(e.target.value)}
          />
        </Field>
        <Field label="Large-order slots per day">
          <input
            style={inputStyle}
            type="number"
            min={1}
            max={100}
            value={largeOrdersPerDay}
            disabled={disabled}
            onChange={(e) => setLargeOrdersPerDay(e.target.value)}
          />
        </Field>
      </div>
      <h4 style={{ marginBottom: 4 }}>Pickup allowance override (optional)</h4>
      <p style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 0 }}>
        Leave blank to use the plan&apos;s default allowance for this warehouse.
      </p>
      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: '1fr 1fr', maxWidth: 640 }}>
        <Field label="Allowance qty override">
          <input
            style={inputStyle}
            type="number"
            min={1}
            max={10000}
            value={allowanceQtyOverride}
            disabled={disabled}
            placeholder="(plan default)"
            onChange={(e) => setAllowanceQtyOverride(e.target.value)}
          />
        </Field>
        <Field label="Allowance unit override">
          <select
            style={inputStyle}
            value={allowanceUnitOverride}
            disabled={disabled}
            onChange={(e) => setAllowanceUnitOverride(e.target.value as 'items' | 'pallets' | '')}
          >
            <option value="">(plan default)</option>
            <option value="items">Items</option>
            <option value="pallets">Pallets</option>
          </select>
        </Field>
      </div>
      {error && <div style={{ color: 'var(--danger)', marginTop: '0.75rem' }}>{error}</div>}
      <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <button style={secondaryButtonStyle} disabled={disabled || saving} onClick={onSave}>
          {saving ? 'Saving…' : `Save ${warehouse.name} settings`}
        </button>
        {savedAt && (
          <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Saved {savedAt.toLocaleTimeString()}</span>
        )}
      </div>
    </div>
  );
}
