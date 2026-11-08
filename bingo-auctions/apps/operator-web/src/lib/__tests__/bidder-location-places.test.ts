// City / state for /reports/bidder-zips (mig 0438): pure helpers, the CSV
// with places + GeoNames credit, the table's City column, and the loader's
// fall-back to 0434 before 0438 is applied. Synthetic rows, no customer data.
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BIDDER_LOCATION_RPC,
  BIDDER_PLACE_RPC,
  BIDDER_PLACES_RPC,
  GEONAMES_ATTRIBUTION,
  ZIP_COVERAGE_RPC,
  bidderLocationCsv,
  bidderLocationCsvRows,
  cityChoices,
  cityLabel,
  isMissingFunction,
  parseBidderLocationRows,
  parseCityName,
  parseStateCode,
  placeOptionsFrom,
  sortBidderLocationRows,
} from '@/lib/bidder-location';
import { BidderZipBody } from '@/app/(operator)/reports/bidder-zips/BidderZipBody';
import { loadBidderZips } from '@/app/(operator)/reports/bidder-zips/data';

const H = '00000000-0000-0000-0000-0000000000a1';

const PLACE_RPC_ROWS = [
  { postal_code: '72764', city: 'Springdale', state: 'AR', warehouse_id: H, warehouse_name: 'Harrison', registered: 3, active_bidders: 2, buyers: 1, paid_invoices: 1, sales_net_cents: 1150 },
  { postal_code: '99999', city: null, state: null, warehouse_id: null, warehouse_name: 'No activity in range', registered: 3, active_bidders: 0, buyers: 0, paid_invoices: 0, sales_net_cents: 0 },
  { postal_code: 'Other (fewer than 3)', city: null, state: null, warehouse_id: H, warehouse_name: 'Harrison', registered: 2, active_bidders: 1, buyers: 0, paid_invoices: 0, sales_net_cents: 0 },
  { postal_code: 'Unknown', city: null, state: null, warehouse_id: null, warehouse_name: 'No activity in range', registered: 4, active_bidders: 0, buyers: 0, paid_invoices: 0, sales_net_cents: 0 },
];
const rows = sortBidderLocationRows(parseBidderLocationRows(PLACE_RPC_ROWS));

describe('parseStateCode / parseCityName', () => {
  it.each([
    ['ar', 'AR'], [' MO ', 'MO'], ['', null], [undefined, null], ['A1', null], ['ARK', null], ['A', null],
  ])('state %j → %j', (input, out) => {
    expect(parseStateCode(input as string | undefined)).toBe(out);
  });
  it('city: trimmed and spaces collapsed; needs a state; 1–100 chars', () => {
    expect(parseCityName('  Fort   Smith ', 'AR')).toBe('Fort Smith');
    expect(parseCityName('Springdale', null)).toBeNull();
    expect(parseCityName('   ', 'AR')).toBeNull();
    expect(parseCityName('x'.repeat(101), 'AR')).toBeNull();
    expect(parseCityName(undefined, 'AR')).toBeNull();
  });
});

describe('rows with places', () => {
  it('parses city/state; null when absent (0434 rows have none)', () => {
    expect(rows[0]).toMatchObject({ postalCode: '72764', city: 'Springdale', state: 'AR' });
    const [old] = parseBidderLocationRows([{ postal_code: '72764', warehouse_name: 'Harrison' }]);
    expect(old).toMatchObject({ city: null, state: null });
  });
  it('cityLabel: place, Unlisted ZIP, blank for Other / Unknown', () => {
    expect(rows.map(cityLabel)).toEqual(['Springdale, AR', 'Unlisted ZIP', '', '']);
  });
});

describe('placeOptionsFrom (operator_bidder_places)', () => {
  it('state totals and cities per state, sorted', () => {
    const o = placeOptionsFrom(
      [
        { state: 'MO', city: null, registered: '3' },
        { state: 'AR', city: 'Springdale', registered: 4 },
        { state: 'AR', city: null, registered: 6 },
        { state: 'AR', city: 'Bentonville', registered: 3 },
        { state: 'bad', city: null, registered: 9 },
      ],
      null,
    );
    expect(o).toEqual({
      states: [{ code: 'AR', registered: 6 }, { code: 'MO', registered: 3 }],
      cities: { AR: [{ name: 'Bentonville', registered: 3 }, { name: 'Springdale', registered: 4 }] },
    });
  });
  it('fail-soft: error or non-array → null', () => {
    expect(placeOptionsFrom(null, { code: 'PGRST202' })).toBeNull();
    expect(placeOptionsFrom({}, null)).toBeNull();
  });
  it('cityChoices: the state’s cities, plus a URL city that is not one of them', () => {
    const o = placeOptionsFrom([{ state: 'AR', city: 'Springdale', registered: 4 }], null);
    expect(cityChoices(o, null, null)).toEqual([]);
    expect(cityChoices(o, 'AR', 'springdale')).toEqual([{ value: 'Springdale', label: 'Springdale' }]);
    expect(cityChoices(o, 'AR', 'Lowell')).toEqual([
      { value: 'Springdale', label: 'Springdale' },
      { value: 'Lowell', label: 'Lowell (fewer than 3 bidders)' },
    ]);
  });
});

describe('isMissingFunction', () => {
  it('PGRST202 / 42883 / message naming the function → true; other errors and null → false', () => {
    expect(isMissingFunction({ code: 'PGRST202' }, BIDDER_PLACE_RPC)).toBe(true);
    expect(isMissingFunction({ code: '42883' }, BIDDER_PLACE_RPC)).toBe(true);
    expect(isMissingFunction({ message: `Could not find the function public.${BIDDER_PLACE_RPC}` }, BIDDER_PLACE_RPC)).toBe(true);
    expect(isMissingFunction({ code: '42501', message: 'bidder_location_forbidden' }, BIDDER_PLACE_RPC)).toBe(false);
    expect(isMissingFunction({ code: '22023', message: 'invalid_city' }, BIDDER_PLACE_RPC)).toBe(false);
    expect(isMissingFunction(null, BIDDER_PLACE_RPC)).toBe(false);
  });
});

describe('CSV with places', () => {
  it('city + state after zip; Unlisted ZIP; blanks on Other / Unknown; Total aligned', () => {
    const out = bidderLocationCsvRows(rows, { places: true });
    expect(out[0]).toEqual(['zip', 'city', 'state', 'location', 'registered', 'active_bidders', 'buyers', 'paid_invoices', 'sales_net_excl_tax']);
    expect(out[1]).toEqual(['72764', 'Springdale', 'AR', 'Harrison', '3', '2', '1', '1', '11.50']);
    expect(out[2]).toEqual(['99999', 'Unlisted ZIP', '', 'No activity in range', '3', '0', '0', '0', '0.00']);
    expect(out[3]).toEqual(['Other (fewer than 3)', '', '', 'Harrison', '2', '1', '0', '0', '0.00']);
    expect(out.at(-1)).toEqual(['Total', '', '', '', '12', '3', '1', '1', '11.50']);
    for (const l of out) expect(l).toHaveLength(9);
  });
  it('without places the file is exactly the 0434 shape (no credit line)', () => {
    const csv = bidderLocationCsv(rows, { period: 'all time', location: 'All locations', zipPrefix: null, timeZone: 'America/Chicago' });
    expect(csv).not.toContain('GeoNames');
    expect(csv.split('\n')[1]).toBe('zip,location,registered,active_bidders,buyers,paid_invoices,sales_net_excl_tax');
  });
  it('with places: the filter in the title, GeoNames credit as the last line', () => {
    const csv = bidderLocationCsv(rows, {
      period: 'all time', location: 'All locations', zipPrefix: null, timeZone: 'America/Chicago',
      places: true, state: 'AR', city: 'Springdale',
    });
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('"Bidders by ZIP, all time",All locations,all ZIPs,"Springdale, AR",dates in America/Chicago');
    expect(lines.at(-1)).toBe(`"${GEONAMES_ATTRIBUTION}"`); // one quoted cell (it has a comma)
    expect(lines.at(-2)).toBe('Total,,,,12,3,1,1,11.50');
  });
});

describe('BidderZipBody with places', () => {
  it('City column and the GeoNames credit with links', () => {
    const html = renderToString(BidderZipBody({ state: { kind: 'ok', rows }, zipPrefix: null, coverage: null, showPlaces: true }));
    expect(html).toContain('<th>City</th>');
    expect(html).toContain('Springdale, AR');
    expect(html).toContain('Unlisted ZIP');
    expect(html).toContain('href="https://www.geonames.org"');
    expect(html).toContain('href="https://creativecommons.org/licenses/by/4.0/"');
    expect(html).toContain('CC BY 4.0');
  });
  it('before 0438: no City column, no GeoNames text', () => {
    const html = renderToString(BidderZipBody({ state: { kind: 'ok', rows }, zipPrefix: null, coverage: null }));
    expect(html).not.toContain('<th>City</th>');
    expect(html).not.toContain('GeoNames');
  });
  it('a place filter hides the coverage line with its own note', () => {
    const html = renderToString(
      BidderZipBody({ state: { kind: 'ok', rows }, zipPrefix: null, coverage: { withZip: 1, registered: 2, percent: 50 }, showPlaces: true, placeFilter: 'AR' }),
    );
    expect(html).not.toContain('registered bidders have a ZIP');
    expect(html).toContain('without a city or state filter');
  });
});

// ── loader: degrade before 0438 ─────────────────────────────────────────────
type Call = { fn: string; args?: Record<string, unknown> };
function fakeSupabase(rpc: (fn: string, args?: Record<string, unknown>) => { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'order']) c[k] = () => c;
    c.single = async () => result;
    c.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
    return c;
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: (table: string) =>
      table === 'operator_users'
        ? chain({ data: { operator_id: 'op1', role: 'admin' } })
        : chain({ data: [{ id: 'w1', name: 'Harrison', timezone: 'America/Chicago', created_at: '2026-01-01', active: true }] }),
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      calls.push({ fn, args });
      return rpc(fn, args);
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}
const missing = { code: 'PGRST202', message: 'Could not find the function in the schema cache' };

describe('loadBidderZips', () => {
  it('before 0438: falls back to 0434, ignores ?state=/?city=, still shows coverage', async () => {
    const { client, calls } = fakeSupabase((fn) => {
      if (fn === BIDDER_PLACE_RPC || fn === BIDDER_PLACES_RPC) return { data: null, error: missing };
      if (fn === BIDDER_LOCATION_RPC) return { data: [{ postal_code: '72764', warehouse_name: 'Harrison', registered: 3 }], error: null };
      if (fn === ZIP_COVERAGE_RPC) return { data: [{ registered: 10, with_zip: 5 }], error: null };
      return { data: null, error: { message: 'unexpected' } };
    });
    const r = await loadBidderZips(client, { state: 'ar', city: 'Springdale' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.places).toEqual({ available: false, state: null, city: null, options: null });
    expect(r.state.kind).toBe('ok');
    expect(r.coverage).toEqual({ withZip: 5, registered: 10, percent: 50 });
    const fallback = calls.find((c) => c.fn === BIDDER_LOCATION_RPC)!;
    expect(fallback.args).not.toHaveProperty('p_state');
    expect(fallback.args).not.toHaveProperty('p_city');
  });

  it('before 0434 too: the calm needs-migration state, no crash', async () => {
    const { client } = fakeSupabase(() => ({ data: null, error: missing }));
    const r = await loadBidderZips(client, {});
    if (!r.ok) throw new Error('expected ok');
    expect(r.state.kind).toBe('needs_migration');
    expect(r.places.available).toBe(false);
  });

  it('after 0438: one by-place call with the filters, options loaded, coverage skipped under a state', async () => {
    const { client, calls } = fakeSupabase((fn) => {
      if (fn === BIDDER_PLACE_RPC) return { data: PLACE_RPC_ROWS, error: null };
      if (fn === BIDDER_PLACES_RPC) return { data: [{ state: 'AR', city: null, registered: 6 }, { state: 'AR', city: 'Springdale', registered: 4 }], error: null };
      return { data: null, error: { message: `unexpected ${fn}` } };
    });
    const r = await loadBidderZips(client, { state: 'ar', city: ' springdale ' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.places.available).toBe(true);
    expect(r.places.state).toBe('AR');
    expect(r.places.city).toBe('springdale');
    expect(r.places.options?.cities.AR).toEqual([{ name: 'Springdale', registered: 4 }]);
    expect(r.coverage).toBeNull();
    expect(calls.map((c) => c.fn).sort()).toEqual([BIDDER_PLACE_RPC, BIDDER_PLACES_RPC].sort());
    expect(calls.find((c) => c.fn === BIDDER_PLACE_RPC)!.args).toMatchObject({ p_state: 'AR', p_city: 'springdale', p_zip_prefix: null });
    if (r.state.kind === 'ok') expect(r.state.rows[0]).toMatchObject({ city: 'Springdale', state: 'AR' });
  });

  it('after 0438, a city without a state is dropped before the call (the RPC would refuse it)', async () => {
    const { client, calls } = fakeSupabase((fn) =>
      fn === BIDDER_PLACE_RPC || fn === BIDDER_PLACES_RPC ? { data: [], error: null } : { data: [{ registered: 1, with_zip: 1 }], error: null },
    );
    const r = await loadBidderZips(client, { city: 'Springdale' });
    if (!r.ok) throw new Error('expected ok');
    expect(calls.find((c) => c.fn === BIDDER_PLACE_RPC)!.args).toMatchObject({ p_state: null, p_city: null });
    expect(r.coverage).not.toBeNull();
  });
});
