// Pure helpers for /reports/bidder-insights (mig 0449): ZIP heat, segments,
// weekly cohorts. Synthetic fixtures only, hand-worked — no customer data.
import { describe, expect, it } from 'vitest';
import {
  buildCohortMatrix,
  classifyBidderSegment,
  cohortCsvRows,
  dollars,
  parseCohortRows,
  parseSegmentByZipRows,
  parseSegmentRows,
  parseZipHeatRows,
  rpcStateFrom,
  segmentZipCsvRows,
  segmentZipMatrix,
  sortZipHeatRows,
  zipHeatCsv,
  zipHeatCsvRows,
  zipHeatTotals,
  ZIP_HEAT_RPC,
  type ZipHeatRow,
} from '@/lib/bidder-insights';

describe('classifyBidderSegment', () => {
  const now = new Date('2026-10-23T00:00:00Z');
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  it('is "new" for a signup within 30 days, even if they already bid', () => {
    expect(
      classifyBidderSegment({ createdAt: days(5), lastBidAt: days(1), now }),
    ).toBe('new');
    expect(
      classifyBidderSegment({ createdAt: days(30), lastBidAt: null, now }),
    ).toBe('new');
  });

  it('is "never_bid" once past the new window with no bid', () => {
    expect(
      classifyBidderSegment({ createdAt: days(400), lastBidAt: null, now }),
    ).toBe('never_bid');
  });

  it('buckets by last-bid recency once past the new window', () => {
    expect(classifyBidderSegment({ createdAt: days(400), lastBidAt: days(29), now })).toBe('active');
    expect(classifyBidderSegment({ createdAt: days(400), lastBidAt: days(30), now })).toBe('active');
    expect(classifyBidderSegment({ createdAt: days(400), lastBidAt: days(31), now })).toBe('lapsed');
    expect(classifyBidderSegment({ createdAt: days(400), lastBidAt: days(90), now })).toBe('lapsed');
    expect(classifyBidderSegment({ createdAt: days(400), lastBidAt: days(91), now })).toBe('dormant');
    expect(classifyBidderSegment({ createdAt: days(400), lastBidAt: days(400), now })).toBe('dormant');
  });

  it('boundary: exactly 30 days old is still "new"', () => {
    expect(classifyBidderSegment({ createdAt: days(30), lastBidAt: days(10), now })).toBe('new');
    expect(classifyBidderSegment({ createdAt: days(31), lastBidAt: days(10), now })).not.toBe('new');
  });
});

describe('rpcStateFrom', () => {
  it('maps PGRST202 / 42883 to needs_migration', () => {
    expect(rpcStateFrom(ZIP_HEAT_RPC, parseZipHeatRows, null, { code: 'PGRST202' })).toEqual({
      kind: 'needs_migration',
    });
    expect(rpcStateFrom(ZIP_HEAT_RPC, parseZipHeatRows, null, { code: '42883' })).toEqual({
      kind: 'needs_migration',
    });
  });

  it('maps 42501 to forbidden, and anything else to error', () => {
    expect(rpcStateFrom(ZIP_HEAT_RPC, parseZipHeatRows, null, { code: '42501' })).toEqual({ kind: 'forbidden' });
    expect(rpcStateFrom(ZIP_HEAT_RPC, parseZipHeatRows, null, { message: 'boom' })).toEqual({
      kind: 'error',
      message: 'boom',
    });
  });

  it('parses rows on success', () => {
    const raw = [{ postal_code: '72601', registered: 3, active_bidders_30d: 1, winners: 1, paid_revenue_cents: 100, share_bps: 10000 }];
    const state = rpcStateFrom(ZIP_HEAT_RPC, parseZipHeatRows, raw, null);
    expect(state.kind).toBe('ok');
    if (state.kind === 'ok') expect(state.rows).toHaveLength(1);
  });
});

// ── ZIP heat ────────────────────────────────────────────────────────────────

// Hand-worked fixture:
//   ZIP                   reg  active winners  revenue  share
//   72601                  5     2      1        115.00   50%
//   Other (fewer than 3)   2     1      1        115.00   50%
//   Unknown                5     1      0          0.00    0%
//   ───────────────────────────────────────────────────────
//   Total                 12     4      2        230.00  100%
const ZIP_HEAT_RAW = [
  { postal_code: '72601', registered: 5, active_bidders_30d: 2, winners: 1, paid_revenue_cents: 11500, share_bps: 5000 },
  { postal_code: 'Other (fewer than 3)', registered: 2, active_bidders_30d: 1, winners: 1, paid_revenue_cents: 11500, share_bps: 5000 },
  { postal_code: 'Unknown', registered: 5, active_bidders_30d: 1, winners: 0, paid_revenue_cents: 0, share_bps: null },
];

describe('parseZipHeatRows + totals', () => {
  it('parses rows and a missing postal_code as Unknown', () => {
    const rows = parseZipHeatRows(ZIP_HEAT_RAW);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      postalCode: '72601',
      registered: 5,
      activeBidders30d: 2,
      winners: 1,
      paidRevenueCents: 11500,
      shareBps: 5000,
    });
  });

  it('non-array input is an empty report, not a crash', () => {
    expect(parseZipHeatRows(null)).toEqual([]);
    expect(parseZipHeatRows(undefined)).toEqual([]);
  });

  it('totals sum every row; share is 100% when any revenue exists', () => {
    const rows = parseZipHeatRows(ZIP_HEAT_RAW);
    expect(zipHeatTotals(rows)).toEqual({
      registered: 12,
      activeBidders30d: 4,
      winners: 2,
      paidRevenueCents: 23000,
      shareBps: 10000,
    });
  });

  it('totals share is null when there is no revenue at all', () => {
    const rows: ZipHeatRow[] = [
      { postalCode: '72601', registered: 1, activeBidders30d: 0, winners: 0, paidRevenueCents: 0, shareBps: null },
    ];
    expect(zipHeatTotals(rows).shareBps).toBeNull();
  });
});

describe('sortZipHeatRows', () => {
  const rows = parseZipHeatRows(ZIP_HEAT_RAW);

  it('Other/Unknown stay last regardless of direction', () => {
    const asc = sortZipHeatRows(rows, 'registered', 'asc');
    expect(asc.map((r) => r.postalCode)).toEqual(['72601', 'Other (fewer than 3)', 'Unknown']);
    const desc = sortZipHeatRows(rows, 'registered', 'desc');
    expect(desc.map((r) => r.postalCode)).toEqual(['72601', 'Other (fewer than 3)', 'Unknown']);
  });

  it('sorts real ZIPs by a numeric column', () => {
    const withTwoRealZips = parseZipHeatRows([
      { postal_code: '72601', registered: 5, active_bidders_30d: 0, winners: 0, paid_revenue_cents: 100, share_bps: 100 },
      { postal_code: '72764', registered: 9, active_bidders_30d: 0, winners: 0, paid_revenue_cents: 900, share_bps: 900 },
    ]);
    expect(sortZipHeatRows(withTwoRealZips, 'registered', 'desc').map((r) => r.postalCode)).toEqual([
      '72764',
      '72601',
    ]);
    expect(sortZipHeatRows(withTwoRealZips, 'registered', 'asc').map((r) => r.postalCode)).toEqual([
      '72601',
      '72764',
    ]);
  });
});

describe('dollars + CSV', () => {
  it('dollars formats cents exactly, no float drift', () => {
    expect(dollars(11500)).toBe('115.00');
    expect(dollars(5)).toBe('0.05');
    expect(dollars(-150)).toBe('-1.50');
    expect(dollars(0)).toBe('0.00');
  });

  it('zipHeatCsvRows includes a Total row matching zipHeatTotals', () => {
    const rows = parseZipHeatRows(ZIP_HEAT_RAW);
    const csvRows = zipHeatCsvRows(rows);
    expect(csvRows[0]).toEqual(['zip', 'registered', 'active_last_30d', 'winners', 'paid_revenue_excl_tax', 'share_pct']);
    expect(csvRows.at(-1)).toEqual(['Total', '12', '4', '2', '230.00', '100.00']);
  });

  it('zipHeatCsv embeds the period/zip-prefix title line', () => {
    const csv = zipHeatCsv(parseZipHeatRows(ZIP_HEAT_RAW), { period: 'all time', zipPrefix: null });
    // The title cell itself has a comma, so csvCell quotes it.
    expect(csv.split('\n')[0]).toBe('"Bidder ZIP heat, all time",all ZIPs');
  });
});

// ── Segments ────────────────────────────────────────────────────────────────

describe('parseSegmentRows', () => {
  it('always returns all 5 segments in order, 0-filling anything missing', () => {
    const rows = parseSegmentRows([{ segment: 'active', bidders: 7 }]);
    expect(rows).toEqual([
      { segment: 'new', bidders: 0 },
      { segment: 'active', bidders: 7 },
      { segment: 'lapsed', bidders: 0 },
      { segment: 'dormant', bidders: 0 },
      { segment: 'never_bid', bidders: 0 },
    ]);
  });

  it('ignores an unrecognized segment key rather than throwing', () => {
    const rows = parseSegmentRows([{ segment: 'bogus', bidders: 99 }]);
    expect(rows.every((r) => r.bidders === 0)).toBe(true);
  });
});

describe('segmentZipMatrix', () => {
  // Hand-worked: matches the 0449 rig proof fixture (12 bidders total).
  const RAW = [
    { postal_code: '72601', segment: 'new', bidders: 1 },
    { postal_code: '72601', segment: 'active', bidders: 1 },
    { postal_code: '72601', segment: 'lapsed', bidders: 1 },
    { postal_code: '72601', segment: 'dormant', bidders: 1 },
    { postal_code: '72601', segment: 'never_bid', bidders: 1 },
    { postal_code: 'Other (fewer than 3)', segment: 'active', bidders: 1 },
    { postal_code: 'Other (fewer than 3)', segment: 'never_bid', bidders: 1 },
    { postal_code: 'Unknown', segment: 'active', bidders: 1 },
    { postal_code: 'Unknown', segment: 'lapsed', bidders: 2 },
    { postal_code: 'Unknown', segment: 'never_bid', bidders: 2 },
  ];

  it('pivots to one row per ZIP with a count per segment + a total', () => {
    const matrix = segmentZipMatrix(parseSegmentByZipRows(RAW));
    expect(matrix.map((m) => m.postalCode)).toEqual(['72601', 'Other (fewer than 3)', 'Unknown']);
    const zip = matrix.find((m) => m.postalCode === '72601')!;
    expect(zip.counts).toEqual({ new: 1, active: 1, lapsed: 1, dormant: 1, never_bid: 1 });
    expect(zip.total).toBe(5);
    const unknown = matrix.find((m) => m.postalCode === 'Unknown')!;
    expect(unknown.total).toBe(5);
  });

  it('CSV has one row per ZIP, columns in SEGMENT_ORDER, plus total', () => {
    const csv = segmentZipCsvRows(parseSegmentByZipRows(RAW));
    expect(csv[0]).toEqual(['zip', 'new', 'active', 'lapsed', 'dormant', 'never_bid', 'total']);
    expect(csv.find((r) => r[0] === '72601')).toEqual(['72601', '1', '1', '1', '1', '1', '5']);
  });
});

// ── Weekly cohorts ──────────────────────────────────────────────────────────

describe('buildCohortMatrix', () => {
  // Hand-worked: matches the 0449 rig proof (cohort of 3, 2 bid in week 1).
  const RAW = [
    { cohort_week: '2026-09-07', weeks_since: 0, cohort_size: 3, bid_pct: 0, win_pct: 0 },
    { cohort_week: '2026-09-07', weeks_since: 1, cohort_size: 3, bid_pct: 66.7, win_pct: 0 },
    { cohort_week: '2026-08-31', weeks_since: 0, cohort_size: 5, bid_pct: 20, win_pct: 0 },
    { cohort_week: '2026-08-31', weeks_since: 1, cohort_size: 5, bid_pct: 40, win_pct: 20 },
    { cohort_week: '2026-08-31', weeks_since: 2, cohort_size: 5, bid_pct: 0, win_pct: 0 },
  ];

  it('most-recent cohort first, fixed-width cells, missing offsets are null', () => {
    const matrix = buildCohortMatrix(parseCohortRows(RAW), 4);
    expect(matrix.map((m) => m.cohortWeek)).toEqual(['2026-09-07', '2026-08-31']);
    const recent = matrix[0]!;
    expect(recent.cohortSize).toBe(3);
    expect(recent.cells).toEqual([
      { bidPct: 0, winPct: 0 },
      { bidPct: 66.7, winPct: 0 },
      null,
      null,
    ]);
  });

  it('a weeks_since beyond the requested width is dropped, not out-of-bounds', () => {
    const matrix = buildCohortMatrix(
      parseCohortRows([{ cohort_week: '2026-01-05', weeks_since: 5, cohort_size: 4, bid_pct: 10, win_pct: 0 }]),
      3,
    );
    expect(matrix[0]!.cells).toHaveLength(3);
    expect(matrix[0]!.cells.every((c) => c === null)).toBe(true);
  });

  it('non-array / malformed rows parse to empty, not a crash', () => {
    expect(parseCohortRows(null)).toEqual([]);
    expect(parseCohortRows([{ weeks_since: 0 }])).toEqual([]); // no cohort_week
  });

  it('CSV emits one row per cohort with w{N}_bid_pct / w{N}_win_pct columns', () => {
    const csv = cohortCsvRows(parseCohortRows(RAW), 2);
    expect(csv[0]).toEqual(['cohort_week', 'cohort_size', 'w0_bid_pct', 'w0_win_pct', 'w1_bid_pct', 'w1_win_pct']);
    const recent = csv.find((r) => r[0] === '2026-09-07')!;
    expect(recent).toEqual(['2026-09-07', '3', '0.0', '0.0', '66.7', '0.0']);
  });
});
