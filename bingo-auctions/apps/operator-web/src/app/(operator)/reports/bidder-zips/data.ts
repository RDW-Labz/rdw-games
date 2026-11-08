// Shared loader for /reports/bidder-zips and its CSV export, so both gate,
// pick the timezone and call the RPC exactly the same way.
//
// One call: operator_bidder_location_summary_by_place (mig 0438: city/state
// + filters) via supabase.rpc, falling back to 0434's
// operator_bidder_location_summary when 0438 isn't applied yet (then the
// city/state filters are ignored and hidden). All joins happen inside the
// function; no PostgREST embeds here (no PGRST201 risk). Admin/manager only:
// the function refuses anyone else, and checking the role first gives other
// staff a plain message instead of an error.

import type { SupabaseClient } from '@supabase/supabase-js';
import { dayRangeInTimeZone } from '@/lib/datetime';
import { parseReportRange } from '@/lib/report-range';
import {
  BIDDER_LOCATION_RPC,
  BIDDER_PLACE_RPC,
  BIDDER_PLACES_RPC,
  ZIP_COVERAGE_RPC,
  bidderLocationStateFrom,
  isMissingFunction,
  parseCityName,
  parseStateCode,
  placeOptionsFrom,
  zipCoverageFrom,
  parseZipPrefix,
  reportTimeZone,
  type BidderLocationState,
  type PlaceOptions,
  type ZipCoverage,
} from '@/lib/bidder-location';

export type LocationOption = { id: string; name: string; active: boolean };

export type BidderZipReport =
  | { ok: false; status: 'no_user' | 'no_operator' | 'forbidden' }
  | {
      ok: true;
      from: string | null;
      to: string | null;
      selectedId: string | null;
      selectedName: string;
      zipPrefix: string | null;
      timeZone: string;
      locations: LocationOption[];
      state: BidderLocationState;
      /** null = hide the coverage line (RPC missing/errored, or a ZIP prefix is set). */
      coverage: ZipCoverage | null;
      /**
       * City / state (mig 0438). available=false before 0438: filters hidden,
       * any ?state= / ?city= ignored, no GeoNames credit shown.
       */
      places: {
        available: boolean;
        state: string | null;
        city: string | null;
        options: PlaceOptions | null;
      };
    };

export async function loadBidderZips(
  supabase: SupabaseClient,
  sp: { from?: string; to?: string; location?: string; zip?: string; state?: string; city?: string },
): Promise<BidderZipReport> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 'no_user' };

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) return { ok: false, status: 'no_operator' };
  const { operator_id: operatorId, role } = me as { operator_id: string; role: string };
  if (role !== 'admin' && role !== 'manager') return { ok: false, status: 'forbidden' };

  const { data: whs } = await supabase
    .from('warehouses')
    .select('id, name, timezone, created_at, active')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true });
  const warehouses = (whs ?? []) as Array<{
    id: string;
    name: string;
    timezone: string | null;
    created_at: string | null;
    active: boolean | null;
  }>;

  const { from, to } = parseReportRange(sp);
  const picked = warehouses.find((w) => w.id === sp.location) ?? null;
  const selectedId = picked?.id ?? null;
  const zipPrefix = parseZipPrefix(sp.zip);
  const timeZone = reportTimeZone(warehouses, selectedId);
  const range = from && to ? dayRangeInTimeZone(from, to, timeZone) : null;

  const stateCode = parseStateCode(sp.state);
  const cityName = parseCityName(sp.city, stateCode);
  const base = {
    p_from: range?.startISO ?? null,
    p_to: range?.endISO ?? null,
    p_warehouse_id: selectedId,
    p_zip_prefix: zipPrefix,
  };

  // Coverage counts each bidder once (its own function, mig 0434). Skipped
  // under a ZIP prefix or a place filter: no-ZIP bidders can never match one.
  const [placeQ, optionsQ, coverageQ] = await Promise.all([
    supabase.rpc(BIDDER_PLACE_RPC, { ...base, p_state: stateCode, p_city: cityName }),
    supabase.rpc(BIDDER_PLACES_RPC),
    zipPrefix || stateCode ? Promise.resolve(null) : supabase.rpc(ZIP_COVERAGE_RPC),
  ]);

  // Before 0438: the by-place function is missing → 0434's report, and any
  // ?state= / ?city= is ignored (so coverage is fetched after all).
  const placesAvailable = !isMissingFunction(placeQ.error, BIDDER_PLACE_RPC);
  const [{ data, error }, lateCoverageQ] = placesAvailable
    ? [placeQ, null]
    : await Promise.all([
        supabase.rpc(BIDDER_LOCATION_RPC, base),
        !zipPrefix && stateCode ? supabase.rpc(ZIP_COVERAGE_RPC) : Promise.resolve(null),
      ]);
  const covQ = coverageQ ?? lateCoverageQ;
  const coverage = covQ ? zipCoverageFrom(covQ.data, covQ.error) : null;

  return {
    ok: true,
    from,
    to,
    selectedId,
    selectedName: picked?.name ?? 'All locations',
    zipPrefix,
    timeZone,
    locations: warehouses.map((w) => ({ id: w.id, name: w.name, active: w.active !== false })),
    state: bidderLocationStateFrom(data, error),
    coverage,
    places: {
      available: placesAvailable,
      state: placesAvailable ? stateCode : null,
      city: placesAvailable ? cityName : null,
      options: placesAvailable ? placeOptionsFrom(optionsQ.data, optionsQ.error) : null,
    },
  };
}
