// Bidders by ZIP (mig 0434, operator_bidder_location_summary; mig 0438 adds
// city/state via operator_bidder_location_summary_by_place) — the pure half
// of /reports/bidder-zips: parse the RPC rows, classify its error, add the
// totals row, work out ZIP coverage, the place filters and build the CSV.
//
// All joins, the privacy roll-up (groups under 3 → 'Other (fewer than 3)') and
// the net-of-tax-and-refunds sales figure happen inside the SQL function.
// Nothing here re-derives money; the totals row is a plain Σ of the rows the
// function returned. Aggregates only: there is no name, email or phone field
// anywhere in these types, by design.

import { DEFAULT_TIME_ZONE } from '@/lib/datetime';

export const BIDDER_LOCATION_RPC = 'operator_bidder_location_summary';
/** 0438: same report + city/state columns and p_state / p_city filters. */
export const BIDDER_PLACE_RPC = 'operator_bidder_location_summary_by_place';
/** 0438: state / city filter choices, each with >= 3 registered bidders. */
export const BIDDER_PLACES_RPC = 'operator_bidder_places';

/**
 * GeoNames licence (CC BY 4.0) requires this credit wherever its ZIP places
 * are shown or exported: under the report and as the CSV's last line.
 */
export const GEONAMES_ATTRIBUTION = 'ZIP places © GeoNames (geonames.org), CC BY 4.0';
export const GEONAMES_URL = 'https://www.geonames.org';
export const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/';
/** Label for a real ZIP that zip_reference does not list. */
export const UNLISTED_ZIP = 'Unlisted ZIP';

/** Labels the function uses for the two non-ZIP groups (contract, mig 0434). */
export const UNKNOWN_ZIP = 'Unknown';
export const OTHER_ZIP = 'Other (fewer than 3)';
export const NO_ACTIVITY_LOCATION = 'No activity in range';

export type BidderLocationRow = {
  postalCode: string;
  /** 0438: GeoNames' place for the ZIP; null on Other / Unknown, unlisted ZIPs, or before 0438. */
  city: string | null;
  state: string | null;
  warehouseId: string | null;
  warehouseName: string;
  registered: number;
  activeBidders: number;
  buyers: number;
  paidInvoices: number;
  salesNetCents: number;
};

export type BidderLocationTotals = Omit<
  BidderLocationRow,
  'postalCode' | 'city' | 'state' | 'warehouseId' | 'warehouseName'
>;

const num = (v: unknown): number => {
  // bigint columns arrive from PostgREST as numbers or numeric strings.
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function parseBidderLocationRows(raw: unknown): BidderLocationRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      postalCode: typeof o.postal_code === 'string' && o.postal_code ? o.postal_code : UNKNOWN_ZIP,
      city: typeof o.city === 'string' && o.city ? o.city : null,
      state: typeof o.state === 'string' && o.state ? o.state : null,
      warehouseId: typeof o.warehouse_id === 'string' ? o.warehouse_id : null,
      warehouseName:
        typeof o.warehouse_name === 'string' && o.warehouse_name ? o.warehouse_name : NO_ACTIVITY_LOCATION,
      registered: num(o.registered),
      activeBidders: num(o.active_bidders),
      buyers: num(o.buyers),
      paidInvoices: num(o.paid_invoices),
      salesNetCents: num(o.sales_net_cents),
    };
  });
}

/** Rank for sorting: real ZIPs first (ascending), then Other, then Unknown. */
function zipRank(z: string): number {
  if (z === UNKNOWN_ZIP) return 2;
  if (z === OTHER_ZIP) return 1;
  return 0;
}

/**
 * Display order: ZIPs ascending, then the 'Other' roll-up, then 'Unknown';
 * within a ZIP, locations by name with 'No activity in range' last.
 */
export function sortBidderLocationRows(rows: BidderLocationRow[]): BidderLocationRow[] {
  return [...rows].sort((a, b) => {
    const r = zipRank(a.postalCode) - zipRank(b.postalCode);
    if (r) return r;
    if (a.postalCode !== b.postalCode) return a.postalCode < b.postalCode ? -1 : 1;
    const na = a.warehouseName === NO_ACTIVITY_LOCATION ? 1 : 0;
    const nb = b.warehouseName === NO_ACTIVITY_LOCATION ? 1 : 0;
    if (na !== nb) return na - nb;
    return a.warehouseName.localeCompare(b.warehouseName);
  });
}

/** Totals row = Σ of every row the function returned. */
export function bidderLocationTotals(rows: BidderLocationRow[]): BidderLocationTotals {
  return rows.reduce<BidderLocationTotals>(
    (t, r) => ({
      registered: t.registered + r.registered,
      activeBidders: t.activeBidders + r.activeBidders,
      buyers: t.buyers + r.buyers,
      paidInvoices: t.paidInvoices + r.paidInvoices,
      salesNetCents: t.salesNetCents + r.salesNetCents,
    }),
    { registered: 0, activeBidders: 0, buyers: 0, paidInvoices: 0, salesNetCents: 0 },
  );
}

export const ZIP_COVERAGE_RPC = 'operator_bidder_zip_coverage';

export type ZipCoverage = { withZip: number; registered: number; percent: number | null };

/**
 * "X of Y registered bidders have a ZIP", from operator_bidder_zip_coverage()
 * (mig 0434): one row, each of the operator's bidders counted ONCE. Not
 * derived from the report rows: a bidder active at two locations appears in
 * two rows there, so summing `registered` would double-count them.
 *
 * Fail-soft: any error (incl. the function missing before 0434) or an
 * unexpected payload -> null, and the page hides the line. percent is
 * whole-number rounded; null when there are no registered bidders (no 0/0).
 */
export function zipCoverageFrom(data: unknown, error: unknown): ZipCoverage | null {
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (row == null || typeof row !== 'object') return null;
  const o = row as Record<string, unknown>;
  const registered = Number(o.registered);
  const withZip = Number(o.with_zip);
  if (!Number.isFinite(registered) || !Number.isFinite(withZip) || registered < 0 || withZip < 0) return null;
  return {
    withZip,
    registered,
    percent: registered > 0 ? Math.round((withZip / registered) * 100) : null,
  };
}

export function coverageLine(c: ZipCoverage): string {
  const base = `${c.withZip.toLocaleString('en-US')} of ${c.registered.toLocaleString('en-US')} registered bidders have a ZIP`;
  return c.percent == null ? base : `${base} (${c.percent}%)`;
}

/**
 * ZIP-prefix filter from the URL: 1–5 digits, else null (ignored). Anything
 * else is dropped rather than sent, so a typo shows all ZIPs, not an empty
 * report that looks like "no bidders".
 */
export function parseZipPrefix(v: string | undefined | null): string | null {
  const s = (v ?? '').trim();
  return /^\d{1,5}$/.test(s) ? s : null;
}

// ── City / state (mig 0438) ─────────────────────────────────────────────────

/** ?state=: two letters → upper case, else null (ignored, like a bad ZIP prefix). */
export function parseStateCode(v: string | undefined | null): string | null {
  const s = (v ?? '').trim();
  return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : null;
}

/**
 * ?city=: trimmed, inner spaces collapsed, 1–100 characters, else null. A city
 * only counts with a state (names repeat across states; the RPC refuses a city
 * alone), so callers pass the parsed state.
 */
export function parseCityName(v: string | undefined | null, state: string | null): string | null {
  if (!state) return null;
  const s = (v ?? '').trim().replace(/\s+/g, ' ');
  return s.length >= 1 && s.length <= 100 ? s : null;
}

/** City cell: real ZIP → its place (or 'Unlisted ZIP'); Other / Unknown → ''. */
export function cityLabel(r: Pick<BidderLocationRow, 'postalCode' | 'city' | 'state'>): string {
  if (r.postalCode === UNKNOWN_ZIP || r.postalCode === OTHER_ZIP) return '';
  if (!r.city) return UNLISTED_ZIP;
  return r.state ? `${r.city}, ${r.state}` : r.city;
}

export type PlaceOptions = {
  states: Array<{ code: string; registered: number }>;
  /** Cities per state code, by name. */
  cities: Record<string, Array<{ name: string; registered: number }>>;
};

/**
 * operator_bidder_places() rows → dropdown options. A row with city NULL is a
 * state total. Fail-soft: any error (incl. the function missing before 0438)
 * or a bad payload → null, and the page hides the filters.
 */
export function placeOptionsFrom(data: unknown, error: unknown): PlaceOptions | null {
  if (error || !Array.isArray(data)) return null;
  const out: PlaceOptions = { states: [], cities: {} };
  for (const r of data) {
    const o = (r ?? {}) as Record<string, unknown>;
    const code = typeof o.state === 'string' ? o.state : '';
    if (!/^[A-Z]{2}$/.test(code)) continue;
    const n = Number(o.registered);
    const registered = Number.isFinite(n) ? n : 0;
    if (typeof o.city === 'string' && o.city) {
      (out.cities[code] ??= []).push({ name: o.city, registered });
    } else {
      out.states.push({ code, registered });
    }
  }
  out.states.sort((a, b) => a.code.localeCompare(b.code));
  for (const list of Object.values(out.cities)) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * City dropdown entries for a state: the >= 3-bidder cities, plus the current
 * ?city= if it isn't one of them (so the select shows what the URL filters on).
 */
export function cityChoices(
  options: PlaceOptions | null,
  state: string | null,
  current: string | null,
): Array<{ value: string; label: string }> {
  if (!state) return [];
  const list = (options?.cities[state] ?? []).map((c) => ({ value: c.name, label: c.name }));
  if (current && !list.some((c) => c.value.toLowerCase() === current.toLowerCase())) {
    list.push({ value: current, label: `${current} (fewer than 3 bidders)` });
  }
  return list;
}

/** True when a PostgREST / Postgres error says this RPC doesn't exist (yet). */
export function isMissingFunction(
  error: { code?: string; message?: string } | null | undefined,
  rpc: string,
): boolean {
  if (!error) return false;
  if (error.code === 'PGRST202' || error.code === '42883') return true;
  const msg = error.message ?? '';
  return msg.includes(rpc) && /could not find|does not exist/i.test(msg);
}

// ── RPC result → page state ─────────────────────────────────────────────────

export type BidderLocationState =
  | { kind: 'ok'; rows: BidderLocationRow[] }
  | { kind: 'needs_migration' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string };

/**
 * Classify the RPC outcome. Before 0434 is applied, PostgREST answers
 * PGRST202 ("Could not find the function … in the schema cache"); a direct
 * Postgres call would be 42883 (undefined_function). Either → the calm
 * "needs migration 0434" banner, never a crash. 42501 = the function's own
 * admin/manager refusal.
 */
export function bidderLocationStateFrom(
  data: unknown,
  error: { code?: string; message?: string } | null,
): BidderLocationState {
  if (error) {
    const msg = error.message ?? '';
    if (
      error.code === 'PGRST202' ||
      error.code === '42883' ||
      (msg.includes(BIDDER_LOCATION_RPC) && /could not find|does not exist/i.test(msg))
    ) {
      return { kind: 'needs_migration' };
    }
    if (error.code === '42501') return { kind: 'forbidden' };
    return { kind: 'error', message: msg || 'Unknown error' };
  }
  return { kind: 'ok', rows: parseBidderLocationRows(data) };
}

export type WarehouseZone = { id: string; timezone: string | null; created_at: string | null };

/** Dates are read in the picked location's zone; on All, the first-created warehouse's. */
export function reportTimeZone(warehouses: WarehouseZone[], selectedId: string | null): string {
  if (selectedId) {
    const w = warehouses.find((x) => x.id === selectedId);
    if (w?.timezone) return w.timezone;
  }
  const first = [...warehouses].sort((a, b) =>
    String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')),
  )[0];
  return first?.timezone || DEFAULT_TIME_ZONE;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

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

export const BIDDER_LOCATION_CSV_HEADER = [
  'zip',
  'location',
  'registered',
  'active_bidders',
  'buyers',
  'paid_invoices',
  'sales_net_excl_tax',
] as const;

/**
 * Data lines (header + rows + Total), no title line — what the CSV body is.
 * places: add city + state after zip (0438 data; the caller adds the credit).
 */
export function bidderLocationCsvRows(rows: BidderLocationRow[], opts: { places?: boolean } = {}): string[][] {
  const t = bidderLocationTotals(rows);
  const place = (r: BidderLocationRow) =>
    opts.places
      ? [r.postalCode === UNKNOWN_ZIP || r.postalCode === OTHER_ZIP ? '' : (r.city ?? UNLISTED_ZIP), r.state ?? '']
      : [];
  const [zipCol, ...rest] = BIDDER_LOCATION_CSV_HEADER;
  return [
    opts.places ? [zipCol, 'city', 'state', ...rest] : [...BIDDER_LOCATION_CSV_HEADER],
    ...rows.map((r) => [
      r.postalCode,
      ...place(r),
      r.warehouseName,
      String(r.registered),
      String(r.activeBidders),
      String(r.buyers),
      String(r.paidInvoices),
      dollars(r.salesNetCents),
    ]),
    [
      'Total',
      ...(opts.places ? ['', ''] : []),
      '',
      String(t.registered),
      String(t.activeBidders),
      String(t.buyers),
      String(t.paidInvoices),
      dollars(t.salesNetCents),
    ],
  ];
}

export function bidderLocationCsv(
  rows: BidderLocationRow[],
  meta: {
    period: string;
    location: string;
    zipPrefix: string | null;
    timeZone: string;
    /** 0438 data present: city/state columns, the filter in the title, and the GeoNames credit last. */
    places?: boolean;
    state?: string | null;
    city?: string | null;
  },
): string {
  const title = [
    `Bidders by ZIP, ${meta.period}`,
    meta.location,
    meta.zipPrefix ? `ZIP starts with ${meta.zipPrefix}` : 'all ZIPs',
    ...(meta.places && meta.state ? [meta.city ? `${meta.city}, ${meta.state}` : `state ${meta.state}`] : []),
    `dates in ${meta.timeZone}`,
  ];
  const body = [title, ...bidderLocationCsvRows(rows, { places: meta.places })];
  if (meta.places) body.push([GEONAMES_ATTRIBUTION]);
  const lines = body.map((l) => l.map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

// ── Bidder detail: ZIP read that tolerates a missing column ─────────────────

export type BidderZipField =
  | { available: false }
  | { available: true; zip: string | null; updatedAt: string | null };

/**
 * The bidder detail page reads postal_code in its OWN query so that, before
 * 0434 adds the column, that one query fails (42703) and the page simply
 * omits the row, instead of 400ing the main profile select.
 */
export function bidderZipFieldFrom(data: unknown, error: unknown): BidderZipField {
  if (error || data == null || typeof data !== 'object') return { available: false };
  const o = data as Record<string, unknown>;
  return {
    available: true,
    zip: typeof o.postal_code === 'string' && o.postal_code ? o.postal_code : null,
    updatedAt: typeof o.postal_code_updated_at === 'string' ? o.postal_code_updated_at : null,
  };
}
