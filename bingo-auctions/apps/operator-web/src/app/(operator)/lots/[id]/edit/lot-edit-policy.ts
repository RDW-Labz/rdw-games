// What the console lot editor may change, by lot state. ONE rule, used by both
// the form (which fields are greyed out, what the warning names) and the
// editLot server action (what it writes), so the two can't drift again.
//
// 2026-10-13 (Jared, floor): edits "wouldn't save". The form treated a
// scheduled lot with no bids as fully editable while the server locked it,
// and on live / bid lots the server dropped title, description and category
// while the form said descriptive fields were editable. Either way the save
// returned OK and the page showed the old text.
//
// Braden's rule (2026-10-13):
//   - Descriptive fields (title, description, category, condition) and photos
//     are always editable.
//   - Prices are editable only while the lot has no bids and is still in a
//     pre-sale state (draft, scheduled, pending intake, in inventory). Once it
//     has a bid, is live, has closed or left the cycle, prices are locked.

export const PRICE_EDITABLE_STATUSES = ['draft', 'scheduled', 'in_inventory', 'pending_intake'] as const;

export type PriceField =
  | 'msrpCents'
  | 'startingBidCents'
  | 'flatPriceCents'
  | 'dutchStartCents'
  | 'dutchFloorCents'
  | 'dutchDeclinePerMinuteCents';

export const PRICE_FIELD_LABELS: Record<PriceField, string> = {
  msrpCents: 'MSRP',
  startingBidCents: 'Starting bid',
  flatPriceCents: 'Flat price',
  dutchStartCents: 'Dutch start',
  dutchFloorCents: 'Dutch floor',
  dutchDeclinePerMinuteCents: 'Decline rate',
};

/** The price fields the editor shows for an auction format, in form order. */
export function priceFieldsForFormat(format: 'standard' | 'dutch' | 'last_chance'): PriceField[] {
  const base: PriceField[] = ['msrpCents', 'startingBidCents'];
  if (format === 'last_chance') return [...base, 'flatPriceCents'];
  if (format === 'dutch') return [...base, 'dutchStartCents', 'dutchFloorCents', 'dutchDeclinePerMinuteCents'];
  return base;
}

export type LotEditPolicy = {
  pricesLocked: boolean;
  /** Plain-English reason prices are locked, or null when they aren't. */
  lockReason: string | null;
};

export function lotEditPolicy(lot: { status: string; bidCount: number }): LotEditPolicy {
  if (lot.bidCount > 0) {
    return { pricesLocked: true, lockReason: 'the lot has bids' };
  }
  if (!(PRICE_EDITABLE_STATUSES as readonly string[]).includes(lot.status)) {
    const reason =
      lot.status === 'live'
        ? 'the lot is live'
        : lot.status === 'won'
          ? 'the lot has sold'
          : `the lot is ${lot.status.replace(/_/g, ' ')}`;
    return { pricesLocked: true, lockReason: reason };
  }
  return { pricesLocked: false, lockReason: null };
}

/** "MSRP and Starting bid", "MSRP, Starting bid and Flat price". */
export function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
