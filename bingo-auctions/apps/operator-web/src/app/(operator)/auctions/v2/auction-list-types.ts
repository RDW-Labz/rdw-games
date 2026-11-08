export type AuctionListV2Row = {
  id: string;
  title: string;
  status: string;
  startsAtLabel: string;
  firstCloseLabel: string;
  lastCloseLabel: string;
  lotCount: number;
  warehouseName: string;
  offSite: boolean;
  /** First three of auctions.featured_image_urls — the same field the v1 list's thumb strip reads. */
  featuredImageUrls: string[];
  /** "15.0%" — buyer_premium_bps formatted exactly as the v1 Premium column. */
  premiumLabel: string;
};

export type AuctionsV2Props = {
  rows: AuctionListV2Row[];
};
