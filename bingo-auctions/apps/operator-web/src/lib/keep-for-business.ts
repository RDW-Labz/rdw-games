// Keep for business (mig 0381) — the pure pieces shared by the lot-page
// server action, the Kept items report and its CSV export.
//
// A kept item is NOT a sale: no invoice, no charge, no customer. It is recorded
// at a staff-entered price (0 allowed) so the business knows what it took, and
// every revenue figure (invoice-based) leaves it out.

/** Upper bound the RPC accepts: 100,000,000 cents = $1,000,000. */
export const KEEP_MAX_PRICE_CENTS = 100_000_000;
export const KEEP_REASON_MAX = 500;

/**
 * Dollars (as typed) → integer cents. Math.round absorbs float noise
 * (19.99 * 100 = 1998.9999…), so this must not be a truncation.
 */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** True when `dollars` has at most two decimal places (after float noise). */
export function hasAtMostTwoDecimals(dollars: number): boolean {
  return Math.abs(dollars * 100 - Math.round(dollars * 100)) < 1e-6;
}

// Every refusal keep_lot_for_business() can return, in operator language.
// already_removed_as_<kind> is built at runtime and handled separately below.
// The unit test reads the migration and fails if a reason is missing here.
export const KEEP_REFUSALS: Record<string, string> = {
  not_authenticated: 'Not authenticated.',
  invalid_price: 'Enter a price of $0 or more (up to $1,000,000).',
  reason_required: 'Say why the business is keeping it (up to 500 characters).',
  not_operator_staff: 'Not an operator.',
  admin_or_manager_required: 'Admin or manager role required to keep an item.',
  lot_not_found: 'Lot not found.',
  lot_other_operator: 'That lot belongs to another operator.',
  lot_canceled: "This lot was canceled, so it can't be kept.",
  lot_disposed: 'This lot is already out of inventory.',
  lot_on_invoice:
    "This lot has been sold or is on a customer's invoice. Keeping sold items isn't available yet.",
  lot_live_with_bids:
    "This lot is in a running auction and already has bids, so it can't be kept now.",
};

const REMOVAL_KIND_LABELS: Record<string, string> = {
  destroyed: 'destroyed',
  bin_store: 'transferred to Been There Bought That',
  donated: 'donated',
  liquidated: 'liquidated',
  missing: 'missing',
  other: 'other',
};

/** Refusal reason from the RPC → the message shown to staff. */
export function keepRefusalMessage(reason: string | null | undefined): string {
  if (!reason) return 'Could not keep this item.';
  if (reason.startsWith('already_removed_as_')) {
    const kind = reason.slice('already_removed_as_'.length);
    return `This item was already removed from inventory (${REMOVAL_KIND_LABELS[kind] ?? kind}), so it can't be kept.`;
  }
  // Unmapped reasons fall through as-is rather than being swallowed.
  return KEEP_REFUSALS[reason] ?? reason;
}

// ── Report + CSV ─────────────────────────────────────────────────────────────

export type KeptRow = {
  lot_id: string;
  lot_code: string | null;
  title: string | null;
  kept_price_cents: number;
  reason: string;
  kept_by: string;
  kept_at: string;
  prior_status: string;
};

/** All-time and since-`monthStartISO` count + total price. */
export function summarizeKeeps(
  rows: Pick<KeptRow, 'kept_price_cents' | 'kept_at'>[],
  monthStartISO: string,
) {
  const monthStart = Date.parse(monthStartISO);
  let count = 0;
  let totalCents = 0;
  let monthCount = 0;
  let monthTotalCents = 0;
  for (const r of rows) {
    count += 1;
    totalCents += r.kept_price_cents;
    if (Date.parse(r.kept_at) >= monthStart) {
      monthCount += 1;
      monthTotalCents += r.kept_price_cents;
    }
  }
  return { count, totalCents, monthCount, monthTotalCents };
}

/**
 * One CSV cell. Quotes anything with a comma, quote or newline (doubling
 * inner quotes), and prefixes a leading = + - @ so a spreadsheet shows the
 * text instead of running it as a formula — reasons and titles are typed by
 * people.
 */
export function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export const KEPT_CSV_HEADER = [
  'kept_at',
  'lot_code',
  'title',
  'kept_price_dollars',
  'reason',
  'kept_by',
  'prior_status',
] as const;

/** One report row as a CSV line. `keptByName` is the staff name/email, or null. */
export function keptCsvLine(r: KeptRow, keptByName: string | null): string {
  return [
    csvCell(r.kept_at),
    csvCell(r.lot_code),
    csvCell(r.title),
    csvCell((r.kept_price_cents / 100).toFixed(2)),
    csvCell(r.reason),
    csvCell(keptByName ?? r.kept_by),
    csvCell(r.prior_status),
  ].join(',');
}
