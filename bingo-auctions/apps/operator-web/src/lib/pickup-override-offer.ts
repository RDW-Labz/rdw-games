// Which invoice lines the Manual pickup override panel offers.
//
// Until 2026-10-19 the panel offered only lines still OWED. A forfeited line
// is not owed, so an item the customer really took home but that the no-show
// sweep had already forfeited (GRA4123327, $2,825, forfeited Oct 17 18:00)
// could not be stamped from the console — and with no stamp the relist block
// (mig 0356) cannot see it, so it sat in the builder's carryover tabs.
//
// A forfeited line is offered only when its lot was NEVER RESOLD: the lot is
// still 'unsold' and has no relist child at all (a canceled child counts as
// resold here — a person decided something about that box, so leave it). A
// forfeited item already sold to someone else must never be marked handed to
// the first buyer; that is why the owed-only rule existed.

export type OverrideOffer = 'owed' | 'forfeited_not_resold' | null;

export function pickupOverrideOffer(line: {
  /** lineState(...).owed on the invoice page */
  owed: boolean;
  /** lineState(...).kind on the invoice page */
  kind: string;
  invoicePaid: boolean;
  lotStatus: string | null;
  /** any non-deleted lot with relisted_from_lot_id = this lot */
  hasRelistChild: boolean;
}): OverrideOffer {
  if (line.owed) return 'owed';
  if (
    line.kind === 'forfeited' &&
    line.invoicePaid &&
    line.lotStatus === 'unsold' &&
    !line.hasRelistChild
  ) {
    return 'forfeited_not_resold';
  }
  return null;
}
