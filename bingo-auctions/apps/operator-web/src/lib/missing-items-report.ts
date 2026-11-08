// Missing Items report (mig 0426): row shape, labels, CSV, and the loader the
// page and its CSV export share.
//
// Rows come from missing_items_report(), which applies 0345's rule in SQL, so
// this report and the relist guard can never disagree about what is missing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { locationComparator } from './location-sort';

export type MissingState = 'open' | 'unsellable' | 'found' | 'confirmed_missing' | 'disposed';

export type MissingRow = {
  lot_id: string;
  lot_code: string;
  display_code: string | null;
  title: string | null;
  photo_url: string | null;
  lot_status: string;
  /** mig 0452: added so the report can be sorted/grouped per warehouse. */
  warehouse_id: string | null;
  warehouse_name: string | null;
  location_code: string | null;
  location_at: string | null;
  missing_at: string | null;
  source: 'pickup' | 'removal';
  reason: string | null;
  marked_by_name: string | null;
  state: MissingState;
  last_check_at: string | null;
  last_check_outcome: string | null;
  last_check_note: string | null;
  last_check_by_name: string | null;
  check_count: number;
};

export type MissingCheck = {
  id: string;
  lot_id: string;
  outcome: string;
  note: string | null;
  removal_kind: string | null;
  checked_by: string | null;
  checked_at: string;
};

export const STATE_LABEL: Record<MissingState, string> = {
  open: 'Still missing',
  unsellable: 'Unsellable — awaiting disposal',
  found: 'Found',
  confirmed_missing: 'Confirmed missing',
  disposed: 'Disposed',
};

export const OUTCOME_LABEL: Record<string, string> = {
  found: 'Found',
  confirmed_missing: 'Confirmed missing',
  unsellable: 'Unsellable',
  disposed: 'Disposed',
};

export const DISPOSAL_KINDS = ['destroyed', 'donated', 'liquidated', 'bin_store', 'other'] as const;

export function reasonText(r: Pick<MissingRow, 'reason' | 'source'>): string {
  if (r.reason) return r.reason;
  return r.source === 'pickup' ? 'Not found at pickup' : 'Removed from inventory as missing';
}

export const MISSING_CSV_HEADER = [
  'lot_code',
  'display_code',
  'title',
  'photo_url',
  'last_known_location',
  'location_recorded_at',
  'marked_missing_at',
  'flagged_by',
  'reason',
  'state',
  'last_check_at',
  'last_check_outcome',
  'last_check_by',
  'last_check_note',
  'checks',
  'warehouse',
] as const;

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function missingCsvLine(r: MissingRow): string {
  return [
    r.lot_code,
    r.display_code,
    r.title,
    r.photo_url,
    r.location_code,
    r.location_at,
    r.missing_at,
    r.marked_by_name,
    reasonText(r),
    STATE_LABEL[r.state] ?? r.state,
    r.last_check_at,
    r.last_check_outcome ? (OUTCOME_LABEL[r.last_check_outcome] ?? r.last_check_outcome) : null,
    r.last_check_by_name,
    r.last_check_note,
    r.check_count,
    r.warehouse_name,
  ]
    .map(csvCell)
    .join(',');
}

// Numeric aisles sort before named ones (see apps/operator-web/src/lib/location-sort.ts).
const missingLocationComparator = locationComparator<MissingRow>((r) => ({
  warehouseName: r.warehouse_name,
  locationCode: r.location_code,
  tieBreak: r.display_code ?? r.lot_code,
}));

export type MissingReport =
  | { ok: false; status: 'no_user' | 'no_operator' }
  | { ok: false; status: 'error'; message: string }
  | { ok: true; role: string; rows: MissingRow[] };

export async function loadMissingReport(
  supabase: SupabaseClient,
  includeResolved: boolean,
): Promise<MissingReport> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 'no_user' };
  const { data: me } = await supabase
    .from('operator_users')
    .select('role')
    .eq('user_id', user.id)
    .single();
  if (!me) return { ok: false, status: 'no_operator' };

  const { data, error } = await supabase.rpc('missing_items_report', {
    p_include_resolved: includeResolved,
  });
  if (error) return { ok: false, status: 'error', message: error.message };
  // Sorted here, once, so the page, the CSV export and print (same DOM as the
  // page) all show the same order: per warehouse, then by bin location
  // (aisle/bay/shelf, numeric-aware), lots with no location last.
  const rows = ((data ?? []) as MissingRow[]).slice().sort(missingLocationComparator);
  return { ok: true, role: (me as { role: string }).role, rows };
}

/** Friendly text for the RPCs' `reason` codes. */
export function missingActionError(
  reason: string | undefined,
  /** missing_item_found (mig 0445): the relist lot the box now belongs to. */
  relistLotCode?: string | null,
): string {
  switch (reason) {
    case 'admin_or_manager_required':
      return 'Admins or managers only.';
    case 'not_marked_missing':
      return 'This item is not marked missing.';
    case 'already_found':
      return 'Already found — it was put away after it was marked missing.';
    case 'marked_unsellable':
      return 'Marked unsellable — record the disposal instead.';
    case 'not_marked_unsellable':
      return 'Mark it unsellable first, then record the disposal.';
    case 'bin_not_found_or_revoked':
      return 'That bin code was not found.';
    case 'bin_retired':
      return 'That bin is retired.';
    case 'lot_live_with_bids':
      return 'This lot is live with bids.';
    case 'lot_not_found':
      return 'Lot not found.';
    case 'pending_move':
      // intake_lot_to_bin: the lot is recorded on another shelf, and Found does
      // not move it. Put-away's move confirmation does.
      return 'This item is recorded on a different shelf. Move it to this shelf with Put-away, then press Found again.';
    default:
      if (reason?.startsWith('relist_removed_as_')) {
        // mig 0445: it was relisted after it went missing, and the relist was
        // written off. The box needs a new lot.
        const kind = reason.slice('relist_removed_as_'.length).replace(/_/g, ' ');
        return `This item was relisted${relistLotCode ? ` as ${relistLotCode}` : ''}, and that lot was removed from inventory (${kind}). Re-lot the box instead.`;
      }
      if (reason?.startsWith('already_removed_as_')) {
        return `Already removed from inventory (${reason.slice('already_removed_as_'.length).replace(/_/g, ' ')}).`;
      }
      return reason ? `Could not save: ${reason}` : 'Could not save.';
  }
}
