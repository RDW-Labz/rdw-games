// Items refunded as MISSING that nobody has found since.
//
// Mig 0345's trigger (lots_block_relist_of_missing_item) refuses to relist a
// lot whose latest 'missing' pickup outcome has not been followed by a
// put-away. The Auction Builder never mirrored that rule, so these lots sat in
// the Unsold / Unpicked-up tabs, staff picked them, and carryover died part-way
// with relist_blocked_item_missing (Jared 2026-10-15: PNK4821346, TEA4841809).
//
// This is the same rule, read from the same tables, so the builder can hide
// what the trigger will refuse. The trigger stays the floor; this is the UI.
//
// Cleared (found) when ANY of these is dated after the missing mark — exactly
// the three signals 0345 accepts:
//   * lots.intake_at
//   * a lot_location_events row (occurred_at)
//   * a bin_assignments row (assigned_at)

import type { SupabaseClient } from '@supabase/supabase-js';

const PAGE = 1000;
// .in() lists go in the URL; keep each request well under PostgREST's limit.
const ID_CHUNK = 100;

export type MissingSignals = {
  // lot_id -> created_at of each 'missing' outcome (any number per lot).
  missing: Array<{ lot_id: string; created_at: string }>;
  intake: Array<{ id: string; intake_at: string | null }>;
  locationEvents: Array<{ lot_id: string; occurred_at: string }>;
  binAssignments: Array<{ lot_id: string; assigned_at: string }>;
};

/**
 * Pure rule: lot_id -> latest missing date, for lots not handled since.
 * Mirrors lots_block_relist_of_missing_item() (mig 0345).
 */
export function unfoundMissingFrom(s: MissingSignals): Map<string, string> {
  const latest = new Map<string, string>();
  for (const o of s.missing) {
    const prev = latest.get(o.lot_id);
    if (!prev || Date.parse(o.created_at) > Date.parse(prev)) latest.set(o.lot_id, o.created_at);
  }
  const after = (lotId: string, at: string | null | undefined) => {
    const m = latest.get(lotId);
    return !!m && !!at && Date.parse(at) > Date.parse(m);
  };
  const found = new Set<string>();
  for (const l of s.intake) if (after(l.id, l.intake_at)) found.add(l.id);
  for (const e of s.locationEvents) if (after(e.lot_id, e.occurred_at)) found.add(e.lot_id);
  for (const b of s.binAssignments) if (after(b.lot_id, b.assigned_at)) found.add(b.lot_id);
  for (const id of found) latest.delete(id);
  return latest;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * lot_id -> date marked missing, for every missing item not found since.
 * RLS scopes every table to the caller's operator. Pass lotIds to check only
 * those lots (the carryover action); omit to load them all (builder page).
 */
export async function loadUnfoundMissing(
  supabase: SupabaseClient,
  lotIds?: string[],
): Promise<Map<string, string>> {
  const missing: MissingSignals['missing'] = [];
  if (lotIds) {
    for (const ids of chunks(lotIds, ID_CHUNK)) {
      const { data } = await supabase
        .from('pickup_lot_outcomes')
        .select('lot_id, created_at')
        .eq('outcome', 'missing')
        .in('lot_id', ids);
      missing.push(...((data ?? []) as MissingSignals['missing']));
    }
  } else {
    // Paged: PostgREST caps one select at 1000 rows regardless of .limit().
    for (let from = 0; ; from += PAGE) {
      const { data } = await supabase
        .from('pickup_lot_outcomes')
        .select('lot_id, created_at')
        .eq('outcome', 'missing')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      const page = (data ?? []) as MissingSignals['missing'];
      missing.push(...page);
      if (page.length < PAGE) break;
    }
  }
  if (missing.length === 0) return new Map();

  const ids = Array.from(new Set(missing.map((m) => m.lot_id)));
  const signals: MissingSignals = { missing, intake: [], locationEvents: [], binAssignments: [] };
  for (const c of chunks(ids, ID_CHUNK)) {
    const [lots, events, bins] = await Promise.all([
      supabase.from('lots').select('id, intake_at').in('id', c),
      supabase.from('lot_location_events').select('lot_id, occurred_at').in('lot_id', c),
      supabase.from('bin_assignments').select('lot_id, assigned_at').in('lot_id', c),
    ]);
    signals.intake.push(...((lots.data ?? []) as MissingSignals['intake']));
    signals.locationEvents.push(...((events.data ?? []) as MissingSignals['locationEvents']));
    signals.binAssignments.push(...((bins.data ?? []) as MissingSignals['binAssignments']));
  }
  return unfoundMissingFrom(signals);
}
