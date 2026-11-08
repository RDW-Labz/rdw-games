// Read-only Admin Help ads summaries (#879). Same #713 Central range contract.
// Growth Ads/Revenue must call these summarizers so totals match. Master has
// no ads tables (0503–0505 unwritten): the default store is unavailable and
// must not invent numbers or guess table names. No billing/approval/pause/
// credit/contact tools. Later wiring uses the admin session, never service role.

import { DEFAULT_TIME_ZONE, dayRangeInTimeZone, ymdInTimeZone } from '@/lib/datetime';
import {
  authorizeAdminHelpRead,
  type AdminHelpCaller,
  type AdminHelpEnv,
} from '@/lib/admin-help/flag';

export const ADS_READ_TOOL_NAMES = [
  'ads_revenue',
  'ads_placement',
  'ads_impressions',
  'ads_boost_queue',
] as const;
export type AdsReadToolName = (typeof ADS_READ_TOOL_NAMES)[number];
export type AdsReadRange = { from: Date; to: Date; label: string };
export type AdsTier = 'basic' | 'plus' | 'featured';

export type AdsRevenueEvent = {
  occurred_at: string; source: 'ad_subscription' | 'ad_boost'; cents: number; tier: AdsTier; business_key: string;
};
export type AdsPlacementRow = {
  ad_key: string; business_key: string; tier: AdsTier; status: 'active' | 'paused' | 'pending' | 'ended';
  grid: boolean; search: boolean; lot_page: boolean; featured_rotation: boolean;
  active_from: string; active_to: string | null;
};
export type AdsEngagementEvent = { occurred_at: string; kind: 'impression' | 'tap'; viewer_key: string };
export type AdsBoostQueueSnapshot = {
  live_count: number; waiting_count: number; next_start_at: string | null; starts: Array<{ started_at: string }>;
};
export type AdsReadSnapshot = {
  revenue: AdsRevenueEvent[] | null; placements: AdsPlacementRow[] | null;
  events: AdsEngagementEvent[] | null; boostQueue: AdsBoostQueueSnapshot | null;
};
export type AdsReadStore = { load(): Promise<AdsReadSnapshot> };
export const missingAdsReadStore: AdsReadStore = {
  async load() {
    return { revenue: null, placements: null, events: null, boostQueue: null };
  },
};

const RANGE_PROPS = {
  range: {
    type: 'string',
    enum: ['today', 'yesterday', 'week', 'range'],
    description: 'Central-time window. Use range with from/to for any date range.',
  },
  from: { type: 'string', description: 'First day, YYYY-MM-DD. Only with range.' },
  to: { type: 'string', description: 'Last day, YYYY-MM-DD, inclusive. Only with range.' },
};

const SCHEMA = { type: 'object' as const, properties: RANGE_PROPS, required: ['range'] };
export const ADS_READ_TOOLS = [
  { name: 'ads_revenue' as const, input_schema: SCHEMA, description: 'Read-only ad_subscription + ad_boost integer-cent totals for a Central-time range. Counts only; no business identities.' },
  { name: 'ads_placement' as const, input_schema: SCHEMA, description: 'Read-only ad counts by tier and placement (grid, search, lot page, featured) overlapping a Central-time range.' },
  { name: 'ads_impressions' as const, input_schema: SCHEMA, description: 'Read-only raw impression, unique-viewer, and tap counts for a Central-time range. No multipliers.' },
  { name: 'ads_boost_queue' as const, input_schema: SCHEMA, description: 'Read-only boost-queue size (live, waiting) plus boosts that started in a Central-time range.' },
];

function parseYmd(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function addYmd(ymd: string, delta: number): string {
  const [year, month, day] = ymd.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + delta));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function span(fromYmd: string, toYmd: string, label: string): AdsReadRange | { error: string } {
  const bounds = dayRangeInTimeZone(fromYmd, toYmd, DEFAULT_TIME_ZONE);
  if (!bounds) return { error: 'range_empty' };
  const from = new Date(bounds.startISO);
  const to = new Date(bounds.endISO);
  if ((to.getTime() - from.getTime()) / 86400000 > 366) return { error: 'range_too_long' };
  return { from, to, label };
}

export function adminHelpRange(
  range: string,
  now: Date = new Date(),
  from?: string,
  to?: string,
): AdsReadRange | { error: string } {
  const today = ymdInTimeZone(now, DEFAULT_TIME_ZONE);
  if (range === 'today') return span(today, today, `today (${today}, Central)`);
  if (range === 'yesterday') {
    const prev = addYmd(today, -1);
    return span(prev, prev, `yesterday (${prev}, Central)`);
  }
  if (range === 'week') {
    const monday = addYmd(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
    return span(monday, today, `this week (Mon ${monday} to ${today}, Central)`);
  }
  if (range === 'range') {
    if (!from || !to) return { error: 'range_from_to_required' };
    const start = parseYmd(from);
    const end = parseYmd(to);
    if (!start || !end) return { error: 'range_dates_yyyymmdd' };
    return span(start, end, `${start} to ${end} (Central)`);
  }
  return { error: 'range_invalid' };
}

function intCents(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function inRange(iso: string, from: Date, to: Date): boolean {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= from.getTime() && ms < to.getTime();
}

const EMPTY_TIER = { basic: 0, plus: 0, featured: 0 };

export function summarizeAdsRevenue(events: AdsRevenueEvent[], from: Date, to: Date) {
  const by_tier_cents = { ...EMPTY_TIER };
  const businesses = new Set<string>();
  let subscription_cents = 0;
  let boost_cents = 0;
  let charges = 0;
  for (const event of events) {
    if (!inRange(event.occurred_at, from, to)) continue;
    if (event.source !== 'ad_subscription' && event.source !== 'ad_boost') continue;
    const cents = intCents(event.cents);
    if (event.source === 'ad_subscription') subscription_cents += cents;
    else boost_cents += cents;
    if (event.tier in by_tier_cents) by_tier_cents[event.tier] += cents;
    if (event.business_key) businesses.add(event.business_key);
    charges += 1;
  }
  return {
    subscription_cents,
    boost_cents,
    total_cents: subscription_cents + boost_cents,
    by_tier_cents,
    businesses: businesses.size,
    charges,
  };
}

export function summarizeAdsPlacement(rows: AdsPlacementRow[], from: Date, to: Date) {
  const by_tier = { ...EMPTY_TIER };
  const businesses = new Set<string>();
  let ads = 0;
  let grid = 0;
  let search = 0;
  let lot_page = 0;
  let featured_rotation = 0;
  let active = 0;
  for (const row of rows) {
    const start = Date.parse(row.active_from);
    const end = row.active_to ? Date.parse(row.active_to) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(start) || start >= to.getTime() || end < from.getTime()) continue;
    ads += 1;
    if (row.tier in by_tier) by_tier[row.tier] += 1;
    if (row.business_key) businesses.add(row.business_key);
    if (row.grid) grid += 1;
    if (row.search) search += 1;
    if (row.lot_page) lot_page += 1;
    if (row.featured_rotation) featured_rotation += 1;
    if (row.status === 'active') active += 1;
  }
  return { ads, businesses: businesses.size, active, by_tier, grid, search, lot_page, featured_rotation };
}

export function summarizeAdsImpressions(events: AdsEngagementEvent[], from: Date, to: Date) {
  const viewers = new Set<string>();
  let impressions = 0;
  let taps = 0;
  for (const event of events) {
    if (!inRange(event.occurred_at, from, to)) continue;
    if (event.kind === 'impression') {
      impressions += 1;
      if (event.viewer_key) viewers.add(event.viewer_key);
    } else if (event.kind === 'tap') taps += 1;
  }
  return { impressions, unique_viewers: viewers.size, taps };
}

export function summarizeAdsBoostQueue(queue: AdsBoostQueueSnapshot, from: Date, to: Date) {
  return {
    live: Math.max(0, intCents(queue.live_count)),
    waiting: Math.max(0, intCents(queue.waiting_count)),
    next_start_at: queue.next_start_at,
    started_in_range: queue.starts.filter((item) => inRange(item.started_at, from, to)).length,
  };
}

export function listAdsReadTools(caller: AdminHelpCaller, env: AdminHelpEnv = process.env) {
  return authorizeAdminHelpRead(caller, env) === null ? ADS_READ_TOOLS : [];
}

export type AdsReadResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

async function runOnce(args: {
  name: string;
  input: Record<string, unknown>;
  caller: AdminHelpCaller;
  store: AdsReadStore;
  now: Date;
  env: AdminHelpEnv;
}): Promise<AdsReadResult> {
  if (!ADS_READ_TOOL_NAMES.includes(args.name as AdsReadToolName)) return { ok: false, error: 'unknown_tool' };
  const gate = authorizeAdminHelpRead(args.caller, args.env);
  if (gate) return { ok: false, error: gate };
  const bounds = adminHelpRange(
    String(args.input.range ?? 'today'),
    args.now,
    args.input.from === undefined ? undefined : String(args.input.from),
    args.input.to === undefined ? undefined : String(args.input.to),
  );
  if ('error' in bounds) return { ok: false, error: bounds.error };
  let snapshot: AdsReadSnapshot;
  try {
    snapshot = await args.store.load();
  } catch {
    return { ok: false, error: 'query_failed' };
  }
  if (args.name === 'ads_revenue') {
    if (!snapshot.revenue) return { ok: false, error: 'dependency_missing' };
    return { ok: true, data: { range: bounds.label, ...summarizeAdsRevenue(snapshot.revenue, bounds.from, bounds.to) } };
  }
  if (args.name === 'ads_placement') {
    if (!snapshot.placements) return { ok: false, error: 'dependency_missing' };
    return { ok: true, data: { range: bounds.label, ...summarizeAdsPlacement(snapshot.placements, bounds.from, bounds.to) } };
  }
  if (args.name === 'ads_impressions') {
    if (!snapshot.events) return { ok: false, error: 'dependency_missing' };
    return { ok: true, data: { range: bounds.label, ...summarizeAdsImpressions(snapshot.events, bounds.from, bounds.to) } };
  }
  if (!snapshot.boostQueue) return { ok: false, error: 'dependency_missing' };
  return { ok: true, data: { range: bounds.label, ...summarizeAdsBoostQueue(snapshot.boostQueue, bounds.from, bounds.to) } };
}

export async function runAdsReadTool(args: {
  name: string;
  caller: AdminHelpCaller;
  input?: Record<string, unknown>;
  store?: AdsReadStore;
  now?: Date;
  env?: AdminHelpEnv;
  retries?: number;
}): Promise<AdsReadResult> {
  const retries = args.retries ?? 1;
  const once = {
    name: args.name,
    input: args.input ?? {},
    caller: args.caller,
    store: args.store ?? missingAdsReadStore,
    now: args.now ?? new Date(),
    env: args.env ?? process.env,
  };
  let last = await runOnce(once);
  for (let attempt = 0; attempt < retries && !last.ok && last.error === 'query_failed'; attempt += 1) {
    last = await runOnce(once);
  }
  return last;
}
