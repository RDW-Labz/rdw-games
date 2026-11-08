// Hard-deleting a lot (console "Delete lot", Drafts page "Delete") — the pure
// pieces: which lots are real items in the warehouse, and what staff are told
// when a delete is refused.
//
// 2026-10-06: BIN-028904 was in_inventory with a sticker, a shelf and location
// history, and the console deleted it with no trace. Mig 0400 adds a BEFORE
// DELETE trigger on lots that refuses any lot with its own physical evidence
// (the six sources of mig 0369's lot_physical_footprint) and writes an
// operator_audit_log row (lot.hard_deleted) for every delete it allows. Its
// error message starts with FOOTPRINT_ERROR_PREFIX and its DETAIL lists the
// reasons, comma-separated. The server actions also check the three reasons
// visible on the lot row before deleting, so staff get the same answer
// without a round trip (and before 0400 is applied).

export const FOOTPRINT_ERROR_PREFIX = 'lot_has_physical_footprint';

/** The trigger's reason codes, in the order it reports them. */
export const FOOTPRINT_REASONS = [
  'sticker_code',
  'intake_bin_id',
  'intake_at',
  'bin_assignments',
  'lot_location_events',
  'lot_sticker_pool',
] as const;

// Staff words. Several codes are the same thing to someone at the shelf.
const REASON_WORDS: Record<string, string> = {
  sticker_code: 'a sticker',
  lot_sticker_pool: 'a sticker',
  intake_bin_id: 'a shelf',
  bin_assignments: 'a shelf',
  intake_at: 'location history',
  lot_location_events: 'location history',
};
const WORD_ORDER = ['a sticker', 'a shelf', 'location history'];

type LotRowEvidence = {
  sticker_code?: string | null;
  intake_bin_id?: string | null;
  intake_at?: string | null;
};

/** Reasons readable straight off the lot row (the trigger also checks three child tables). */
export function footprintReasonsFromLot(lot: LotRowEvidence): string[] {
  const out: string[] = [];
  if (lot.sticker_code) out.push('sticker_code');
  if (lot.intake_bin_id) out.push('intake_bin_id');
  if (lot.intake_at) out.push('intake_at');
  return out;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "This lot has a sticker and a shelf — …". Unknown codes fall back to generic wording. */
export function footprintRefusalMessage(reasons: readonly string[]): string {
  const words = WORD_ORDER.filter((w) => reasons.some((r) => REASON_WORDS[r] === w));
  const what = words.length ? joinWords(words) : 'a record in the warehouse';
  return (
    `This lot has ${what}, so it's a real item and can't be deleted. ` +
    'Use Remove from inventory on the lot page to dispose of it instead.'
  );
}

type DbError = { message?: string | null; details?: string | null } | null | undefined;

/** True when the error is the 0400 trigger refusing a lot with a footprint. */
export function isFootprintRefusal(error: DbError): boolean {
  return !!error?.message?.startsWith(FOOTPRINT_ERROR_PREFIX);
}

/** A failed lot DELETE → the message shown to staff. Other errors pass through as-is. */
export function lotDeleteErrorMessage(error: DbError): string {
  if (!error) return 'Could not delete this lot.';
  if (isFootprintRefusal(error)) {
    const reasons = (error.details ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    return footprintRefusalMessage(reasons);
  }
  return error.message || 'Could not delete this lot.';
}
