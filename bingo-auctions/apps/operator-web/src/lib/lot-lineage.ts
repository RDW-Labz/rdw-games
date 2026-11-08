// Relist lineage resolution — "which lot record is the CURRENT one?"
//
// A relist does NOT mutate the lot row. `relist_lot_into_auction` (mig 0097)
// mints a *new* row with a fresh `lot_code` + `lot_number`, carries the
// physical sticker over (`sticker_code`, migs 0192/0213), points it back at
// the source via `relisted_from_lot_id`, and flips the source's status to
// 'relisted'. So one physical item on the shelf is represented by a CHAIN of
// lot rows, of which at most one is live.
//
// That chain is why the same human-readable code could report two different
// states (field report 2026-07-30, lot PNK4858852):
//
//   row A  lot_code=PNK4858852   sticker=—              status=relisted
//          auction=NULL          bin=1-19-01            ← stale ancestor
//   row B  lot_code=BIN-001737   sticker=BIN:PNK4858852 status=live
//          auction='Going… Gone!' bin=15-08-01          ← the real item
//
// Row B is what the storefront renders (it shows the sticker label, so it
// *calls itself* "PNK4858852"), but every by-code lookup that stopped at an
// exact `lot_code` match landed on row A — which says "not in auction yet"
// and points staff at a bin the item left weeks ago.
//
// `preferActiveLot` (packages/shared) already fixes the collision half of this
// for the staff scanners. These helpers add the other half: match a code
// against BOTH identifier columns, and walk `relisted_from_lot_id` FORWARD
// from a retired row to the incarnation that is actually on the floor.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  RETIRED_LOT_STATUSES,
  lotCodeMatchFilters,
  preferActiveLot,
} from '@auction-platform/shared';

/** Hops we'll follow before assuming the lineage is corrupt. Matches the
 *  upward walk on the operator lot detail page and the bound inside mig 0304's
 *  `_find_lot_by_scan`. */
export const MAX_LINEAGE_HOPS = 5;

export interface LineageLotRow {
  id: string;
  lot_code: string | null;
  sticker_code: string | null;
  status: string;
  created_at: string | null;
}

/**
 * Every lot row that answers to `code`, matched against the canonical
 * `lot_code` AND the physical `sticker_code` (stored operator-prefixed as
 * `{op}:{RAW}`, so the raw label is a suffix match).
 *
 * Soft-deleted rows are excluded. Callers pass the column list they need;
 * `id, lot_code, sticker_code, status, created_at` are always included so the
 * result can be fed straight to `preferActiveLot`.
 */
export async function findLotsByAnyCode<T extends LineageLotRow>(
  supabase: SupabaseClient,
  code: string,
  columns: string,
): Promise<T[]> {
  // Filter construction lives in @auction-platform/shared so the storefront,
  // the field scanners, and mig 0304's `_find_lot_by_scan` all match a code
  // against the same set of columns.
  const filters = lotCodeMatchFilters(code);
  if (!filters) return [];

  const { data } = await supabase
    .from('lots')
    .select(columns)
    .or(filters.join(','))
    .is('deleted_at', null)
    .limit(10);

  return ((data ?? []) as unknown as T[]).filter(Boolean);
}

/**
 * Walk `relisted_from_lot_id` DOWNWARD from `lotId` — the reverse of the
 * "Lineage" list on the operator lot page, which only ever walked up to
 * ancestors and so never told an operator standing on a dead row where the
 * item went.
 *
 * Returns the successors oldest-first; the LAST entry is the current
 * incarnation. Empty when `lotId` has never been relisted.
 *
 * A source lot can have several children over its life (the one-active-child
 * unique index only constrains draft/scheduled/live rows), so each hop picks
 * the active child when there is one, newest otherwise — same rule the staff
 * scanners use. Visited ids are tracked so a cyclic `relisted_from_lot_id`
 * can't spin.
 */
export async function loadSuccessorChain<T extends LineageLotRow>(
  supabase: SupabaseClient,
  lotId: string,
  columns: string,
  maxHops: number = MAX_LINEAGE_HOPS,
): Promise<T[]> {
  const chain: T[] = [];
  const seen = new Set<string>([lotId]);
  let cursor = lotId;

  for (let hop = 0; hop < maxHops; hop++) {
    const { data } = await supabase
      .from('lots')
      .select(columns)
      .eq('relisted_from_lot_id', cursor)
      .is('deleted_at', null)
      .limit(10);

    const children = ((data ?? []) as unknown as T[]).filter(Boolean);
    const next = preferActiveLot(children);
    if (!next || seen.has(next.id)) break;

    chain.push(next);
    seen.add(next.id);
    cursor = next.id;
  }

  return chain;
}

/** True for statuses that mean "this row is history" (relisted/canceled/disposed). */
export function isRetiredLot(status: string | null | undefined): boolean {
  return RETIRED_LOT_STATUSES.has(String(status));
}
