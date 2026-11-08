// Bidder directory search (console /bidders).
//
// 2026-10-14 (Jared): staff need to find a customer from their bidder number
// (paddle / pickup pass). "#2157" matches only bidder #2157. A bare number
// "2157" matches bidder #2157 exactly AND keeps the old substring match on
// name / email / phone / referral code (people search phones by digits), with
// the exact bidder-number match listed first.

export type BidderSearchFields = {
  bidder_number?: number | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  referral_code: string | null;
};

export type BidderSearch = {
  /** Exact bidder number asked for, or null when the query isn't a number. */
  number: number | null;
  /** True for "#N": match the bidder number only. */
  numberOnly: boolean;
  needle: string;
};

export function parseBidderSearch(q: string): BidderSearch {
  const needle = q.trim().toLowerCase();
  const m = /^(#?)\s*(\d{1,9})$/.exec(needle);
  if (!m) return { number: null, numberOnly: false, needle };
  return { number: Number(m[2]), numberOnly: m[1] === '#', needle: m[2] ?? needle };
}

export function isExactBidderNumber(row: BidderSearchFields, s: BidderSearch): boolean {
  return s.number !== null && row.bidder_number != null && row.bidder_number === s.number;
}

export function matchesBidderSearch(row: BidderSearchFields, s: BidderSearch): boolean {
  if (!s.needle) return true;
  if (isExactBidderNumber(row, s)) return true;
  if (s.numberOnly) return false;
  return [row.display_name, row.email, row.phone, row.referral_code]
    .filter(Boolean)
    .some((v) => (v as string).toLowerCase().includes(s.needle));
}
