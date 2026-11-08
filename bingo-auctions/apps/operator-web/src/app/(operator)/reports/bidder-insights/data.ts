// Shared loader for /reports/bidder-insights and its CSV export.
//
// Three RPCs (mig 0449), admin/manager only: operator_bidder_zip_heat (date
// range + optional ZIP prefix), operator_bidder_segments /
// operator_bidder_segments_by_zip (no args — "as of now"), and
// operator_bidder_cohorts (last 12 weeks, bucketed in the operator's
// warehouse wall clock — same convention as operator_bidder_report, mig
// 0289). Each RPC's outcome is classified independently (rpcStateFrom), so
// one missing/erroring function doesn't blank the whole page — the other two
// sections still render.

import type { SupabaseClient } from '@supabase/supabase-js';
import { dayRangeInTimeZone, DEFAULT_TIME_ZONE } from '@/lib/datetime';
import { parseReportRange } from '@/lib/report-range';
import {
  rpcStateFrom,
  parseZipHeatRows,
  parseSegmentRows,
  parseSegmentByZipRows,
  parseCohortRows,
  ZIP_HEAT_RPC,
  SEGMENTS_RPC,
  SEGMENTS_BY_ZIP_RPC,
  COHORTS_RPC,
  type RpcState,
  type ZipHeatRow,
  type SegmentRow,
  type SegmentByZipRow,
  type CohortRow,
} from '@/lib/bidder-insights';
import { parseZipPrefix } from '@/lib/bidder-location';

export const COHORT_WEEKS = 12;

export type BidderInsightsReport =
  | { ok: false; status: 'no_user' | 'no_operator' | 'forbidden' }
  | {
      ok: true;
      from: string | null;
      to: string | null;
      zipPrefix: string | null;
      timeZone: string;
      zipHeat: RpcState<ZipHeatRow>;
      segments: RpcState<SegmentRow>;
      segmentsByZip: RpcState<SegmentByZipRow>;
      cohorts: RpcState<CohortRow>;
    };

export async function loadBidderInsights(
  supabase: SupabaseClient,
  sp: { from?: string; to?: string; zip?: string },
): Promise<BidderInsightsReport> {
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

  const { data: whRow } = await supabase
    .from('warehouses')
    .select('timezone')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const timeZone = (whRow as { timezone: string } | null)?.timezone || DEFAULT_TIME_ZONE;

  const { from, to } = parseReportRange(sp);
  const zipPrefix = parseZipPrefix(sp.zip);
  const range = from && to ? dayRangeInTimeZone(from, to, timeZone) : null;

  const [zipHeatQ, segmentsQ, segmentsByZipQ, cohortsQ] = await Promise.all([
    supabase.rpc(ZIP_HEAT_RPC, {
      p_from: range?.startISO ?? null,
      p_to: range?.endISO ?? null,
      p_zip_prefix: zipPrefix,
    }),
    supabase.rpc(SEGMENTS_RPC),
    supabase.rpc(SEGMENTS_BY_ZIP_RPC),
    supabase.rpc(COHORTS_RPC, { p_weeks: COHORT_WEEKS, p_tz: timeZone }),
  ]);

  return {
    ok: true,
    from,
    to,
    zipPrefix,
    timeZone,
    zipHeat: rpcStateFrom(ZIP_HEAT_RPC, parseZipHeatRows, zipHeatQ.data, zipHeatQ.error),
    segments: rpcStateFrom(SEGMENTS_RPC, parseSegmentRows, segmentsQ.data, segmentsQ.error),
    segmentsByZip: rpcStateFrom(SEGMENTS_BY_ZIP_RPC, parseSegmentByZipRows, segmentsByZipQ.data, segmentsByZipQ.error),
    cohorts: rpcStateFrom(COHORTS_RPC, parseCohortRows, cohortsQ.data, cohortsQ.error),
  };
}
