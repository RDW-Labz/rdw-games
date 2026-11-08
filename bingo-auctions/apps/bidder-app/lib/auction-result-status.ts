// Where an auction card goes, and what a lot's result chip says.
//
// 2026-10-14: the Crandall Sale page sent every auction card to the Results
// screen (built for CLOSED auctions), and that screen called a lot "Sold"
// whenever winner_bidder_id was set. With pre-bidding on, winner_bidder_id is
// the current high bidder, so 33 scheduled Crandall lots read "Sold" the day
// before bidding opened. An auction that hasn't closed opens the normal lot
// list (home tab filtered to the auction); only a lot whose status is 'won'
// is Sold.

export type AuctionCardRoute =
  | string
  | { pathname: '/'; params: { auction_id: string } };

export function auctionCardRoute(auction: { id: string; status: string }): AuctionCardRoute {
  if (auction.status === 'closed') return `/auction/${auction.id}`;
  return { pathname: '/', params: { auction_id: auction.id } };
}

export type LotResultLabel = 'Sold' | 'Unsold' | 'Open';

export function lotResultLabel(lot: { status: string }): LotResultLabel {
  if (lot.status === 'won') return 'Sold';
  if (lot.status === 'scheduled' || lot.status === 'live') return 'Open';
  return 'Unsold';
}

export function isLotSold(lot: { status: string }): boolean {
  return lot.status === 'won';
}
