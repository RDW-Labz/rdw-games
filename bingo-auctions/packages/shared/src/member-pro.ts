// Member Pro (mig 0457) — shared pure logic for intro pricing + the member
// cap / waitlist decision. No Square/billing calls live here (billing is a
// later PR); this is the one place that decides "what does THIS signup cost"
// and "is there room", so the console preview, the later billing PR, and any
// report all agree with each other instead of three copies of the same math
// drifting apart.
//
// Terms (matching operator_pro_plans, mig 0457):
//   introSeats        — how many of the FIRST members get introPriceCents.
//   introMonths       — how many months an intro member keeps that price.
//   memberCap         — max concurrent active members before new signups
//                        waitlist instead of being charged.

export type MemberProPlanPricing = {
  priceCents: number;
  introPriceCents: number;
  introSeats: number;
  introMonths: number;
};

export type MemberProCap = {
  memberCap: number;
};

/**
 * The price a NEW signup pays today, given how many members the plan already
 * has (not counting this signup). Intro pricing is a seat-count gate, not a
 * calendar one: the first `introSeats` signups get `introPriceCents`; the
 * (introSeats + 1)th and later signups pay `priceCents` from day one.
 * introSeats = 0 means no intro pricing is offered at all.
 */
export function priceForNewSignup(
  plan: MemberProPlanPricing,
  activeMemberCountBeforeThisSignup: number,
): { priceCents: number; introApplied: boolean } {
  const introAvailable =
    plan.introSeats > 0 && activeMemberCountBeforeThisSignup < plan.introSeats;
  return introAvailable
    ? { priceCents: plan.introPriceCents, introApplied: true }
    : { priceCents: plan.priceCents, introApplied: false };
}

/**
 * When an intro-priced subscription rolls to the regular price: `introMonths`
 * after it started, on the same day-of-period as current_period_end already
 * tracks. Returns the cents a RENEWAL should charge, given whether the intro
 * window (by month count, not a stored date) has elapsed.
 */
export function priceForRenewal(
  plan: Pick<MemberProPlanPricing, 'priceCents' | 'introPriceCents'>,
  introApplied: boolean,
  monthsSinceSignup: number,
  introMonths: number,
): number {
  if (!introApplied) return plan.priceCents;
  return monthsSinceSignup < introMonths ? plan.introPriceCents : plan.priceCents;
}

export type SignupOutcome =
  | { kind: 'enrolled'; priceCents: number; introApplied: boolean }
  | { kind: 'waitlisted' };

/**
 * The single decision point for "what happens when this bidder tries to join
 * Member Pro right now": enrolled at the intro or regular price, or
 * waitlisted with no charge if the operator's member_cap is already full.
 * Cap is checked BEFORE intro pricing -- a full plan waitlists even an
 * intro-eligible signup; a waitlisted bidder is never charged.
 */
export function decideSignup(
  plan: MemberProPlanPricing & MemberProCap,
  activeMemberCountBeforeThisSignup: number,
): SignupOutcome {
  if (activeMemberCountBeforeThisSignup >= plan.memberCap) {
    return { kind: 'waitlisted' };
  }
  const { priceCents, introApplied } = priceForNewSignup(plan, activeMemberCountBeforeThisSignup);
  return { kind: 'enrolled', priceCents, introApplied };
}

// ============================================================================
// Added 2026-10-26 (owner changes relayed by Jared, mig 0457 PR 1 same-day
// update): staging allowance / large-order classification, the usage-view
// math (% full, limit reached), and the member_slot_bookings /
// member_inspections counting rules the view + a later PR both need to agree
// on. Still pure functions, still no Square/billing/charging code -- these
// decide NUMBERS, never move money.
// ============================================================================

// ----------------------------------------------------------------------------
// Large-order classification
// ----------------------------------------------------------------------------

export type PickupAllowance = {
  qty: number;
  unit: 'items' | 'pallets';
};

/**
 * A standard member pickup over the operator's (or warehouse-overridden)
 * allowance books a SEPARATE "large order" slot instead. requestedQty is
 * assumed to already be in `allowance.unit` -- reconciling a request given in
 * a different unit than the allowance is a later PR's (the actual booking
 * flow's) problem, not this classifier's.
 */
export function classifyPickupOrder(
  requestedQty: number,
  allowance: PickupAllowance,
): 'standard' | 'large_order' {
  return requestedQty > allowance.qty ? 'large_order' : 'standard';
}

/**
 * Resolves the effective per-warehouse allowance: a warehouse override (both
 * qty + unit set) wins; otherwise the operator-level default. Mirrors how
 * member_warehouse_settings.standard_pickup_allowance_qty_override /
 * _unit_override are meant to be read (mig 0457).
 */
export function effectivePickupAllowance(
  operatorDefault: PickupAllowance,
  warehouseOverride: Partial<PickupAllowance> | null | undefined,
): PickupAllowance {
  if (warehouseOverride?.qty != null && warehouseOverride.unit != null) {
    return { qty: warehouseOverride.qty, unit: warehouseOverride.unit };
  }
  return operatorDefault;
}

// ----------------------------------------------------------------------------
// % full / limit reached (the usage view's shared vocabulary)
// ----------------------------------------------------------------------------

/**
 * 0-100, rounded, capped at 100. A capacity of 0 with any usage reads as 100%
 * full rather than dividing by zero (a day nothing is configured to handle
 * should read as full, not empty).
 */
export function percentFull(used: number, capacity: number): number {
  if (capacity <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.round((used / capacity) * 100));
}

/** The plain "full" marker the usage view shows alongside the percentage. */
export function isFull(used: number, capacity: number): boolean {
  return capacity > 0 ? used >= capacity : used > 0;
}

export type WarehouseDayCapacity = {
  memberSlotsBooked: number;
  memberSlotCapacity: number;
  largeOrderSlotsUsed: number;
  largeOrdersPerDay: number;
  stagedOrders: number;
  stagedOrdersPerDay: number;
  inspections: number;
  inspectionsPerDay: number;
};

export type WarehouseDayUsage = {
  memberSlots: { used: number; capacity: number; pctFull: number; full: boolean };
  largeOrders: { used: number; capacity: number; pctFull: number; full: boolean };
  stagedOrders: { used: number; capacity: number; pctFull: number; full: boolean };
  inspections: { used: number; capacity: number; pctFull: number; full: boolean };
};

/** The one place that turns a day's raw counts into the usage view's rows. */
export function summarizeWarehouseDay(c: WarehouseDayCapacity): WarehouseDayUsage {
  const row = (used: number, capacity: number) => ({
    used,
    capacity,
    pctFull: percentFull(used, capacity),
    full: isFull(used, capacity),
  });
  return {
    memberSlots: row(c.memberSlotsBooked, c.memberSlotCapacity),
    largeOrders: row(c.largeOrderSlotsUsed, c.largeOrdersPerDay),
    stagedOrders: row(c.stagedOrders, c.stagedOrdersPerDay),
    inspections: row(c.inspections, c.inspectionsPerDay),
  };
}

// ----------------------------------------------------------------------------
// Daily slot capacity from warehouses.pickup_hours (0001) ÷ slot_minutes.
// No slot-GENERATION table exists yet (PR 7) -- this derives a day's slot
// COUNT from existing data, for a read-only view.
// ----------------------------------------------------------------------------

export type PickupHoursWindow = { open: string; close: string }; // "HH:MM", 24h
export type WeekdayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
export type PickupHours = Partial<Record<WeekdayKey, PickupHoursWindow[]>>;

const WEEKDAY_KEYS: readonly WeekdayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function minutesBetween(open: string, close: string): number {
  const [oh, om] = open.split(':').map(Number) as [number, number];
  const [ch, cm] = close.split(':').map(Number) as [number, number];
  const mins = ch * 60 + cm - (oh * 60 + om);
  return mins > 0 ? mins : 0;
}

/** How many whole slots of `slotMinutes` fit in this weekday's pickup hours. */
export function slotsAvailableForDay(
  pickupHours: PickupHours,
  weekday: WeekdayKey,
  slotMinutes: number,
): number {
  if (slotMinutes <= 0) return 0;
  const windows = pickupHours[weekday] ?? [];
  const totalMinutes = windows.reduce((sum, w) => sum + minutesBetween(w.open, w.close), 0);
  return Math.floor(totalMinutes / slotMinutes);
}

/** Member-slot CAPACITY for a day: slots available × members allowed per slot. */
export function memberSlotCapacityForDay(
  pickupHours: PickupHours,
  weekday: WeekdayKey,
  slotMinutes: number,
  membersPerSlot: number,
): number {
  return slotsAvailableForDay(pickupHours, weekday, slotMinutes) * membersPerSlot;
}

/**
 * Which pickup_hours weekday key `date` falls on, in the warehouse's own
 * timezone (warehouses.timezone, 0001) -- not the server's.
 */
export function weekdayKeyInTimeZone(date: Date, timeZone: string): WeekdayKey {
  const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
    .format(date)
    .toLowerCase()
    .slice(0, 3) as WeekdayKey;
  return WEEKDAY_KEYS.includes(short) ? short : 'sun';
}

// ----------------------------------------------------------------------------
// Per-member limits: monthly inspections (calendar month, America/Chicago)
// and active booked slots (future 'booked' rows only).
// ----------------------------------------------------------------------------

const CHICAGO_TZ = 'America/Chicago';

function chicagoYearMonth(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '00';
  return `${year}-${month}`;
}

/**
 * member_inspections.requested_for is a plain SQL DATE (e.g. "2026-10-26") --
 * already a calendar day with no timezone component, so its month is just its
 * string prefix. "now" (a real instant) is resolved through America/Chicago
 * first, since the server may run in UTC and a few hours near midnight UTC
 * would otherwise land on the wrong Chicago calendar day/month.
 */
function monthKeyForRequestedFor(requestedFor: string): string {
  return requestedFor.slice(0, 7);
}

export type MemberInspectionRecord = { requestedFor: string; status: string };

/** Inspections used THIS calendar month (America/Chicago), canceled excluded. */
export function inspectionsUsedThisMonth(
  inspections: MemberInspectionRecord[],
  now: Date = new Date(),
): number {
  const currentMonth = chicagoYearMonth(now);
  return inspections.filter(
    (i) => i.status !== 'canceled' && monthKeyForRequestedFor(i.requestedFor) === currentMonth,
  ).length;
}

export function inspectionLimitReached(usedThisMonth: number, inspectionsPerMemberMonth: number): boolean {
  return usedThisMonth >= inspectionsPerMemberMonth;
}

export type MemberSlotBookingRecord = { slotStartsAt: string; status: string };

/** Active = status 'booked' AND the slot is still in the future. */
export function activeBookedSlotCount(
  bookings: MemberSlotBookingRecord[],
  now: Date = new Date(),
): number {
  return bookings.filter((b) => b.status === 'booked' && new Date(b.slotStartsAt) > now).length;
}

export function activeSlotLimitReached(activeCount: number, maxActiveSlotsPerMember: number): boolean {
  return activeCount >= maxActiveSlotsPerMember;
}
