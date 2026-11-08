// Inventory list hook — fetches the operator's lots that haven't been
// added to an auction yet (auction_id IS NULL, status in pending_intake
// or in_inventory). Mirrors operator-web's /inventory page query.
//
// Why a hook (not a server-side fetch via expo-router loaders): expo-router
// doesn't have first-class data loaders the way Next.js does, and we want
// pull-to-refresh + filter-pill changes to refetch reactively. The hook
// owns its own state machine (idle | loading | error | success) so the
// list screen stays declarative.
//
// RLS: relies on the lots_staff_all policy (operator_id = current_operator_id()).
// We also explicitly filter by operator_id from useOperatorRole() to make
// the query plan tight on the existing lots_operator_idx — RLS alone would
// rewrite to the same predicate, but spelling it out is clearer.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, useOperatorRole } from '@auction-platform/supabase-client';
import {
  createTrailingDebounce,
  EMPTY_STAFF_INVENTORY_COUNTS,
  INVENTORY_SEARCH_DEBOUNCE_MS,
  mapStaffInventoryCountsJson,
  type StaffInventoryCounts,
} from '@/lib/inventory-counts';
import { REFUNDED_STATUS, refundedCountFromProbe } from '@/lib/relist-after-refund';

// W5-UI (2026-05-26): added 'flagged' for the new Worklist tab section
// (lots flagged for disposal by the auto_relist_unsold_lots cron after
// hitting auto_flag_disposal_at_strikes — mig 0146 W5-DB).
// W5-UI follow-up (task #102, 2026-05-27): added 'forfeited' — lots whose
// invoice has a pickup with status no_show or forfeited and whose own
// status was flipped to 'relisted' by the pickup no-show flow (operator-
// web pickups/actions.ts:30-39 and payment-followups.ts:181). These are
// lots that returned to operator hands because the bidder didn't pick up
// and need staff action (re-list / pull / dispose) but currently fall
// through the cracks — none of the existing tabs surfaces them.
export type InventoryFilter =
  | 'all'
  | 'draft'
  | 'pending_intake'
  | 'in_inventory'
  | 'unsold'
  | 'forfeited'
  | 'flagged'
  // 0475: fully refunded sale, item still here; relist needs a manager PIN.
  | 'refunded';

export type InventoryRow = {
  id: string;
  lot_code: string;
  sticker_code: string | null;
  title: string;
  status: 'draft' | 'pending_intake' | 'in_inventory' | 'unsold' | 'relisted' | 'disposed' | 'refunded';
  category: string | null;
  condition: 'appears_new' | 'open_box' | 'good' | 'as_is';
  msrp_cents: number | null;
  starting_bid_cents: number;
  photo_urls: string[];
  external_code: string | null;
  /** Truck/program label set at lotting time. Null for legacy lots. */
  source: string | null;
  intake_at: string | null;
  created_at: string;
  /** Number of times this lot has been relisted (migration 0097). 0 for
   *  original listings; increments through the relist chain. Surfaced
   *  in the row badge so staff can see "this is the 2nd relist." */
  relist_count: number;
  /** Set on auto-relisted lots — points to the previous incarnation.
   *  Used to render the lineage chip in the row (and the lot detail
   *  page later). */
  relisted_from_lot_id: string | null;
  /** Closed-at timestamp for unsold lots — surfaces "closed 2 days ago"
   *  in the row so staff knows how stale this unsold is. */
  closed_at: string | null;
  /** W5-DB (mig 0146): TRUE means the lot exhausted auto-relist attempts
   *  and is awaiting staff disposition (auto-flagged by cron OR manually
   *  by mark_lot_disposed). The Worklist "Flagged" tab surfaces these. */
  flagged_for_disposal: boolean | null;
  flagged_at: string | null;
  flagged_reason: string | null;
  warehouse_id: string | null;
};

export type InventoryListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; error: string }
  | {
      kind: 'success';
      rows: InventoryRow[];
      counts: StaffInventoryCounts;
    };

const PAGE_SIZE = 50;

export function useInventoryList(
  filter: InventoryFilter,
  search: string,
  /** Optional exact-match filter on lots.source. Empty string = no filter. */
  sourceFilter: string = '',
) {
  const role = useOperatorRole();
  const [state, setState] = useState<InventoryListState>({ kind: 'idle' });
  const [refreshing, setRefreshing] = useState(false);
  // null = the 'refunded' status does not exist yet (before 0475): no pill.
  const [refundedCount, setRefundedCount] = useState<number | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState(search.trim());
  const latestCountsRef = useRef<StaffInventoryCounts>(EMPTY_STAFF_INVENTORY_COUNTS);
  const initialListLoadRef = useRef(true);
  const debounceRef = useRef(
    createTrailingDebounce(INVENTORY_SEARCH_DEBOUNCE_MS, (v) => setDebouncedSearch(v.trim())),
  );

  useEffect(() => {
    const debouncer = debounceRef.current;
    debouncer.schedule(search);
    return () => debouncer.cancel();
  }, [search]);

  const fetchCounts = useCallback(async (): Promise<StaffInventoryCounts> => {
    if (role.kind !== 'staff') return EMPTY_STAFF_INVENTORY_COUNTS;
    // staff_inventory_counts() has no refunded bucket; count it here. Before
    // 0475 the enum value is unknown, the query errors, and the pill hides.
    const probe = await supabase
      .from('lots')
      .select('id', { count: 'exact', head: true })
      .eq('operator_id', role.operatorId)
      .eq('status', REFUNDED_STATUS)
      .is('deleted_at', null);
    setRefundedCount(refundedCountFromProbe(probe));
    const { data, error } = await supabase.rpc('staff_inventory_counts');
    if (error) return EMPTY_STAFF_INVENTORY_COUNTS;
    const counts = mapStaffInventoryCountsJson(data);
    latestCountsRef.current = counts;
    return counts;
  }, [role]);

  const fetchListPage = useCallback(
    async (opts: { showLoading: boolean }) => {
      if (role.kind !== 'staff') return;

      if (opts.showLoading) {
        setState({ kind: 'loading' });
      }

      try {
        let query = supabase
          .from('lots')
          .select(
            'id, lot_code, sticker_code, display_code, title, status, category, condition, msrp_cents, starting_bid_cents, photo_urls, external_code, source, intake_at, created_at, relist_count, relisted_from_lot_id, closed_at, flagged_for_disposal, flagged_at, flagged_reason, warehouse_id',
          )
          .eq('operator_id', role.operatorId)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE);

        if (filter === 'flagged') {
          query = query.eq('flagged_for_disposal', true).order('flagged_at', { ascending: false });
        } else if (filter === 'forfeited') {
          query = query
            .in('status', ['unsold', 'relisted'])
            .in('invoice_lots.invoices.pickups.status', ['no_show', 'forfeited'])
            .select(
              'id, lot_code, sticker_code, display_code, title, status, category, condition, msrp_cents, starting_bid_cents, photo_urls, external_code, source, intake_at, created_at, relist_count, relisted_from_lot_id, closed_at, flagged_for_disposal, flagged_at, flagged_reason, warehouse_id, invoice_lots!inner(invoices!inner(pickups!inner(status)))',
            );
        } else if (filter === 'refunded') {
          query = query.eq('status', REFUNDED_STATUS);
        } else if (filter === 'unsold') {
          query = query.eq('status', 'unsold');
        } else if (filter === 'draft') {
          query = query.eq('status', 'draft').is('auction_id', null);
        } else if (filter === 'all') {
          query = query.in('status', ['draft', 'pending_intake', 'in_inventory', 'unsold']);
        } else {
          query = query.eq('status', filter).is('auction_id', null);
        }

        const trimmed = debouncedSearch;
        if (trimmed) {
          query = query.or(`lot_code.ilike.${trimmed}%,title.ilike.%${trimmed}%`);
        }
        const sourceTrimmed = sourceFilter.trim();
        if (sourceTrimmed) {
          query = query.eq('source', sourceTrimmed);
        }

        const { data, error } = await query;
        if (error) {
          setState({ kind: 'error', error: error.message });
          return;
        }

        initialListLoadRef.current = false;
        setState((prev) => {
          const counts = prev.kind === 'success' ? prev.counts : latestCountsRef.current;
          return {
            kind: 'success',
            rows: (data ?? []) as InventoryRow[],
            counts,
          };
        });
      } catch (err) {
        setState({ kind: 'error', error: (err as Error).message });
      }
    },
    [role, filter, debouncedSearch, sourceFilter],
  );

  // Pill counts: once on mount (and when staff role becomes available), not per keystroke.
  useEffect(() => {
    if (role.kind !== 'staff') return;
    void (async () => {
      const counts = await fetchCounts();
      setState((prev) => (prev.kind === 'success' ? { ...prev, counts } : prev));
    })();
  }, [role, fetchCounts]);

  // List: on mount + filter / debounced search / source (immediate for pills).
  useEffect(() => {
    void fetchListPage({ showLoading: initialListLoadRef.current });
  }, [fetchListPage]);

  const refreshCounts = useCallback(async () => {
    const counts = await fetchCounts();
    setState((prev) => {
      if (prev.kind === 'success') {
        return { ...prev, counts };
      }
      return { kind: 'success', rows: [], counts };
    });
  }, [fetchCounts]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshCounts(), fetchListPage({ showLoading: false })]);
    } finally {
      setRefreshing(false);
    }
  }, [refreshCounts, fetchListPage]);

  return { state, refresh, refreshCounts, refreshing, refundedCount };
}
