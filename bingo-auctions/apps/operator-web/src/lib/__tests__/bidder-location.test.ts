// Pure helpers for /reports/bidder-zips (mig 0434). Synthetic fixture, no
// customer data. The RPC rows below, hand-worked:
//
//   ZIP                   location             reg  active buyers paid  sales_net
//   72601                 Harrison              12     8     5     9   452.10
//   72601                 Springdale             4     3     2     2    80.00  ← refund-reduced:
//                                                                              105.00 excl. tax − 25.00 refund
//   72764                 Springdale             6     4     3     4   150.75
//   Other (fewer than 3)  Harrison               5     2     1     1    19.99
//   Unknown               No activity in range   7     0     0     0     0.00
//   Unknown               Harrison               3     3     1     2    33.00
//   ─────────────────────────────────────────────────────────────────────────
//   Total                                       37    20    12    18   735.84
//     reg    12+4+6+5+7+3        = 37
//     active  8+3+4+2+0+3        = 20
//     buyers  5+2+3+1+0+1        = 12
//     paid    9+2+4+1+0+2        = 18
//     sales  45210+8000+15075+1999+0+3300 = 73584 cents
//   Coverage is NOT derived from these rows: it comes from its own RPC,
//   operator_bidder_zip_coverage() (mig 0434), which counts each bidder once.
//   Summing registered here would double-count a bidder active at two locations.
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  bidderLocationCsv,
  bidderLocationCsvRows,
  bidderLocationStateFrom,
  bidderLocationTotals,
  bidderZipFieldFrom,
  coverageLine,
  dollars,
  parseBidderLocationRows,
  parseZipPrefix,
  reportTimeZone,
  sortBidderLocationRows,
  zipCoverageFrom,
} from '@/lib/bidder-location';
import { BidderZipBody } from '@/app/(operator)/reports/bidder-zips/BidderZipBody';

const H = '00000000-0000-0000-0000-0000000000a1';
const S = '00000000-0000-0000-0000-0000000000b2';

// Shape as PostgREST returns RETURNS TABLE rows; bigint may arrive as strings.
const RPC = [
  { postal_code: 'Unknown', warehouse_id: H, warehouse_name: 'Harrison', registered: 3, active_bidders: 3, buyers: 1, paid_invoices: 2, sales_net_cents: 3300 },
  { postal_code: '72764', warehouse_id: S, warehouse_name: 'Springdale', registered: '6', active_bidders: '4', buyers: '3', paid_invoices: '4', sales_net_cents: '15075' },
  { postal_code: 'Other (fewer than 3)', warehouse_id: H, warehouse_name: 'Harrison', registered: 5, active_bidders: 2, buyers: 1, paid_invoices: 1, sales_net_cents: 1999 },
  { postal_code: '72601', warehouse_id: S, warehouse_name: 'Springdale', registered: 4, active_bidders: 3, buyers: 2, paid_invoices: 2, sales_net_cents: 8000 },
  { postal_code: 'Unknown', warehouse_id: null, warehouse_name: 'No activity in range', registered: 7, active_bidders: 0, buyers: 0, paid_invoices: 0, sales_net_cents: 0 },
  { postal_code: '72601', warehouse_id: H, warehouse_name: 'Harrison', registered: 12, active_bidders: 8, buyers: 5, paid_invoices: 9, sales_net_cents: 45210 },
];

const rows = parseBidderLocationRows(RPC);

describe('parseBidderLocationRows', () => {
  it('coerces bigint strings and keeps the refund-reduced sales as returned', () => {
    const sp = rows.find((r) => r.postalCode === '72764')!;
    expect(sp.registered).toBe(6);
    expect(sp.salesNetCents).toBe(15075);
    // 105.00 excl. tax − 25.00 refund = 80.00; the page shows the RPC figure, it does not re-derive it.
    expect(rows.find((r) => r.postalCode === '72601' && r.warehouseId === S)!.salesNetCents).toBe(10500 - 2500);
  });

  it('non-array → []; missing labels fall back to Unknown / No activity in range', () => {
    expect(parseBidderLocationRows(null)).toEqual([]);
    expect(parseBidderLocationRows({})).toEqual([]);
    const [r] = parseBidderLocationRows([{ postal_code: null, warehouse_name: null }]);
    expect(r).toMatchObject({ postalCode: 'Unknown', warehouseName: 'No activity in range', registered: 0 });
  });
});

describe('sortBidderLocationRows', () => {
  it('ZIPs ascending, then Other, then Unknown; No activity last within a ZIP', () => {
    expect(sortBidderLocationRows(rows).map((r) => `${r.postalCode}/${r.warehouseName}`)).toEqual([
      '72601/Harrison',
      '72601/Springdale',
      '72764/Springdale',
      'Other (fewer than 3)/Harrison',
      'Unknown/Harrison',
      'Unknown/No activity in range',
    ]);
  });
});

describe('bidderLocationTotals', () => {
  it('matches the hand-worked total', () => {
    expect(bidderLocationTotals(rows)).toEqual({
      registered: 37,
      activeBidders: 20,
      buyers: 12,
      paidInvoices: 18,
      salesNetCents: 73584,
    });
  });

  it('equals the sum of the rows, column by column', () => {
    const t = bidderLocationTotals(rows);
    for (const k of ['registered', 'activeBidders', 'buyers', 'paidInvoices', 'salesNetCents'] as const) {
      expect(t[k]).toBe(rows.reduce((a, r) => a + r[k], 0));
    }
  });

  it('is all zeros for no rows', () => {
    expect(bidderLocationTotals([])).toEqual({ registered: 0, activeBidders: 0, buyers: 0, paidInvoices: 0, salesNetCents: 0 });
  });
});

describe('zipCoverageFrom (operator_bidder_zip_coverage, mig 0434)', () => {
  it('one bidder active at two locations: rows sum registered = 2, coverage = 1 of 1', () => {
    // Hand-checked: one bidder, ZIP 72601, bid at Harrison AND Springdale in the
    // window. The location report gives them a row per location:
    //   72601 / Harrison    registered 1
    //   72601 / Springdale  registered 1      → Σ registered = 2 (double count)
    // The coverage RPC counts the bidder once: registered 1, with_zip 1 → 1 of 1, 100%.
    const twoLocations = parseBidderLocationRows([
      { postal_code: '72601', warehouse_id: H, warehouse_name: 'Harrison', registered: 1, active_bidders: 1 },
      { postal_code: '72601', warehouse_id: S, warehouse_name: 'Springdale', registered: 1, active_bidders: 1 },
    ]);
    expect(bidderLocationTotals(twoLocations).registered).toBe(2);
    const c = zipCoverageFrom([{ registered: 1, with_zip: 1 }], null)!;
    expect(c).toEqual({ withZip: 1, registered: 1, percent: 100 });
    expect(coverageLine(c)).toBe('1 of 1 registered bidders have a ZIP (100%)');
  });

  it('bigint strings, and a single object as well as a one-row array', () => {
    // 27 of 37 → 72.97% → 73%
    expect(zipCoverageFrom([{ registered: '37', with_zip: '27' }], null)).toEqual({ withZip: 27, registered: 37, percent: 73 });
    expect(zipCoverageFrom({ registered: 37, with_zip: 27 }, null)).toEqual({ withZip: 27, registered: 37, percent: 73 });
  });

  it('no registered bidders → no percent (no 0/0)', () => {
    const c = zipCoverageFrom([{ registered: 0, with_zip: 0 }], null)!;
    expect(c).toEqual({ withZip: 0, registered: 0, percent: null });
    expect(coverageLine(c)).toBe('0 of 0 registered bidders have a ZIP');
  });

  it('thousands separators: 1,234 of 2,000 → 62% (61.7 rounds up)', () => {
    expect(coverageLine(zipCoverageFrom([{ registered: 2000, with_zip: 1234 }], null)!)).toBe(
      '1,234 of 2,000 registered bidders have a ZIP (62%)',
    );
  });

  it('fail-soft: missing function, any error, or a bad payload → null (line hidden)', () => {
    expect(zipCoverageFrom(null, { code: 'PGRST202', message: 'Could not find the function public.operator_bidder_zip_coverage' })).toBeNull();
    expect(zipCoverageFrom([{ registered: 5, with_zip: 3 }], { code: '42501', message: 'forbidden' })).toBeNull();
    expect(zipCoverageFrom([], null)).toBeNull();
    expect(zipCoverageFrom(null, null)).toBeNull();
    expect(zipCoverageFrom([{ registered: 'x', with_zip: 1 }], null)).toBeNull();
  });
});

describe('parseZipPrefix', () => {
  it.each([
    ['726', '726'],
    [' 72601 ', '72601'],
    ['7', '7'],
    ['', null],
    [undefined, null],
    ['726011', null],
    ['72a', null],
    ['Harrison', null],
  ])('%s → %s', (v, out) => {
    expect(parseZipPrefix(v as string | undefined)).toBe(out);
  });
});

describe('formatting', () => {
  it('dollars() is exact on cents', () => {
    expect(dollars(73584)).toBe('735.84');
    expect(dollars(5)).toBe('0.05');
    expect(dollars(0)).toBe('0.00');
    expect(dollars(-2500)).toBe('-25.00');
  });
});

describe('CSV', () => {
  it('header, every row, and a Total that is the sum of the rows', () => {
    const out = bidderLocationCsvRows(sortBidderLocationRows(rows));
    expect(out[0]).toEqual(['zip', 'location', 'registered', 'active_bidders', 'buyers', 'paid_invoices', 'sales_net_excl_tax']);
    expect(out[1]).toEqual(['72601', 'Harrison', '12', '8', '5', '9', '452.10']);
    expect(out[2]).toEqual(['72601', 'Springdale', '4', '3', '2', '2', '80.00']);
    expect(out[4]).toEqual(['Other (fewer than 3)', 'Harrison', '5', '2', '1', '1', '19.99']);
    expect(out[6]).toEqual(['Unknown', 'No activity in range', '7', '0', '0', '0', '0.00']);
    expect(out[7]).toEqual(['Total', '', '37', '20', '12', '18', '735.84']);
    expect(out).toHaveLength(8);
  });

  it('full file: quoted title line, then data', () => {
    const csv = bidderLocationCsv(sortBidderLocationRows(rows), {
      period: '2026-10-01 to 2026-10-31',
      location: 'All locations',
      zipPrefix: '726',
      timeZone: 'America/Chicago',
    });
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('"Bidders by ZIP, 2026-10-01 to 2026-10-31",All locations,ZIP starts with 726,dates in America/Chicago');
    expect(lines[1]).toBe('zip,location,registered,active_bidders,buyers,paid_invoices,sales_net_excl_tax');
    expect(lines[5]).toBe('Other (fewer than 3),Harrison,5,2,1,1,19.99');
    expect(lines.at(-1)).toBe('Total,,37,20,12,18,735.84');
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('has no person fields in the header', () => {
    const header = bidderLocationCsvRows([])[0]!.join(',');
    expect(header).not.toMatch(/name|email|phone/i);
  });
});

describe('bidderLocationStateFrom', () => {
  it('PGRST202 (function not in schema cache) → needs_migration', () => {
    expect(
      bidderLocationStateFrom(null, {
        code: 'PGRST202',
        message: 'Could not find the function public.operator_bidder_location_summary(p_from, p_to, p_warehouse_id, p_zip_prefix) in the schema cache',
      }),
    ).toEqual({ kind: 'needs_migration' });
  });
  it('42883 undefined_function → needs_migration', () => {
    expect(bidderLocationStateFrom(null, { code: '42883', message: 'function does not exist' })).toEqual({ kind: 'needs_migration' });
  });
  it('42501 → forbidden; anything else → error with its message', () => {
    expect(bidderLocationStateFrom(null, { code: '42501', message: 'forbidden' })).toEqual({ kind: 'forbidden' });
    expect(bidderLocationStateFrom(null, { code: '57014', message: 'canceling statement' })).toEqual({ kind: 'error', message: 'canceling statement' });
  });
  it('no error → ok with parsed rows', () => {
    const s = bidderLocationStateFrom(RPC, null);
    expect(s.kind).toBe('ok');
    if (s.kind === 'ok') expect(s.rows).toHaveLength(6);
  });
});

describe('BidderZipBody', () => {
  it('renders the calm needs-0434 banner, no table, no crash', () => {
    const html = renderToString(BidderZipBody({ state: { kind: 'needs_migration' }, zipPrefix: null, coverage: null }));
    expect(html).toContain('This report needs migration 0434');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('var(--danger)');
  });

  const coverage = { withZip: 27, registered: 30, percent: 90 };

  it('renders the coverage line from the coverage RPC (not the row sum), rows and Total', () => {
    const html = renderToString(BidderZipBody({ state: { kind: 'ok', rows }, zipPrefix: null, coverage }));
    // rows sum registered = 37; the RPC's once-per-bidder count (30) is what shows.
    expect(html).toContain('27 of 30 registered bidders have a ZIP (90%)');
    expect(html).not.toContain('of 37 registered');
    expect(html).toContain('Other (fewer than 3)');
    expect(html).toContain('Total');
    expect(html).toContain('$735.84');
    expect(html).not.toMatch(/@|mailto:|tel:/);
  });

  it('hides coverage under a ZIP prefix (Unknown can never match one)', () => {
    const html = renderToString(BidderZipBody({ state: { kind: 'ok', rows }, zipPrefix: '726', coverage }));
    expect(html).not.toContain('registered bidders have a ZIP');
    expect(html).toContain('ZIP coverage is shown without a ZIP filter');
  });

  it('hides the coverage line when the coverage RPC is missing or errored (coverage null)', () => {
    const html = renderToString(BidderZipBody({ state: { kind: 'ok', rows }, zipPrefix: null, coverage: null }));
    expect(html).not.toContain('registered bidders have a ZIP');
    expect(html).not.toContain('ZIP coverage is shown');
    expect(html).toContain('$735.84');
  });
});

describe('reportTimeZone', () => {
  const whs = [
    { id: S, timezone: 'America/Denver', created_at: '2026-08-24T00:00:00Z' },
    { id: H, timezone: 'America/Chicago', created_at: '2026-05-22T00:00:00Z' },
  ];
  it('selected location zone, else first-created warehouse, else Central', () => {
    expect(reportTimeZone(whs, S)).toBe('America/Denver');
    expect(reportTimeZone(whs, null)).toBe('America/Chicago');
    expect(reportTimeZone([], null)).toBe('America/Chicago');
  });
});

describe('bidderZipFieldFrom (bidder detail, pre-0434 safe)', () => {
  it('column missing (42703) → not available, row omitted', () => {
    expect(bidderZipFieldFrom(null, { code: '42703', message: 'column bidders.postal_code does not exist' })).toEqual({ available: false });
  });
  it('column present, bidder has no ZIP → available, zip null', () => {
    expect(bidderZipFieldFrom({ postal_code: null, postal_code_updated_at: null }, null)).toEqual({ available: true, zip: null, updatedAt: null });
  });
  it('column present with a ZIP and timestamp', () => {
    expect(bidderZipFieldFrom({ postal_code: '72601', postal_code_updated_at: '2026-10-20T15:00:00Z' }, null)).toEqual({
      available: true,
      zip: '72601',
      updatedAt: '2026-10-20T15:00:00Z',
    });
  });
});
