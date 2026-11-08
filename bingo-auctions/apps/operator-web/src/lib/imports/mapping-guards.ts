// mapping-guards.ts
//
// Value-level checks on a column mapping, run before any row is written.
//
// Jared, 2026-09-18: 1,369 lots imported carrying a raw Amazon URL as the
// title ("https://www.amazon.com/dp/B09HBFQ6D9") and Amazon category codes as
// the category ("32000 Woodworking"). Three of them reached a scheduled,
// pre-bid-enabled auction before anyone noticed. The wizard's only mapping
// check was whether SOME column was mapped to title. It never looked at what
// was IN that column, and the RPC wrote exactly what it was told.
//
// These were written for the Smart Import wizard (#332) and lived in lib/csv.
// That wizard is retired; the manifest wizard at /imports/new is where staff
// are sent now, and it had the same hole — the same file would have been
// accepted there. Moved here, decoupled from either wizard's mapping shape:
// the caller passes the VALUES it is about to import and the header they came
// from, so both the single-field and multi-field mapping models can use them.
//
// They read rows the wizard has already built, so they cost a scan and
// nothing else — no re-parse, no round-trip.

const URL_VALUE = /^https?:\/\//i;
// Supplier category codes: a 3-5 digit number, then the label.
// "3000 Health Care", "32000 Woodworking", "0100 Pet Food & Feeding Supplies".
const CODE_CATEGORY_VALUE = /^\d{3,5}\s/;

/** A mapped column whose VALUES do not look like the field they feed. */
export type MappingProblem = {
  field: 'title' | 'category';
  /** The header the operator mapped to that field, so the message can name it. */
  column: string | null;
  matched: number;
  checked: number;
  /** First offending value, shown to the operator as evidence. */
  sample: string;
};

// A mostly-wrong mapping must not slip through on a handful of clean rows, so
// the bar is deliberately low: a fifth of the values looking wrong is a mapping
// mistake, not a data quirk. (The batch that prompted this was 1369 of 1369.)
const PROBLEM_RATIO = 0.2;

function inspectValues(
  values: ReadonlyArray<string | null | undefined>,
  field: MappingProblem['field'],
  column: string | null,
  pattern: RegExp,
): MappingProblem | null {
  let checked = 0;
  let matched = 0;
  let sample = '';
  for (const raw of values) {
    const value = raw?.trim();
    // An empty cell is not something to hold against the mapping.
    if (!value) continue;
    checked += 1;
    if (pattern.test(value)) {
      matched += 1;
      if (sample === '') sample = value;
    }
  }
  if (checked === 0) return null;
  if (matched / checked <= PROBLEM_RATIO) return null;
  return { field, column, matched, checked, sample };
}

/**
 * Title column holding URLs. BLOCKING: a lot whose title is a link is unusable
 * to a bidder, and once imported there is nothing in the row to rebuild the
 * title from except the description — which is how the 2026-09-11 batch had to
 * be repaired, 1,369 rows at a time.
 */
export function findUrlTitleProblem(
  titles: ReadonlyArray<string | null | undefined>,
  column: string | null,
): MappingProblem | null {
  return inspectValues(titles, 'title', column, URL_VALUE);
}

/**
 * Category column holding supplier codes. ADVISORY, not blocking: 0220's
 * BEFORE INSERT trigger still resolves these strings to the correct
 * category_id (verified on the 2026-09-11 batch — 1,369 of 1,369 resolved, and
 * correctly), so the storefront, which keys on category_id, is unaffected. It
 * is the raw string that Auction Builder renders, which makes this an
 * operator-facing blemish rather than broken data. Stopping an otherwise-fine
 * import over it would cost more than it saves.
 */
export function findCodeCategoryProblem(
  categories: ReadonlyArray<string | null | undefined>,
  column: string | null,
): MappingProblem | null {
  return inspectValues(categories, 'category', column, CODE_CATEGORY_VALUE);
}

/**
 * The first source column assigned to `field`, for naming it in the message.
 *
 * Takes the manifest wizard's shape — one source column feeds MANY internal
 * fields, so a manifest with a single "Description" column can populate both
 * title and description. A single-field mapping passes `[target]`.
 */
export function columnForField(
  mapping: Record<string, readonly string[]>,
  field: string,
): string | null {
  return Object.entries(mapping).find(([, fields]) => fields.includes(field))?.[0] ?? null;
}
