// "Marked missing" on the lot lookup (staff member via Jared, 2026-10-15): the same
// red treatment the refunded banner gets, so staff at the shelf can see a box
// was called missing, when, and why.
//
// Two ways a lot is marked missing today:
//   * pickup — a pickup_lot_outcomes row with outcome 'missing' (0243). Mig
//     0345 keeps the item off any auction until it is put away again; that
//     clears on lots.intake_at, a lot_location_events row or a bin_assignments
//     row dated after the latest mark. Same rule here, so the banner goes away
//     exactly when the item can be listed again.
//   * removal — remove_lot_from_inventory with removal_kind 'missing' (0352),
//     which makes the lot 'disposed'. Shown until somebody re-lots it.
//
// Display only. Nothing here writes.

import type { SupabaseClient } from '@supabase/supabase-js';

export type MissingMark = {
  source: 'pickup' | 'removal';
  at: string;
  reason: string | null;
};

export type MissingMarkSignals = {
  removal: { kind: string | null; at: string | null; note: string | null };
  outcomes: Array<{ created_at: string; note: string | null }>;
  intakeAt: string | null;
  locationEventAts: string[];
  binAssignedAts: string[];
};

const blank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

export function missingMarkFrom(s: MissingMarkSignals): MissingMark | null {
  if (s.removal.kind === 'missing') {
    return { source: 'removal', at: s.removal.at ?? '', reason: blank(s.removal.note) };
  }
  let latest: { created_at: string; note: string | null } | null = null;
  for (const o of s.outcomes) {
    if (!latest || Date.parse(o.created_at) > Date.parse(latest.created_at)) latest = o;
  }
  if (!latest) return null;
  const mark = Date.parse(latest.created_at);
  const after = (at: string | null) => !!at && Date.parse(at) > mark;
  if (after(s.intakeAt) || s.locationEventAts.some(after) || s.binAssignedAts.some(after)) {
    return null; // found and put away since — eligible again
  }
  return { source: 'pickup', at: latest.created_at, reason: blank(latest.note) };
}

/** Reads the signals for one lot. Any read error just means no banner. */
export async function loadMissingMark(
  supabase: SupabaseClient,
  lotId: string,
  row: {
    intake_at?: unknown;
    removal_kind?: unknown;
    removed_at?: unknown;
    removal_note?: unknown;
  },
): Promise<MissingMark | null> {
  const removal = {
    kind: (row.removal_kind as string | null) ?? null,
    at: (row.removed_at as string | null) ?? null,
    note: (row.removal_note as string | null) ?? null,
  };
  if (removal.kind === 'missing') {
    return missingMarkFrom({ removal, outcomes: [], intakeAt: null, locationEventAts: [], binAssignedAts: [] });
  }
  const { data: outcomes } = await supabase
    .from('pickup_lot_outcomes')
    .select('created_at, note')
    .eq('lot_id', lotId)
    .eq('outcome', 'missing');
  if (!outcomes || outcomes.length === 0) return null;
  const [ev, ba] = await Promise.all([
    supabase.from('lot_location_events').select('occurred_at').eq('lot_id', lotId),
    supabase.from('bin_assignments').select('assigned_at').eq('lot_id', lotId),
  ]);
  return missingMarkFrom({
    removal,
    outcomes: outcomes as MissingMarkSignals['outcomes'],
    intakeAt: (row.intake_at as string | null) ?? null,
    locationEventAts: ((ev.data ?? []) as Array<{ occurred_at: string }>).map((e) => e.occurred_at),
    binAssignedAts: ((ba.data ?? []) as Array<{ assigned_at: string }>).map((b) => b.assigned_at),
  });
}
