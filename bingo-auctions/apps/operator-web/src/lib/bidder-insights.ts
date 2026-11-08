// Bidder insights (mig 0449): ZIP heat table, activity segments, weekly
// cohorts — the pure half. RPC row parsing, CSV, and the shaping each report
// section needs, kept free of Supabase/fetch so it is unit-testable like
// bidder-location.ts (mig 0434).
//
// Aggregates only: there is no bidder id, name, email or phone in any type
// below, by design. The small-group suppression (<3 registered -> 'Other
// (fewer than 3)') is computed in SQL — these helpers trust the rows they're
// given, the same way bidder-location.ts does for 0434/0438.

export const UNKNOWN_ZIP = 'Unknown';
export const OTHER_ZIP = 'Other (fewer than 3)';

/** Rank for sorting: real ZIPs first (ascending), then Other, then Unknown. */
function zipRank(z: string): number {
  if (z === UNKNOWN_ZIP) return 2;
  if (z === OTHER_ZIP) return 1;
  return 0;
}

function zipDefaultCompare(a: string, b: string): number {
  const r = zipRank(a) - zipRank(b);
  if (r) return r;
  return a < b ? -1 : a > b ? 1 : 0;
}

const num = (v: unknown): number => {
  // bigint columns arrive from PostgREST as numbers or numeric strings.
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── RPC result → page state (shared shape for all three RPCs) ─────────────

export type RpcState<T> =
  | { kind: 'ok'; rows: T[] }
  | { kind: 'needs_migration' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string };

/**
 * Classify an RPC outcome the same way bidder-location.ts does for 0434:
 * before the migration is applied, PostgREST answers PGRST202 ("Could not
 * find the function … in the schema cache") -> the calm "needs migration"
 * banner, never a crash. 42501 = the function's own admin/manager refusal.
 */
export function rpcStateFrom<T>(
  rpcName: string,
  parseRows: (raw: unknown) => T[],
  data: unknown,
  error: { code?: string; message?: string } | null,
): RpcState<T> {
  if (error) {
    const msg = error.message ?? '';
    if (
      error.code === 'PGRST202' ||
      error.code === '42883' ||
      (msg.includes(rpcName) && /could not find|does not exist/i.test(msg))
    ) {
      return { kind: 'needs_migration' };
    }
    if (error.code === '42501') return { kind: 'forbidden' };
    return { kind: 'error', message: msg || 'Unknown error' };
  }
  return { kind: 'ok', rows: parseRows(data) };
}

// ── 1. ZIP heat table (operator_bidder_zip_heat, mig 0449) ────────────────

export type ZipHeatRow = {
  postalCode: string;
  registered: number;
  activeBidders30d: number;
  winners: number;
  paidRevenueCents: number;
  /** Basis points (0-10000) of this row's share of the returned total. null when the total is 0. */
  shareBps: number | null;
};

export const ZIP_HEAT_RPC = 'operator_bidder_zip_heat';

export function parseZipHeatRows(raw: unknown): ZipHeatRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      postalCode: typeof o.postal_code === 'string' && o.postal_code ? o.postal_code : UNKNOWN_ZIP,
      registered: num(o.registered),
      activeBidders30d: num(o.active_bidders_30d),
      winners: num(o.winners),
      paidRevenueCents: num(o.paid_revenue_cents),
      shareBps: numOrNull(o.share_bps),
    };
  });
}

export type ZipHeatSortKey =
  | 'postalCode'
  | 'registered'
  | 'activeBidders30d'
  | 'winners'
  | 'paidRevenueCents'
  | 'shareBps';

/**
 * Sort by any column, either direction. 'postalCode' keeps the Other/Unknown
 * roll-ups at the bottom regardless of direction (sorting a label that isn't
 * really a ZIP next to real ZIPs would be meaningless); every other column
 * sorts purely by value, nulls last.
 */
export function sortZipHeatRows(
  rows: ZipHeatRow[],
  key: ZipHeatSortKey,
  dir: 'asc' | 'desc' = 'desc',
): ZipHeatRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    // Other/Unknown always sort last, in either direction — a roll-up label
    // sorted numerically next to real ZIPs would be meaningless.
    const rankDiff = zipRank(a.postalCode) - zipRank(b.postalCode);
    if (rankDiff) return rankDiff;
    if (key === 'postalCode') return sign * zipDefaultCompare(a.postalCode, b.postalCode);
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return sign * (av - bv);
  });
}

export type ZipHeatTotals = Omit<ZipHeatRow, 'postalCode' | 'shareBps'> & { shareBps: number | null };

/** Totals row = Σ of every row returned; share is 10000 (100%) when any revenue exists. */
export function zipHeatTotals(rows: ZipHeatRow[]): ZipHeatTotals {
  const t = rows.reduce(
    (acc, r) => ({
      registered: acc.registered + r.registered,
      activeBidders30d: acc.activeBidders30d + r.activeBidders30d,
      winners: acc.winners + r.winners,
      paidRevenueCents: acc.paidRevenueCents + r.paidRevenueCents,
    }),
    { registered: 0, activeBidders30d: 0, winners: 0, paidRevenueCents: 0 },
  );
  return { ...t, shareBps: t.paidRevenueCents > 0 ? 10000 : null };
}

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Integer cents → "1234.56" / "-50.37" (exact, no float). */
export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function bpsToPct(bps: number | null): string {
  return bps == null ? '' : (bps / 100).toFixed(2);
}

export const ZIP_HEAT_CSV_HEADER = [
  'zip',
  'registered',
  'active_last_30d',
  'winners',
  'paid_revenue_excl_tax',
  'share_pct',
] as const;

export function zipHeatCsvRows(rows: ZipHeatRow[]): string[][] {
  const t = zipHeatTotals(rows);
  return [
    [...ZIP_HEAT_CSV_HEADER],
    ...rows.map((r) => [
      r.postalCode,
      String(r.registered),
      String(r.activeBidders30d),
      String(r.winners),
      dollars(r.paidRevenueCents),
      bpsToPct(r.shareBps),
    ]),
    ['Total', String(t.registered), String(t.activeBidders30d), String(t.winners), dollars(t.paidRevenueCents), bpsToPct(t.shareBps)],
  ];
}

export function zipHeatCsv(
  rows: ZipHeatRow[],
  meta: { period: string; zipPrefix: string | null },
): string {
  const title = [
    `Bidder ZIP heat, ${meta.period}`,
    meta.zipPrefix ? `ZIP starts with ${meta.zipPrefix}` : 'all ZIPs',
  ];
  const lines = [title, ...zipHeatCsvRows(rows)].map((l) => l.map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

// ── 2. Segments (operator_bidder_segments[_by_zip], mig 0449) ─────────────

export type SegmentKey = 'new' | 'active' | 'lapsed' | 'dormant' | 'never_bid';

export const SEGMENT_ORDER: readonly SegmentKey[] = ['new', 'active', 'lapsed', 'dormant', 'never_bid'];

export const SEGMENT_LABELS: Record<SegmentKey, string> = {
  new: 'New (joined ≤ 30d)',
  active: 'Active (bid ≤ 30d)',
  lapsed: 'Lapsed (31-90d)',
  dormant: 'Dormant (90d+)',
  never_bid: 'Never bid',
};

function isSegmentKey(v: unknown): v is SegmentKey {
  return typeof v === 'string' && (SEGMENT_ORDER as readonly string[]).includes(v);
}

export const SEGMENTS_RPC = 'operator_bidder_segments';
export const SEGMENTS_BY_ZIP_RPC = 'operator_bidder_segments_by_zip';

/**
 * Classifies a single bidder into one of the 5 mutually-exclusive activity
 * segments, mirroring operator_bidder_segments() exactly (mig 0449 header
 * comment has the rationale for the precedence order):
 *   1. new        — created in the last 30 days (even if they've already
 *                    bid — this is an acquisition cohort, not an engagement
 *                    one; /reports/bidders already answers "did they
 *                    activate")
 *   2. never_bid  — no bid, ever
 *   3. active     — last bid within 30 days
 *   4. lapsed     — last bid 31-90 days ago
 *   5. dormant    — last bid more than 90 days ago
 *
 * Used both by the ZIP/segments report (server-computed, via the RPC) and by
 * the bidder profile page (client-computed from data the page already
 * loaded, so a single-bidder lookup doesn't need its own RPC call).
 */
export function classifyBidderSegment(args: {
  createdAt: string | Date;
  lastBidAt: string | Date | null;
  now?: Date;
}): SegmentKey {
  const now = args.now ?? new Date();
  const createdAt = new Date(args.createdAt);
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
  if (now.getTime() - createdAt.getTime() <= THIRTY_DAYS) return 'new';
  if (args.lastBidAt == null) return 'never_bid';
  const lastBidAt = new Date(args.lastBidAt);
  const age = now.getTime() - lastBidAt.getTime();
  if (age <= THIRTY_DAYS) return 'active';
  if (age <= NINETY_DAYS) return 'lapsed';
  return 'dormant';
}

export type SegmentRow = { segment: SegmentKey; bidders: number };

/** Always returns all 5 segments in SEGMENT_ORDER, filling any missing one with 0. */
export function parseSegmentRows(raw: unknown): SegmentRow[] {
  const byKey = new Map<SegmentKey, number>();
  if (Array.isArray(raw)) {
    for (const r of raw) {
      const o = (r ?? {}) as Record<string, unknown>;
      if (isSegmentKey(o.segment)) byKey.set(o.segment, num(o.bidders));
    }
  }
  return SEGMENT_ORDER.map((segment) => ({ segment, bidders: byKey.get(segment) ?? 0 }));
}

export type SegmentByZipRow = { postalCode: string; segment: SegmentKey; bidders: number };

export function parseSegmentByZipRows(raw: unknown): SegmentByZipRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const segment = o.segment;
      if (!isSegmentKey(segment)) return null;
      return {
        postalCode: typeof o.postal_code === 'string' && o.postal_code ? o.postal_code : UNKNOWN_ZIP,
        segment,
        bidders: num(o.bidders),
      };
    })
    .filter((r): r is SegmentByZipRow => r !== null);
}

export type SegmentZipMatrixRow = { postalCode: string; counts: Record<SegmentKey, number>; total: number };

/** Pivots the flat by-zip rows into one row per ZIP with a count per segment, ZIPs ascending (Other, then Unknown last). */
export function segmentZipMatrix(rows: SegmentByZipRow[]): SegmentZipMatrixRow[] {
  const byZip = new Map<string, Record<SegmentKey, number>>();
  for (const r of rows) {
    if (!byZip.has(r.postalCode)) {
      byZip.set(r.postalCode, { new: 0, active: 0, lapsed: 0, dormant: 0, never_bid: 0 });
    }
    byZip.get(r.postalCode)![r.segment] = r.bidders;
  }
  return [...byZip.entries()]
    .map(([postalCode, counts]) => ({
      postalCode,
      counts,
      total: SEGMENT_ORDER.reduce((s, k) => s + counts[k], 0),
    }))
    .sort((a, b) => zipDefaultCompare(a.postalCode, b.postalCode));
}

export const SEGMENT_CSV_HEADER = ['zip', ...SEGMENT_ORDER, 'total'] as const;

export function segmentZipCsvRows(rows: SegmentByZipRow[]): string[][] {
  const matrix = segmentZipMatrix(rows);
  return [
    [...SEGMENT_CSV_HEADER],
    ...matrix.map((m) => [m.postalCode, ...SEGMENT_ORDER.map((k) => String(m.counts[k])), String(m.total)]),
  ];
}

// ── 3. Weekly cohorts (operator_bidder_cohorts, mig 0449) ──────────────────

export const COHORTS_RPC = 'operator_bidder_cohorts';

export type CohortRow = {
  cohortWeek: string; // YYYY-MM-DD, Monday
  weeksSince: number;
  cohortSize: number;
  bidPct: number;
  winPct: number;
};

export function parseCohortRows(raw: unknown): CohortRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const cohortWeek = typeof o.cohort_week === 'string' ? o.cohort_week : null;
      if (!cohortWeek) return null;
      return {
        cohortWeek,
        weeksSince: num(o.weeks_since),
        cohortSize: num(o.cohort_size),
        bidPct: num(o.bid_pct),
        winPct: num(o.win_pct),
      };
    })
    .filter((r): r is CohortRow => r !== null);
}

export type CohortCell = { bidPct: number; winPct: number } | null;
export type CohortMatrixRow = { cohortWeek: string; cohortSize: number; cells: CohortCell[] };

/**
 * Pivots the flat (cohort_week, weeks_since) rows into one row per cohort,
 * most-recent cohort first, with a fixed-width `cells` array (length
 * `weeks`) indexed by weeks-since-signup. A cell is null when that week
 * hasn't happened yet for that cohort (the RPC never returns a future-week
 * row) — the UI renders null as a blank/dash, not a 0%.
 */
export function buildCohortMatrix(rows: CohortRow[], weeks: number): CohortMatrixRow[] {
  const byWeek = new Map<string, { cohortSize: number; cells: CohortCell[] }>();
  for (const r of rows) {
    if (!byWeek.has(r.cohortWeek)) {
      byWeek.set(r.cohortWeek, { cohortSize: r.cohortSize, cells: new Array(weeks).fill(null) });
    }
    const entry = byWeek.get(r.cohortWeek)!;
    if (r.weeksSince >= 0 && r.weeksSince < weeks) {
      entry.cells[r.weeksSince] = { bidPct: r.bidPct, winPct: r.winPct };
    }
  }
  return [...byWeek.entries()]
    .map(([cohortWeek, v]) => ({ cohortWeek, cohortSize: v.cohortSize, cells: v.cells }))
    .sort((a, b) => (a.cohortWeek < b.cohortWeek ? 1 : a.cohortWeek > b.cohortWeek ? -1 : 0));
}

export const COHORT_CSV_HEADER_PREFIX = ['cohort_week', 'cohort_size'] as const;

/** One row per cohort; columns are "w0_bid_pct","w0_win_pct","w1_bid_pct",... */
export function cohortCsvRows(rows: CohortRow[], weeks: number): string[][] {
  const matrix = buildCohortMatrix(rows, weeks);
  const header = [
    ...COHORT_CSV_HEADER_PREFIX,
    ...Array.from({ length: weeks }, (_, i) => [`w${i}_bid_pct`, `w${i}_win_pct`]).flat(),
  ];
  return [
    header,
    ...matrix.map((m) => [
      m.cohortWeek,
      String(m.cohortSize),
      ...m.cells.flatMap((c) => [c ? c.bidPct.toFixed(1) : '', c ? c.winPct.toFixed(1) : '']),
    ]),
  ];
}
